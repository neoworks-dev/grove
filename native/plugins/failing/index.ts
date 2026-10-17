// A plugin that always fails to load. It stands in for a broken plugin, so a profile row can
// show that one failure is reported in the UI and the log without taking the rest down.

export const failing = {
  name: "failing",
  apply() {
    throw new Error("this plugin always fails, to show how a failure looks");
  },
};
