// The sidecar plugin: connects the UI to Grove's main process at boot and provides it as the
// `sidecar` service, with its state in the status bar while it is not running.

import type { Context } from "@neoworks/extension-system";
import { connectSidecar } from "../../sidecar-client";
import { SidecarService } from "./service";
import SidecarStatusItem from "./SidecarStatusItem.svelte";

export const sidecar = {
  name: "sidecar",
  inject: ["slots"],
  apply(ctx: Context) {
    const { client } = connectSidecar();
    const service = new SidecarService(ctx, client);
    ctx.slots.register("statusbar", {
      id: "sidecar.status",
      order: 0,
      component: SidecarStatusItem,
      props: { sidecar: service, align: "right" },
    });
  },
};
