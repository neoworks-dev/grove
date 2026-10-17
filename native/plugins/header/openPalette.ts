import type { Kernel } from "../../kernel/kernel";

/** Opens the command palette, or the file finder when the palette is not loaded. */
export function openPalette(kernel: Kernel): void {
  for (const commandId of ["palette.open", "files.find"]) {
    if (kernel.commands.canRun(commandId)) {
      void kernel.commands.run(commandId);
      return;
    }
  }
}
