// The default icon set: the Material Icon Theme's file and folder pictures, vendored in
// `assets/file-icons/material` (version 5.39.0, MIT licence, in the LICENSE file beside them).
// The pictures are many-coloured, so they are drawn as images, not as tinted glyphs. Which
// extensions and file names get which picture is the theme's own mapping for the common types;
// another picture is another entry.

import type { FileIcon, FolderIcons, IconEntry, IconSet } from "./fileIcons";

/** Where the vendored pictures are, relative to the bundle. */
const MATERIAL_DIRECTORY = "assets/file-icons/material";

/** The picture with this file name, without `.svg`. */
function material(pictureName: string): FileIcon {
  return { image: `${MATERIAL_DIRECTORY}/${pictureName}.svg` };
}

/** A folder's pictures: the closed one, and `-open` beside it for the open one. */
function folderPictures(pictureName: string): FolderIcons {
  return { closed: material(pictureName), open: material(`${pictureName}-open`) };
}

/** The pictures for each kind of file. */
const ENTRIES: IconEntry[] = [
  { extensions: ["ts", "mts", "cts"], icon: material("typescript") },
  { extensions: ["tsx"], icon: material("react_ts") },
  { extensions: ["js", "mjs", "cjs"], icon: material("javascript") },
  { extensions: ["jsx"], icon: material("react") },
  { extensions: ["json", "jsonc", "json5"], icon: material("json") },
  { extensions: ["svelte"], names: ["svelte.config.js"], icon: material("svelte") },
  { extensions: ["vue"], icon: material("vue") },
  { extensions: ["rs"], icon: material("rust") },
  { extensions: ["py"], icon: material("python") },
  { extensions: ["go"], icon: material("go") },
  { extensions: ["c"], icon: material("c") },
  { extensions: ["h"], icon: material("h") },
  { extensions: ["cpp"], icon: material("cpp") },
  { extensions: ["hpp"], icon: material("hpp") },
  { extensions: ["cs"], icon: material("csharp") },
  { extensions: ["java"], icon: material("java") },
  { extensions: ["kt"], icon: material("kotlin") },
  { extensions: ["swift"], icon: material("swift") },
  { extensions: ["rb"], icon: material("ruby") },
  { extensions: ["php"], icon: material("php") },
  { extensions: ["lua"], icon: material("lua") },
  { extensions: ["zig"], icon: material("zig") },
  { extensions: ["sh", "bash", "zsh", "fish"], icon: material("console") },
  { extensions: ["html", "htm"], icon: material("html") },
  { extensions: ["css"], icon: material("css") },
  { extensions: ["scss", "sass"], icon: material("sass") },
  { extensions: ["less"], icon: material("less") },
  { extensions: ["md"], icon: material("markdown") },
  { extensions: ["mdx"], icon: material("mdx") },
  { extensions: ["toml"], icon: material("toml") },
  { extensions: ["yaml", "yml"], icon: material("yaml") },
  { extensions: ["ini", "conf"], icon: material("settings") },
  { extensions: ["lock"], icon: material("lock") },
  { extensions: ["svg"], icon: material("svg") },
  { extensions: ["png", "jpg", "jpeg", "gif", "webp", "ico"], icon: material("image") },
  { extensions: ["mp4", "mov", "webm", "ogg"], icon: material("video") },
  { extensions: ["mp3", "wav"], icon: material("audio") },
  { extensions: ["pdf"], icon: material("pdf") },
  { extensions: ["zip", "tar", "gz", "tgz", "7z"], icon: material("zip") },
  { extensions: ["csv"], icon: material("table") },
  { extensions: ["sql", "db", "sqlite"], icon: material("database") },
  { extensions: ["txt"], icon: material("document") },
  { extensions: ["log"], icon: material("log") },
  { extensions: ["env"], names: [".env.local", ".env.example"], icon: material("tune") },
  { extensions: ["xml"], icon: material("xml") },
  { extensions: ["dart"], icon: material("dart") },
  { extensions: ["ex", "exs"], icon: material("elixir") },
  { extensions: ["hs"], icon: material("haskell") },
  { extensions: ["ml"], icon: material("ocaml") },
  { extensions: ["nix"], icon: material("nix") },
  { extensions: ["proto"], icon: material("proto") },
  { extensions: ["graphql", "gql"], icon: material("graphql") },
  { extensions: ["wasm"], icon: material("webassembly") },
  { extensions: ["r"], icon: material("r") },
  { extensions: ["jl"], icon: material("julia") },
  { extensions: ["scala"], icon: material("scala") },
  { extensions: ["vim"], icon: material("vim") },
  { extensions: ["diff"], icon: material("diff") },
  { extensions: ["patch"], names: [".gitignore", ".gitattributes", ".gitmodules"], icon: material("git") },
  { extensions: ["ipynb"], icon: material("jupyter") },
  { extensions: ["tf"], icon: material("terraform") },
  { extensions: ["dockerfile"], names: ["dockerfile", "docker-compose.yml", "docker-compose.yaml"], icon: material("docker") },
  { names: ["package.json", "package-lock.json"], icon: material("nodejs") },
  { names: ["tsconfig.json"], icon: material("tsconfig") },
  { names: ["jsconfig.json"], icon: material("jsconfig") },
  { names: ["makefile"], icon: material("makefile") },
  { names: ["justfile"], icon: material("just") },
  { names: ["taskfile.yml", "taskfile.yaml"], icon: material("taskfile") },
  { names: ["readme.md", "readme"], icon: material("readme") },
  { names: ["license", "license.md", "license.txt"], icon: material("license") },
  { names: ["agents.md"], icon: material("agent") },
  { names: ["bun.lock", "bun.lockb", "bunfig.toml"], icon: material("bun") },
  { names: ["yarn.lock"], icon: material("yarn") },
  { names: ["pnpm-lock.yaml"], icon: material("pnpm") },
  { names: [".editorconfig"], icon: material("editorconfig") },
  { names: [".prettierrc", ".prettierrc.json", ".prettierignore"], icon: material("prettier") },
  { names: [".npmrc"], icon: material("npm") },
  { names: ["vite.config.ts", "vite.config.js"], icon: material("vite") },
  { names: [".oxlintrc.json"], icon: material("oxc") },
  { names: ["eslint.config.js", "eslint.config.mjs", ".eslintrc.json"], icon: material("eslint") },
  { names: ["changelog.md"], icon: material("changelog") },
  { names: ["contributing.md"], icon: material("contributing") },
  { names: ["biome.json"], icon: material("biome") },
];

