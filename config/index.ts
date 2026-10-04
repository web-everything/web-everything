/**
 * `webeverything.config` **contract** (#1702, ratifying #1662; carved #1780) — the WE-resident half:
 * the author surface + schema + guards, the per-dimension resolver **interface**, and the native-first
 * default **declarations**. The resolver **runtime** (`resolveDimension`/`resolveConfig`) and the
 * flavor **factories** (`autoDefineResolver`/`createScalarFlavorResolver`) are standard impl and live in
 * **FUI** (the impl of this contract), per #1282. Published to FUI as `@webeverything/config`.
 *
 * Public contract barrel. See `docs/agent/platform-decisions.md#config-extends-platform-default`.
 *
 * @module config
 */
export {
  defineConfig,
  extendsFlavor,
  isExtendsFlavorDescriptor,
  isDimensionPointer,
  InvalidConfigEntryError,
  type WebEverythingConfig,
  type DimensionEntry,
  type DimensionPointer,
  type ExtendsFlavorDescriptor,
  type ThemeFlavorName,
  type AutoDefineFlavorName,
  type RenderStrategyFlavorName,
  type CodegenSoTFlavorName,
  type WindowedCollectionFlavorName,
  type CrossProviderFallbackPolicy,
  type CrossProviderFallbackFlavorName,
  type CrossProviderFallbackValue,
} from './defineConfig';

export { type DimensionResolver } from './resolverContract';

export {
  PLATFORM_AUTO_DEFINE_FLAVOR,
  PLATFORM_FLAVOR_DEFAULTS,
  PLATFORM_CROSS_PROVIDER_FALLBACK_WAIT_TIMEOUT_MS,
  type AutoDefineOverrides,
} from './platformDefaults';
