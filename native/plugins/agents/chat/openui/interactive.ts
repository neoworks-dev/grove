// The components that take input or press: forms, fields and buttons. They arrive with the keyboard
// and the actions that go back to the daemon, so the doc draws a muted line in their place for now.

/** The names of the library's interactive components. */
export const INTERACTIVE: ReadonlySet<string> = new Set([
  "Form",
  "FormControl",
  "Input",
  "TextArea",
  "DatePicker",
  "Select",
  "RadioGroup",
  "OptionCards",
  "CheckBox",
  "Switch",
  "CheckBoxGroup",
  "SwitchGroup",
  "Slider",
  "Button",
  "Buttons",
]);
