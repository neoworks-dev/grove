// The three.js scene behind the model viewer: one canvas, one model, orbit
// controls around it. Renders only when something moves — the camera, a
// resize, an animation — so a model left open in a tab costs nothing idle.

import {
  AnimationMixer,
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Points,
  PointsMaterial,
  Scene,
  Texture,
  Vector3,
  WebGLRenderer
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js'
import type { AnimationClip } from 'three'

/** What the toolbar says about a loaded model. */
export interface ModelStats {
  vertices: number
  triangles: number
  animated: boolean
}

/** Theme colours the stage draws its own furniture in. */
export interface StageColors {
  grid: string
  gridCenter: string
  surface: string
}

interface LoadedModel {
  root: Object3D
  animations: AnimationClip[]
}

// How much room the framed model leaves around itself.
const FRAME_PADDING = 1.4

export class ModelStage {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(45, 1, 0.01, 1000)
  private readonly controls: OrbitControls
  private readonly environment: Texture
  private model: Object3D | null = null
  private grid: GridHelper | null = null
  private wireframe = false
  private framedCenter = new Vector3()
  private framedDistance = 1
  // Bumped per load, so a slow load finishing after a newer one is dropped.
  private loadGeneration = 0

  constructor(
    canvas: HTMLCanvasElement,
    private readonly colors: StageColors
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(window.devicePixelRatio || 1)
    this.renderer.setClearColor(0x000000, 0)

    const pmrem = new PMREMGenerator(this.renderer)
    this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    this.scene.environment = this.environment

    // Environment light only reaches physically based materials; OBJ and FBX
    // bring Phong and Lambert ones, which need lights of their own.
    this.scene.add(new HemisphereLight(0xffffff, 0x444444, 0.6))
    const keyLight = new DirectionalLight(0xffffff, 0.9)
    keyLight.position.set(1, 2, 3)
    this.camera.add(keyLight)
    this.scene.add(this.camera)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.addEventListener('change', () => this.render())
  }

  /**
   * Loads the model at `url`, replacing the current one, and frames it unless
   * `keepView`. Resolves to null when a newer load overtook this one.
   */
  async load(url: string, extension: string, keepView: boolean): Promise<ModelStats | null> {
    this.loadGeneration += 1
    const generation = this.loadGeneration
    const loaded = await loadModel(url, extension, this.colors.surface)
    if (generation !== this.loadGeneration) {
      disposeTree(loaded.root)
      return null
    }
    this.clearModel()
    this.model = loaded.root
    this.scene.add(loaded.root)
    this.applyWireframe()
    this.placeGrid()
    if (!keepView) this.frame()
    this.startAnimations(loaded.animations)
    this.render()
    return {
      ...countGeometry(loaded.root),
      animated: loaded.animations.length > 0
    }
  }

  /** Matches the drawing buffer and camera to the canvas's CSS size. */
  resize(width: number, height: number): void {
    if (width === 0 || height === 0) return
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.render()
  }

  /** Puts the camera back where the model was first framed from. */
  resetView(): void {
    this.frame()
    this.render()
  }

  /** Draws every mesh as its edges, or back as surfaces. */
  setWireframe(enabled: boolean): void {
    this.wireframe = enabled
    this.applyWireframe()
    this.render()
  }

  /** Frees the GPU side: geometry, materials, textures, the context itself. */
  dispose(): void {
    this.renderer.setAnimationLoop(null)
    this.clearModel()
    this.controls.dispose()
    this.environment.dispose()
    this.renderer.dispose()
  }

  /** Draws one frame. */
  private render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  /** Points the camera at the model's bounding box from a three-quarter view. */
  private frame(): void {
    if (!this.model) return
    const box = new Box3().setFromObject(this.model)
    if (box.isEmpty()) return
    const size = box.getSize(new Vector3())
    const center = box.getCenter(new Vector3())
    const radius = Math.max(size.x, size.y, size.z) / 2
    const halfFov = (this.camera.fov * Math.PI) / 360
    const distance = (radius / Math.tan(halfFov)) * FRAME_PADDING

    this.framedCenter = center
    this.framedDistance = distance
    const direction = new Vector3(1, 0.7, 1.2).normalize()
    this.camera.position.copy(center).addScaledVector(direction, distance)
    this.camera.near = distance / 1000
    this.camera.far = distance * 100
    this.camera.updateProjectionMatrix()
    this.controls.target.copy(this.framedCenter)
    this.controls.maxDistance = this.framedDistance * 20
    this.controls.update()
  }

  /** Lays a grid under the model, sized to it. */
  private placeGrid(): void {
    if (this.grid) {
      this.scene.remove(this.grid)
      this.grid.dispose()
      this.grid = null
    }
    if (!this.model) return
    const box = new Box3().setFromObject(this.model)
    if (box.isEmpty()) return
    const size = box.getSize(new Vector3())
    const span = Math.max(size.x, size.z) * 3
    const grid = new GridHelper(span, 20, this.colors.gridCenter, this.colors.grid)
    const center = box.getCenter(new Vector3())
    grid.position.set(center.x, box.min.y, center.z)
    this.grid = grid
    this.scene.add(grid)
  }

  /** Plays every clip the model brought, looping, and keeps rendering while it does. */
  private startAnimations(clips: AnimationClip[]): void {
    this.renderer.setAnimationLoop(null)
    if (!this.model || clips.length === 0) return
    const mixer = new AnimationMixer(this.model)
    for (const clip of clips) mixer.clipAction(clip).play()
    let previousTime: number | null = null
    this.renderer.setAnimationLoop((time) => {
      if (previousTime !== null) mixer.update((time - previousTime) / 1000)
      previousTime = time
      this.render()
    })
  }

  /** Applies the wireframe setting to every material of the current model. */
  private applyWireframe(): void {
    if (!this.model) return
    this.model.traverse((node) => {
      for (const material of materialsOf(node)) {
        if ('wireframe' in material) material.wireframe = this.wireframe
      }
    })
  }

  /** Takes the current model out of the scene and frees it. */
  private clearModel(): void {
    if (!this.model) return
    this.scene.remove(this.model)
    disposeTree(this.model)
    this.model = null
  }
}

/** Reads the model with the loader its extension calls for. */
async function loadModel(url: string, extension: string, surface: string): Promise<LoadedModel> {
  if (extension === 'gltf' || extension === 'glb') {
    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)
    const gltf = await loader.loadAsync(url)
    return { root: gltf.scene, animations: gltf.animations }
  }
  if (extension === 'stl') {
    const geometry = await new STLLoader().loadAsync(url)
    // Many exporters write every facet normal as 0 0 0. STL is unindexed, so
    // recomputing gives the true flat normals whatever the file said.
    geometry.computeVertexNormals()
    return { root: meshFor(geometry, surface), animations: [] }
  }
  if (extension === 'ply') {
    const geometry = await new PLYLoader().loadAsync(url)
    return { root: plyObject(geometry, surface), animations: [] }
  }
  if (extension === 'obj') {
    const group = await new OBJLoader().loadAsync(url)
    // Materials live in a separate .mtl this doesn't read, so every mesh would
    // come back plain white Phong; shade them like an STL instead.
    group.traverse((node) => {
      if (node instanceof Mesh) node.material = neutralMaterial(surface, false)
    })
    return { root: group, animations: [] }
  }
  if (extension === 'fbx') {
    const group = await new FBXLoader().loadAsync(url)
    return { root: group, animations: group.animations }
  }
  if (extension === '3mf') {
    const group: Group = await new ThreeMFLoader().loadAsync(url)
    return { root: group, animations: [] }
  }
  throw new Error(`no loader for .${extension}`)
}

