// The build loads SVG files as their markup, for `Icon`.
declare module "*.svg" {
  const markup: string;
  export default markup;
}

// Svelte's compiled-output runtime has no type declarations; extensions are handed it as it is.
declare module "svelte/internal/client";
declare module "svelte/internal/disclose-version";