/** The pictures for folders the theme knows by name, by the picture's name. */
const FOLDER_PICTURES: Record<string, string> = {
  "src": "folder-src",
  "node_modules": "folder-node",
  ".git": "folder-git",
  ".github": "folder-github",
  ".vscode": "folder-vscode",
  ".claude": "folder-claude",
  "tests": "folder-test",
  "test": "folder-test",
  "__tests__": "folder-test",
  "scripts": "folder-scripts",
  "docs": "folder-docs",
  "dist": "folder-dist",
  "build": "folder-dist",
  "target": "folder-target",
  "assets": "folder-resource",
  "resources": "folder-resource",
  "plugins": "folder-plugin",
  "public": "folder-public",
  "lib": "folder-lib",
  "config": "folder-config",
  "components": "folder-components",
  "utils": "folder-utils",
  "hooks": "folder-hook",
  "types": "folder-typescript",
  "tools": "folder-tools",
  "temp": "folder-temp",
  "tmp": "folder-temp",
  "coverage": "folder-coverage",
  "bin": "folder-dist",
  "images": "folder-images",
  "fonts": "folder-font",
  "styles": "folder-css",
  "themes": "folder-theme",
  "api": "folder-api",
  "app": "folder-app",
  "core": "folder-core",
  "shared": "folder-shared",
  "packages": "folder-packages",
  "examples": "folder-examples",
};

/** Each named folder with its closed and open picture. */
function namedFolders(): Record<string, FolderIcons> {
  const folders: Record<string, FolderIcons> = {};
  for (const [folderName, pictureName] of Object.entries(FOLDER_PICTURES)) {
    folders[folderName] = folderPictures(pictureName);
  }
  return folders;
}

export const MATERIAL: IconSet = {
  id: "material",
  label: "Material",
  file: material("file"),
  folder: material("folder"),
  folderOpen: material("folder-open"),
  folderNames: namedFolders(),
  entries: ENTRIES,
};
