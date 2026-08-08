/**
 * Regenerates every packaging icon from the single source artwork at
 * `resources/grove-icon.png`.
 *
 * Outputs:
 *   build/icons/<size>.png  hicolor set  — Linux targets (AppImage, snap, deb)
 *   build/icon.png          512x512 PNG  — electron-builder's single-file fallback
 *   build/icon.ico          multi-size   — Windows / NSIS
 *   build/icon.icns         multi-size   — macOS
 *
 * electron-builder resolves icons by probing `build/` for well-known names. For
 * Linux it checks the `icons` directory before `icon.png`, so shipping the
 * directory is what gets every freedesktop hicolor size installed rather than a
 * lone 512x512 that desktop environments then downscale themselves.
 *
 * The runtime BrowserWindow icon reads `resources/grove-icon.png` directly, so
 * it needs no generated variant.
 *
 * Requires ImageMagick (`magick`) on PATH. Run with `npm run icons`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = join(repositoryRoot, 'resources', 'grove-icon.png')
const buildDirectory = join(repositoryRoot, 'build')

// Freedesktop hicolor sizes installed under /usr/share/icons/hicolor/<n>x<n>/apps.
const linuxIconSizes = [16, 24, 32, 48, 64, 128, 256, 512]

// OSType -> pixel dimension. Covers the 1x (icp*/ic07-ic10) and retina
// (ic11-ic14) slots macOS looks up. All of these accept PNG payloads.
const icnsVariants: Array<[string, number]> = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512]
]

function assertSourceExists(): void {
  if (existsSync(sourcePath)) return
  console.error(`missing source artwork: ${sourcePath}`)
  process.exit(1)
}

/** Scales the source artwork to `size`x`size` and writes it to `destination`. */
function renderPng(size: number, destination: string): void {
  execFileSync('magick', [
    sourcePath,
    '-filter',
    'Lanczos',
    '-resize',
    `${size}x${size}`,
    '-strip',
    destination
  ])
}

/**
 * Writes the per-size Linux icon set. electron-builder's directory collector
 * matches `<size>.png` and `<size>x<size>.png`, so the flat numeric names are
 * enough for it to map each file onto its hicolor bucket.
 */
function writeLinuxIconSet(): void {
  const destination = join(buildDirectory, 'icons')
  mkdirSync(destination, { recursive: true })

  for (const size of linuxIconSizes) {
    renderPng(size, join(destination, `${size}.png`))
  }
  console.log(`wrote ${destination} (${linuxIconSizes.join(', ')})`)
}

function writeFallbackPng(): void {
  const destination = join(buildDirectory, 'icon.png')
  renderPng(512, destination)
  console.log(`wrote ${destination}`)
}

function writeWindowsIco(): void {
  const destination = join(buildDirectory, 'icon.ico')
  execFileSync('magick', [
    sourcePath,
    '-filter',
    'Lanczos',
    '-define',
    'icon:auto-resize=256,128,64,48,32,16',
    destination
  ])
  console.log(`wrote ${destination}`)
}

/**
 * Builds the macOS icon container by hand. ImageMagick's ICNS coder is
 * read-only in most builds — asking it to write .icns silently produces a bare
 * PNG that macOS rejects. The format itself is simple: an `icns` magic plus
 * total byte length, then one `<4-byte OSType><4-byte length><PNG>` chunk per
 * variant.
 */
function writeMacIcns(): void {
  const destination = join(buildDirectory, 'icon.icns')
  const workDirectory = mkdtempSync(join(tmpdir(), 'grove-icns-'))
  const renderedBySize = new Map<number, Buffer>()
  const chunks: Buffer[] = []

  for (const [osType, size] of icnsVariants) {
    let png = renderedBySize.get(size)
    if (!png) {
      const variantPath = join(workDirectory, `${size}.png`)
      renderPng(size, variantPath)
      png = readFileSync(variantPath)
      renderedBySize.set(size, png)
    }

    const chunkHeader = Buffer.alloc(8)
    chunkHeader.write(osType, 0, 'ascii')
    chunkHeader.writeUInt32BE(png.length + 8, 4)
    chunks.push(chunkHeader, png)
  }

  const body = Buffer.concat(chunks)
  const fileHeader = Buffer.alloc(8)
  fileHeader.write('icns', 0, 'ascii')
  fileHeader.writeUInt32BE(body.length + 8, 4)

  writeFileSync(destination, Buffer.concat([fileHeader, body]))
  rmSync(workDirectory, { recursive: true, force: true })
  console.log(`wrote ${destination} (${icnsVariants.length} variants)`)
}

assertSourceExists()
writeLinuxIconSet()
writeFallbackPng()
writeWindowsIco()
writeMacIcns()
