// What a field needs of the form or control around it.
import { getContext, setContext } from "svelte";
import type { UiNode } from "@suite/protocol/types";

const FORM = Symbol("neoui form");
const CONTROL = Symbol("neoui control");

/** Makes the Form node reachable from the fields drawn below the caller. */
export function provideForm(form: () => UiNode): void {
  setContext(FORM, form);
}

/** The Form around the field, if any: Enter presses its first button. */
export function useForm(): () => UiNode | undefined {
  return getContext<(() => UiNode) | undefined>(FORM) ?? (() => undefined);
}

/** Marks that the fields below are drawn by a FormControl, which shows their label and error. */
export function provideControl(): void {
  setContext(CONTROL, true);
}

/** Whether a FormControl draws the field's label and error. */
export function inControl(): boolean {
  return getContext<boolean | undefined>(CONTROL) === true;
}