/** A bare geometry (STL, PLY) as a mesh in a neutral material, or its own vertex colours. */
function meshFor(geometry: BufferGeometry, surface: string): Mesh {
  if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals()
  return new Mesh(geometry, neutralMaterial(surface, geometry.hasAttribute('color')))
}

/** The material a model without its own is shaded in. */
function neutralMaterial(surface: string, vertexColors: boolean): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: new Color(surface),
    roughness: 0.55,
    metalness: 0.1,
    vertexColors
  })
}

/** A PLY is a mesh when it has faces, and a point cloud when it only has vertices. */
function plyObject(geometry: BufferGeometry, surface: string): Object3D {
  if (geometry.index !== null) return meshFor(geometry, surface)
  geometry.computeBoundingSphere()
  let radius = 1
  if (geometry.boundingSphere !== null) radius = geometry.boundingSphere.radius
  const material = new PointsMaterial({
    // Point size is in world units; a fixed one is dust on a building scan
    // and boulders on a figurine.
    size: radius / 300,
    sizeAttenuation: true,
    color: new Color(surface),
    vertexColors: geometry.hasAttribute('color')
  })
  return new Points(geometry, material)
}

/** Vertex and triangle totals across every mesh in the tree. */
function countGeometry(root: Object3D): { vertices: number; triangles: number } {
  let vertices = 0
  let triangles = 0
  root.traverse((node) => {
    if (!(node instanceof Mesh) && !(node instanceof Points)) return
    const geometry = node.geometry as BufferGeometry
    const position = geometry.getAttribute('position')
    if (!position) return
    vertices += position.count
    if (!(node instanceof Mesh)) return
    if (geometry.index !== null) {
      triangles += geometry.index.count / 3
      return
    }
    triangles += position.count / 3
  })
  return { vertices, triangles: Math.round(triangles) }
}

/** A node's material or materials, as a list. */
function materialsOf(node: Object3D): Material[] {
  if (!(node instanceof Mesh) && !(node instanceof Points)) return []
  const material = node.material as Material | Material[]
  if (Array.isArray(material)) return material
  return [material]
}

/** Disposes every geometry, material and texture under `root`. */
function disposeTree(root: Object3D): void {
  root.traverse((node) => {
    if (node instanceof Mesh || node instanceof Points) {
      const geometry = node.geometry as BufferGeometry
      geometry.dispose()
    }
    for (const material of materialsOf(node)) {
      disposeTextures(material)
      material.dispose()
    }
  })
}

/** Disposes the textures a material holds in any of its slots. */
function disposeTextures(material: Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof Texture) value.dispose()
  }
}
