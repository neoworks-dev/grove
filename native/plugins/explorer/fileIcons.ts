// The icons of the explorer's tree, as icon sets: plain data that says which icon a file or folder
// gets from its extension or its well-known name. A set is a list of entries and a default for files
// and folders, so another set (a different look, a different palette) is one more `IconSet` in
// `ICON_SETS`, with no change to the explorer. The default set is the Material Icon Theme (many
// coloured pictures, in `materialIcons.ts`); the other is plain Phosphor shapes, which take the
// tree's own text colour.

import { MATERIAL } from "./materialIcons";
import brackets from "@phosphor-icons/core/regular/brackets-curly.svg";
import bookOpen from "@phosphor-icons/core/regular/book-open.svg";
import cube from "@phosphor-icons/core/regular/cube.svg";
import database from "@phosphor-icons/core/regular/database.svg";
import file from "@phosphor-icons/core/regular/file.svg";
import fileArchive from "@phosphor-icons/core/regular/file-archive.svg";
import fileAudio from "@phosphor-icons/core/regular/file-audio.svg";
import fileC from "@phosphor-icons/core/regular/file-c.svg";
import fileCpp from "@phosphor-icons/core/regular/file-cpp.svg";
import fileCSharp from "@phosphor-icons/core/regular/file-c-sharp.svg";
import fileCode from "@phosphor-icons/core/regular/file-code.svg";
import fileCss from "@phosphor-icons/core/regular/file-css.svg";
import fileCsv from "@phosphor-icons/core/regular/file-csv.svg";
import fileHtml from "@phosphor-icons/core/regular/file-html.svg";
import fileImage from "@phosphor-icons/core/regular/file-image.svg";
import fileIni from "@phosphor-icons/core/regular/file-ini.svg";
import fileJs from "@phosphor-icons/core/regular/file-js.svg";
import fileJsx from "@phosphor-icons/core/regular/file-jsx.svg";
import fileLock from "@phosphor-icons/core/regular/file-lock.svg";
import fileMd from "@phosphor-icons/core/regular/file-md.svg";
import filePdf from "@phosphor-icons/core/regular/file-pdf.svg";
import filePy from "@phosphor-icons/core/regular/file-py.svg";
import fileRs from "@phosphor-icons/core/regular/file-rs.svg";
import fileSql from "@phosphor-icons/core/regular/file-sql.svg";
import fileSvg from "@phosphor-icons/core/regular/file-svg.svg";
import fileText from "@phosphor-icons/core/regular/file-text.svg";
import fileTs from "@phosphor-icons/core/regular/file-ts.svg";
import fileTsx from "@phosphor-icons/core/regular/file-tsx.svg";
import fileVideo from "@phosphor-icons/core/regular/file-video.svg";
import fileVue from "@phosphor-icons/core/regular/file-vue.svg";
import fileZip from "@phosphor-icons/core/regular/file-zip.svg";
import folder from "@phosphor-icons/core/regular/folder.svg";
import folderOpen from "@phosphor-icons/core/regular/folder-open.svg";
import gearSix from "@phosphor-icons/core/regular/gear-six.svg";
import gitBranch from "@phosphor-icons/core/regular/git-branch.svg";
import hammer from "@phosphor-icons/core/regular/hammer.svg";
import key from "@phosphor-icons/core/regular/key.svg";
import listChecks from "@phosphor-icons/core/regular/list-checks.svg";
import packageIcon from "@phosphor-icons/core/regular/package.svg";
import robot from "@phosphor-icons/core/regular/robot.svg";
import scales from "@phosphor-icons/core/regular/scales.svg";
import terminalWindow from "@phosphor-icons/core/regular/terminal-window.svg";

/** One icon: a one-colour glyph, or a picture that keeps its own colours. */
export interface FileIcon {
  /** SVG markup, drawn in `color`, or in the tree's own colour without one. */
  svg?: string;
  /** `#rrggbb` for the glyph. */
  color?: string;
  /** The path of a many-coloured SVG file, relative to the bundle; it is drawn as it is. */
  image?: string;
}

/** A folder's icon closed and open. */
export interface FolderIcons {
  closed: FileIcon;
  open: FileIcon;
}

/** What a set says about one kind of file: the extensions and well-known names that get the icon. */
export interface IconEntry {
  /** Extensions without the dot, in lower case: `ts`. A name such as `test.ts` also matches `ts`. */
  extensions?: string[];
  /** Whole file names in lower case: `package.json`, `.gitignore`. These win over extensions. */
  names?: string[];
  icon: FileIcon;
}

/** Whatever hands out the active icon set; the explorer service does. */
export interface FileIconSource {
  iconSet(): IconSet;
}

/** A set of icons for the explorer's files and folders. */
export interface IconSet {
  /** What the `iconSet` setting stores. */
  id: string;
  /** What the settings page calls it. */
  label: string;
  /** For a file no entry names. */
  file: FileIcon;
  folder: FileIcon;
  folderOpen: FileIcon;
  /** Folders with a look of their own, by name in lower case: `src`, `node_modules`. */
  folderNames: Record<string, FolderIcons>;
  entries: IconEntry[];
}

