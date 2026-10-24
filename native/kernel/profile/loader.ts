// The `loader` service mounts a profile's rows as plugins and keeps a report of how each one
// went. A row that fails to load, or names a plugin the bundle does not have, is reported as
// failed and nothing else is affected: the shell stays up and the failure shows in the UI.
// Core plugins are known to the bundle by name, since QuickJS runs one bundle, and the
// profile selects and configures them.

import { FiberState, Service, type Context, type Fiber, type Plugin } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../reactive";
import type { ResolvedRow } from "./rows";

declare module "@neoworks/extension-system" {
  interface Context {
    loader: LoaderService;
  }
}

export type PluginCatalog = Record<string, Plugin>;

export type RowStatus = "disabled" | "loading" | "waiting" | "active" | "failed";

export interface RowReport {
  id: string;
  plugin: string;
  layer: string;
  status: RowStatus;
  /** Why the row failed, or what a waiting row waits for. */
  message?: string;
}

interface MountedRow {
  row: ResolvedRow;
  /** The plugin that was mounted, so a row whose catalog entry was replaced, as when an extension is updated, mounts again. */
  plugin: Plugin;
  /** What `ctx.plugin` returned: awaitable, and the handle for disposing. */
  fiber: Fiber & PromiseLike<Fiber>;
  /** The fiber itself, which is what `internal/status` events carry. */
  base: Fiber;
}

export class LoaderService extends Service {
  private catalog: PluginCatalog;
  private mounted = new Map<string, MountedRow>();
  private reportsById = new Map<string, RowReport>();
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context, catalog: PluginCatalog) {
    super(ctx, "loader");
    this.catalog = catalog;
    ctx.on("internal/status", (fiber) => this.refreshReportOf(fiber));
  }

  /**
   * Makes the mounted plugins match the rows: rows that are gone, disabled or changed are
   * unloaded, and new or changed rows are mounted. Resolves when every mounted row has settled
   * as active, waiting or failed; a failing row never rejects it.
   */
  async apply(rows: ResolvedRow[]): Promise<void> {
    await this.unloadStale(rows);
    const loading: Promise<void>[] = [];
    for (const row of rows) {
      const existing = this.mounted.get(row.id);
      if (row.disabled) {
        this.reportsById.set(row.id, { id: row.id, plugin: row.plugin, layer: row.layer, status: "disabled" });
      } else if (existing) {
        this.reportsById.set(row.id, this.reportFor(existing, statusOf(existing.base.state)));
      } else {
        this.reportsById.set(row.id, { id: row.id, plugin: row.plugin, layer: row.layer, status: "loading" });
        loading.push(this.mount(row));
      }
    }
    this.changes.notify();
    await Promise.all(loading);
  }

  /**
   * Records that a mounted row's config changed in a way its plugin follows on its own, so the
   * next `apply` leaves the plugin mounted. Does nothing for a row that is not mounted.
   */
  retarget(row: ResolvedRow): void {
    const mounted = this.mounted.get(row.id);
    if (!mounted) {
      return;
    }
    mounted.row = row;
  }

  /** Whether the row's plugin is mounted now, so a change to it can be followed live. */
  isMounted(rowId: string): boolean {
    return this.mounted.has(rowId);
  }

  /** How each row of the last `apply` went, in profile order. Reactive. */
  reports(): RowReport[] {
    this.changes.track();
    return [...this.reportsById.values()];
  }

  /** The rows that failed to load. Reactive. */
  failures(): RowReport[] {
    return this.reports().filter((report) => report.status === "failed");
  }

  /** Unloads mounted rows that the new rows no longer ask for, and forgets reports of rows that are gone. */
  private async unloadStale(rows: ResolvedRow[]): Promise<void> {
    const wanted = new Map(rows.map((row) => [row.id, row]));
    const unloading: Promise<void>[] = [];
    for (const [id, mounted] of [...this.mounted]) {
      const next = wanted.get(id);
      if (next && !next.disabled && sameRow(mounted.row, next) && mounted.plugin === this.catalog[next.plugin]) {
        continue;
      }
      this.mounted.delete(id);
      unloading.push(mounted.fiber.dispose());
    }
    await Promise.all(unloading);
    this.reportsById.clear();
  }

  /** Mounts one row's plugin and waits for it to settle. */
  private async mount(row: ResolvedRow): Promise<void> {
    const plugin = this.catalog[row.plugin];
    if (!plugin) {
      this.fail(row, `no core plugin named "${row.plugin}"`);
      return;
    }
    let fiber: Fiber & PromiseLike<Fiber>;
    try {
      fiber = this.ctx.plugin(plugin, row.config);
    } catch (error) {
      this.fail(row, describeError(error));
      return;
    }
    const mounted: MountedRow = { row, plugin, fiber, base: Object.getPrototypeOf(fiber) };
    this.mounted.set(row.id, mounted);
    await this.settle(mounted);
  }

  /** Waits for a fiber to stop loading, then records how it ended up. */
  private async settle(mounted: MountedRow): Promise<void> {
    try {
      await mounted.fiber.await();
    } catch (error) {
      this.setReport(this.reportFor(mounted, "failed", describeError(error)));
      return;
    }
    this.setReport(this.reportFor(mounted, statusOf(mounted.base.state), this.waitingFor(mounted)));
  }

  /** Updates the report of the row a fiber belongs to when the fiber changes state. */
  private refreshReportOf(fiber: Fiber): void {
    for (const mounted of this.mounted.values()) {
      if (mounted.base === fiber) {
        void this.settle(mounted);
      }
    }
  }

  /** What a pending plugin is missing, as text; undefined for any other state. */
  private waitingFor(mounted: MountedRow): string | undefined {
    if (mounted.base.state !== FiberState.PENDING) {
      return undefined;
    }
    return `waiting for ${Object.keys(mounted.base.inject).join(", ")}`;
  }

  private reportFor(mounted: MountedRow, status: RowStatus, message?: string): RowReport {
    const { id, plugin, layer } = mounted.row;
    return { id, plugin, layer, status, message };
  }

  /** Records a row that never got as far as a fiber. */
  private fail(row: ResolvedRow, message: string): void {
    this.ctx.logger.error(`profile row "${row.id}": ${message}`);
    this.setReport({ id: row.id, plugin: row.plugin, layer: row.layer, status: "failed", message });
  }

  private setReport(report: RowReport): void {
    this.reportsById.set(report.id, report);
    this.changes.notify();
  }
}

/** Whether two rows ask for the same plugin with the same config, so the mounted one can stay. */
function sameRow(first: ResolvedRow, second: ResolvedRow): boolean {
  if (first.plugin !== second.plugin) {
    return false;
  }
  return JSON.stringify(first.config) === JSON.stringify(second.config);
}

function statusOf(state: FiberState): RowStatus {
  if (state === FiberState.ACTIVE) {
    return "active";
  }
  if (state === FiberState.FAILED) {
    return "failed";
  }
  if (state === FiberState.PENDING) {
    return "waiting";
  }
  return "loading";
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
