// The `theme` service: the themes plugins have registered and which one is active. Switching
// hands the theme's tokens to `active.ts`, which redraws every component that read a colour.
// A theme can be selected before it is registered, as when the profile names one that another
// plugin supplies; it applies once that plugin loads, and the default draws until then.

import { Service, type Context } from "@neoworks/extension-system";
import { createChangeSignal, type ChangeSignal } from "../../kernel/reactive";
import { setActiveTokens } from "./active";
import { DEFAULT_THEME_ID, NEOWORKS_DARK, NEOWORKS_LIGHT, type ThemeDefinition, type ThemeTokens } from "./palette";

declare module "@neoworks/extension-system" {
  interface Context {
    theme: ThemeService;
  }
}

export class ThemeService extends Service {
  private themeList: ThemeDefinition[] = [];
  private selectedId = DEFAULT_THEME_ID;
  private accentOverride = "";
  private changes: ChangeSignal = createChangeSignal();

  constructor(ctx: Context) {
    super(ctx, "theme");
    // The shell goes back to the dark palette when the theme plugin is unloaded.
    ctx.effect(() => () => setActiveTokens(NEOWORKS_DARK, "dark"), "theme.reset");
  }

  /**
   * Adds a theme, replacing one with the same id. It leaves with the calling plugin, or when the
   * returned function is called.
   */
  registerTheme(theme: ThemeDefinition): () => void {
    return this.ctx.effect(() => {
      this.themeList = [...this.themeList.filter((existing) => existing.id !== theme.id), theme];
      this.refresh();
      return () => {
        this.themeList = this.themeList.filter((existing) => existing !== theme);
        this.refresh();
      };
    }, `theme.registerTheme(${theme.id})`);
  }

  /**
   * Adds a theme that sets only some colours, as an extension's theme does; the others come from
   * Grove's own palette of the same scheme.
   */
  registerPartialTheme(theme: Omit<ThemeDefinition, "tokens"> & { tokens: Partial<ThemeTokens> }): () => void {
    let base = NEOWORKS_DARK;
    if (theme.scheme === "light") {
      base = NEOWORKS_LIGHT;
    }
    return this.registerTheme({ ...theme, tokens: { ...base, ...theme.tokens } });
  }

  /** The registered themes, in registration order. Reactive. */
  themes(): ThemeDefinition[] {
    this.changes.track();
    return [...this.themeList];
  }

  /** Makes the theme with this id the active one. */
  select(themeId: string): void {
    this.selectedId = themeId;
    this.refresh();
  }

  /** Overrides the active theme's accent colour; the empty string goes back to the theme's own. */
  setAccent(color: string): void {
    this.accentOverride = color;
    this.refresh();
  }

  /** The id of the theme in use: the selected one when registered, else the default's. Reactive. */
  activeId(): string {
    return this.activeTheme().id;
  }

  /** The tokens in use, accent override included. Reactive. */
  tokens(): ThemeTokens {
    const theme = this.activeTheme();
    if (this.accentOverride === "") {
      return theme.tokens;
    }
    return { ...theme.tokens, accent: this.accentOverride };
  }

  /** The selected theme if registered, else the default, else the built-in dark one. Reactive. */
  private activeTheme(): ThemeDefinition {
    this.changes.track();
    const selected = this.themeList.find((theme) => theme.id === this.selectedId);
    if (selected) {
      return selected;
    }
    const fallback = this.themeList.find((theme) => theme.id === DEFAULT_THEME_ID);
    if (fallback) {
      return fallback;
    }
    return { id: DEFAULT_THEME_ID, name: "Neoworks (Dark)", scheme: "dark", tokens: NEOWORKS_DARK };
  }

  /** Pushes the tokens in use to the shell and tells readers of the service. */
  private refresh(): void {
    setActiveTokens(this.tokens(), this.activeTheme().scheme);
    this.changes.notify();
  }
}
