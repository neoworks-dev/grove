// The library must be imported before anything that pulls in Svelte's client
// runtime: it installs the DOM globals that runtime reads at module scope.
import { start } from "@neoworks/svelte-gpui";
import { bootKernel } from "../kernel/boot";
import { hostProfileFiles } from "../kernel/hostFiles";
import Root from "../kernel/Root.svelte";
import { corePlugins } from "../plugins";
import coreRows from "../profile/core.json";

// The window opens at once and fills in as the kernel boots and the plugins activate.
const boot = bootKernel({ catalog: corePlugins, coreRows, files: hostProfileFiles });

start(Root, { boot }, { window: { title: "Grove", width: 1100, height: 760 } });