/** Which Phosphor shape each kind of file gets. */
const ENTRIES: IconEntry[] = [
  { extensions: ["ts", "mts", "cts"], icon: { svg: fileTs } },
  { extensions: ["tsx"], icon: { svg: fileTsx } },
  { extensions: ["js", "mjs", "cjs"], icon: { svg: fileJs } },
  { extensions: ["jsx"], icon: { svg: fileJsx } },
  { extensions: ["json", "jsonc", "json5"], icon: { svg: brackets } },
  { extensions: ["svelte"], icon: { svg: fileCode } },
  { extensions: ["vue"], icon: { svg: fileVue } },
  { extensions: ["rs"], icon: { svg: fileRs } },
  { extensions: ["py", "pyi"], icon: { svg: filePy } },
  { extensions: ["go"], icon: { svg: fileCode } },
  { extensions: ["c", "h"], icon: { svg: fileC } },
  { extensions: ["cpp", "cc", "cxx", "hpp", "hh"], icon: { svg: fileCpp } },
  { extensions: ["cs"], icon: { svg: fileCSharp } },
  { extensions: ["java", "kt", "kts", "swift", "rb", "php", "lua", "zig"], icon: { svg: fileCode } },
  { extensions: ["sh", "bash", "zsh", "fish"], icon: { svg: terminalWindow } },
  { extensions: ["html", "htm"], icon: { svg: fileHtml } },
  { extensions: ["css"], icon: { svg: fileCss } },
  { extensions: ["scss", "sass", "less"], icon: { svg: fileCss } },
  { extensions: ["md", "mdx", "markdown"], icon: { svg: fileMd } },
  { extensions: ["toml"], icon: { svg: fileIni } },
  { extensions: ["yaml", "yml"], icon: { svg: fileCode } },
  { extensions: ["ini", "conf", "cfg"], icon: { svg: fileIni } },
  { extensions: ["lock"], icon: { svg: fileLock } },
  { extensions: ["svg"], icon: { svg: fileSvg } },
  { extensions: ["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif"], icon: { svg: fileImage } },
  { extensions: ["mp4", "mov", "webm", "mkv"], icon: { svg: fileVideo } },
  { extensions: ["mp3", "wav", "ogg", "flac"], icon: { svg: fileAudio } },
  { extensions: ["pdf"], icon: { svg: filePdf } },
  { extensions: ["zip", "tar", "gz", "tgz", "xz", "7z"], icon: { svg: fileZip } },
  { extensions: ["csv", "tsv"], icon: { svg: fileCsv } },
  { extensions: ["sql"], icon: { svg: fileSql } },
  { extensions: ["db", "sqlite"], icon: { svg: database } },
  { extensions: ["txt", "log"], icon: { svg: fileText } },
  { extensions: ["env"], icon: { svg: key } },
  { names: ["package.json"], icon: { svg: packageIcon } },
  { names: ["cargo.toml"], icon: { svg: packageIcon } },
  { names: ["tsconfig.json", "jsconfig.json", "svelte.config.js", "vite.config.ts", "vite.config.js", "build.mjs"], icon: { svg: gearSix } },
  { names: [".editorconfig", ".prettierrc", ".prettierrc.json", ".prettierrc.yaml", ".prettierignore", ".npmrc", ".oxlintrc.json"], icon: { svg: gearSix } },
  { names: [".gitignore", ".gitattributes", ".gitmodules", ".ignore"], icon: { svg: gitBranch } },
  { names: [".env", ".env.local", ".env.example"], icon: { svg: key } },
  { names: ["dockerfile", "docker-compose.yml", "docker-compose.yaml", ".dockerignore"], icon: { svg: cube } },
  { names: ["makefile", "justfile"], icon: { svg: hammer } },
  { names: ["taskfile.yml", "taskfile.yaml"], icon: { svg: listChecks } },
  { names: ["readme", "readme.md"], icon: { svg: bookOpen } },
  { names: ["license", "license.md", "license.txt"], icon: { svg: scales } },
  { names: ["claude.md", "agents.md"], icon: { svg: robot } },
  { names: ["bun.lock", "bun.lockb", "package-lock.json", "cargo.lock", "yarn.lock", "pnpm-lock.yaml"], icon: { svg: fileLock } },
];

/** The plain set: the shapes with no colours of their own, so the tree's text colour (or a git change) shows. */
const MONOCHROME: IconSet = {
  id: "monochrome",
  label: "Monochrome",
  file: { svg: file },
  folder: { svg: folder },
  folderOpen: { svg: folderOpen },
  folderNames: {},
  entries: ENTRIES,
};

/** Every set the `iconSet` setting can pick, the default first. */
export const ICON_SETS: IconSet[] = [MATERIAL, MONOCHROME];

export const DEFAULT_ICON_SET_ID = MATERIAL.id;

/** The set with this id, or the default one when the id names none. */
export function iconSetOf(id: string): IconSet {
  const found = ICON_SETS.find((set) => set.id === id);
  if (found === undefined) {
    return MATERIAL;
  }
  return found;
}

/** The part of a file name after its last dot, in lower case; empty for `Makefile` and for `.gitignore`. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return fileName.slice(dot + 1).toLowerCase();
}

/** The icon a file gets from its whole name first, then from its extension, else the set's file icon. */
export function iconForFile(set: IconSet, fileName: string): FileIcon {
  const lowerName = fileName.toLowerCase();
  const extension = extensionOf(fileName);
  const named = set.entries.find((entry) => entry.names !== undefined && entry.names.includes(lowerName));
  if (named !== undefined) {
    return named.icon;
  }
  if (extension === "") {
    return set.file;
  }
  const typed = set.entries.find((entry) => entry.extensions !== undefined && entry.extensions.includes(extension));
  if (typed === undefined) {
    return set.file;
  }
  return typed.icon;
}

/** The icon of a folder, open or closed: its own when the set names the folder, else the set's folder. */
export function iconForFolder(set: IconSet, folderName: string, expanded: boolean): FileIcon {
  const named = set.folderNames[folderName.toLowerCase()];
  if (named !== undefined) {
    if (expanded) {
      return named.open;
    }
    return named.closed;
  }
  if (expanded) {
    return set.folderOpen;
  }
  return set.folder;
}
