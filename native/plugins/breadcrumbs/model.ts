// What the breadcrumb bar shows, as plain data: the file's path inside the worktree, and the
// scopes the cursor is in.

/** A function, class, module or the like around the cursor, as `document_scopes` reports it. */
export interface Scope {
  /** `function`, `method`, `class`, `interface`, `struct`, `enum`, `trait`, `impl`, `module` or `macro`. */
  kind: string;
  name: string;
  /** Where the scope starts, counted from zero in characters. */
  start: { row: number; column: number };
  end: { row: number; column: number };
  /** The start's column in UTF-16 units, which the editor's `goto` takes. */
  startCharacter: number;
}

/** One step of the file's path: its name and the path from the worktree's root that ends there. */
export interface PathStep {
  name: string;
  relativePath: string;
  isFile: boolean;
}

/**
 * The steps from the worktree's root to a file, or from the filesystem's root when the file is
 * outside the worktree. Empty for a path that is not a file.
 */
export function pathSteps(path: string, worktreeRoot: string | null): PathStep[] {
  if (path === "") {
    return [];
  }
  let relative = path;
  if (worktreeRoot !== null && path.startsWith(`${worktreeRoot}/`)) {
    relative = path.slice(worktreeRoot.length + 1);
  }
  const names = relative.split("/").filter((name) => name.length > 0);
  return names.map((name, index) => ({
    name,
    relativePath: names.slice(0, index + 1).join("/"),
    isFile: index === names.length - 1,
  }));
}

/** The icon file, from Phosphor's regular set, that stands for a kind of scope. */
export function iconNameOf(kind: string): string {
  switch (kind) {
    case "class":
    case "struct":
      return "cube";
    case "interface":
    case "trait":
      return "puzzle-piece";
    case "enum":
      return "list-numbers";
    case "module":
      return "package";
    case "impl":
      return "brackets-curly";
    default:
      return "function";
  }
}
