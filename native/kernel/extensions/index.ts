export { evaluateExtensionScript, API_MODULE } from "./evaluate";
export type { SharedModules } from "./evaluate";
export { parseManifest, EXTENSION_KEYWORD } from "./manifest";
export type {
  ExtensionManifest,
  GrammarContribution,
  LanguageServerContribution,
  PluginContribution,
  ThemeContribution,
  ToolContribution,
} from "./manifest";
export { parseRecipe, PLATFORMS } from "./recipes";
export type { InstallRecipe, PlatformKey } from "./recipes";
export { ExtensionsService } from "./service";
export type { Contributed, ExtensionsConfig } from "./service";
export { directoryNameOf, extensionsDirectory, readInstalled } from "./store";
export type { ExtensionFiles, InstalledExtension, TarballHashes } from "./store";
export { DEFAULT_REGISTRY, NpmRegistry } from "./registry";
export type { FetchFunction, PackageRelease, RegistryPackage } from "./registry";
export { compareVersions, isNewer, parseVersion } from "./version";
