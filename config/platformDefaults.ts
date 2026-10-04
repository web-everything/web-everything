/**
 * WE **platform-flavor default declarations** (Layer 1) for each config dimension (#1702, ratifying
 * #1662; carved #1780) — the *native-first / most-permissive* default-flavor **id** a project extends,
 * declared as **data only**. This file is **contract only**: it names which flavor is the platform
 * default per dimension and the local-override shape; it does **NOT** construct any registry or import
 * any flavor factory, so WE consumes **zero** standard impl (#1282) and **no** auto-define registry
 * (the #1780 carve / #1779 prereq). The resolver factories that turn these ids into real registries /
 * resolved values live in **FUI** (`@webeverything/config` is consumed by that impl).
 *
 * See `docs/agent/platform-decisions.md#config-extends-platform-default`.
 *
 * @module config
 */
import type { AutoDefineFlavorName, CrossProviderFallbackPolicy } from './defineConfig';

/**
 * Platform default flavor id for `autoDefine`: **`strict-explicit`** — the native baseline (explicit
 * registration only, no inference), per `native-first`. A project extends this and/or overrides it. The
 * FUI resolver impl maps this id to the real `CustomAutoDefineRegistry` flavor factory.
 */
export const PLATFORM_AUTO_DEFINE_FLAVOR: AutoDefineFlavorName = 'strict-explicit';

/**
 * Optional local overrides a project may pass to the autoDefine descriptor's `overrides`. Only the
 * default-key is overridable per-scope (the registry resolves a *named* default from its chain). This is
 * the contract shape; the FUI resolver applies it (`setDefault`) as the absolute nearest-wins top.
 */
export interface AutoDefineOverrides {
  /** Force this strategy key as the resolved registry's default (the absolute nearest-wins top). */
  defaultKey?: string;
}

/**
 * Platform-default *values* for the other dimensions, declared at the data level (no registry
 * construction). The most-permissive / native-first default is named per dimension; the owning slice's
 * FUI resolver maps the id to its real flavor factory when built.
 */
export const PLATFORM_FLAVOR_DEFAULTS = {
  /** Theme tokens (#404 / theme): most-permissive = the base/native token set, fully overridable. */
  theme: 'base-tokens',
  /** Render strategy (#080): native-first = the eager/synchronous JSX render baseline. */
  renderStrategy: 'eager-sync',
  /** Codegen source-of-truth mode (#798): most-flexible = author-in-standard-form (no lowering). */
  codegenSoT: 'standard-form',
  /** List virtualization (#2523): native-first = `content-visibility` (every row stays a real DOM node, so
   *  selection / count / find / focus behave as if the whole list were present, #2513). The `js-windowing`
   *  strategy is the opt-in for tens-of-thousands lists. */
  windowedCollection: 'content-visibility',
  /** Cross-provider seat fallback (xb1e9nj): wait for the provider seat for a bounded time, then park for a
   *  human. `same-provider-other-model` is an explicit opt-in and is never the default. */
  crossProviderFallback: 'wait-then-park' satisfies CrossProviderFallbackPolicy,
} as const;

/** Default `waitTimeoutMs` for `wait-then-park` (xb1e9nj): 24 hours, the bound the decision named as the example. */
export const PLATFORM_CROSS_PROVIDER_FALLBACK_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
