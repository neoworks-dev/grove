// The plugin of the sample extension: it adds a greeting to the status bar. It is built into
// `dist/hello.js` by `scripts/buildExtension.mjs`, and `@grove/extension` is provided by the app.

import { defineSettings, definePlugin, setting } from "@grove/extension";
import type { Context } from "@neoworks/extension-system";
import Greeting from "./Greeting.svelte";

const helloSettings = defineSettings({
  greeting: setting.string({
    label: "Greeting",
    description: "The text the status bar shows.",
    default: "Hello from an extension",
  }),
  uppercase: setting.boolean({
    label: "Shout",
    description: "Show the greeting in capital letters.",
    default: false,
  }),
  tone: setting.enum({
    label: "Colour",
    description: "Which of the theme's colours the greeting is drawn in.",
    default: "accent",
    options: [
      { value: "accent", label: "Accent" },
      { value: "green", label: "Green" },
      { value: "muted", label: "Muted" },
    ],
  }),
});

definePlugin({
  Config: helloSettings,
  inject: ["slots"],
  apply(ctx: Context, config: { greeting: string; uppercase: boolean; tone: string }) {
    let text = config.greeting;
    if (config.uppercase) {
      text = text.toUpperCase();
    }
    ctx.slots.register("statusbar", { id: "hello.greeting", order: 50, component: Greeting, props: { text, tone: config.tone } });
  },
});
