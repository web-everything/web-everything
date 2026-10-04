/**
 * `webeverything.config` author surface (#1702, ratifying #1662) — the project-facing way a project
 * declares its per-dimension configuration the **config-extends-platform** way.
 *
 * Two forks #1662 ratified, mirrored exactly here:
 *
 *  - **Fork 1 (SoT = per-dimension).** Each dimension (`theme`, `autoDefine`, `renderStrategy`,
 *    `codegenSoT`, …) is its own source of truth: it carries its own value *and* its own ordered
 *    `extends`-to-flavor chain. There is **NO cross-dimension merge, ever** — a unified surface is a
 *    non-authoritative *discovery view* only (see {@link ./resolveDimension resolveConfig}).
 *  - **Fork 2 (author surface).** A project materializes config in ONE root file
 *    `webeverything.config.ts` (`.js`/`.json` conceptually accepted), keyed one-per-dimension. Any
 *    dimension is **extractable** to its own file — the key value becomes a string path *pointer*.
 *    **File-count ≠ schema-coupling** (`most-flexible-default`).
 *
 * Composition semantics (the kernel `CustomAutoDefineRegistry` generalizes): `extends` is an **array**
 * of base flavor ids resolved by **ordered nearest-wins lookup — NOT a destructive deep-merge**. No
 * merged blob is ever materialized; resolution is lazy and lives in {@link ./resolveDimension}.
 *
 * The type system enforces the separation #1662 calls a *compiler invariant*: a dimension's `extends`
 * chain is bound to THAT dimension's flavor-id type, so a theme flavor cannot be placed in autoDefine's
 * `extends`. This is a type, not a convention.
 *
 * See `docs/agent/platform-decisions.md#config-extends-platform-default`.
 *
 * @module config
 */

/**
 * A string pointer to an *extracted* dimension config file (Fork 2's "extract to its own file"). The
 * loader (a follow-on; out of scope for #1702) reads the pointed file and substitutes its default
 * export for this string before the resolver runs. We keep it a nominal-ish branded string only by
 * documentation — at the type level it is a plain path string.
 *
 * @example './config/theme.config.ts'
 */
export type DimensionPointer = string;

/**
 * The per-dimension `extends`-chain descriptor — the value a dimension key holds when it extends one or
 * more platform/project flavors. `flavors` is the **ordered** base list (nearest-wins is applied at
 * resolve time, with `overrides` winning over every base). `Flavor` is the dimension-bound flavor-id
 * type, which is what makes the separation a compiler invariant: an `ExtendsFlavorDescriptor<'theme-…'>`
 * is not assignable where an `ExtendsFlavorDescriptor<AutoDefineFlavorName>` is expected.
 *
 * @typeParam Flavor    the dimension's flavor-id string-union (e.g. `AutoDefineFlavorName`)
 * @typeParam Overrides the shape of the optional local overrides this dimension accepts
 */
export interface ExtendsFlavorDescriptor<Flavor extends string = string, Overrides = unknown> {
  /** Discriminant so the resolver can branch a descriptor apart from a plain value/pointer. */
  readonly kind: 'extends-flavor';
  /** Ordered base flavor ids — index 0 is the *nearest* base after `overrides`; higher index = farther. */
  readonly flavors: readonly Flavor[];
  /** Optional local overrides applied *over* the whole flavor chain (the nearest-wins top). */
  readonly overrides?: Overrides;
}

/**
 * The value a dimension key may hold in `webeverything.config`:
 *  - an {@link ExtendsFlavorDescriptor} (extends one/more flavors, optionally with local overrides),
 *  - a plain inline config value (the project supplies the whole thing itself, no flavor), or
 *  - a {@link DimensionPointer} string (the dimension is extracted to its own file).
 *
 * @typeParam Flavor the dimension's flavor-id union; defaults to `string` for open/unknown dimensions
 * @typeParam Value  the plain inline value type for the dimension
 */
export type DimensionEntry<Flavor extends string = string, Value = unknown> =
  | ExtendsFlavorDescriptor<Flavor, Partial<Value>>
  | Value
  | DimensionPointer;

/**
 * The known dimension flavor-id unions. Open dimensions (not listed) fall back to `string`. These are
 * **type-level only** — the runtime flavor factories live in each dimension's own home, *in FUI* (the
 * resolver impl): autoDefine over `CustomAutoDefineRegistry`; renderStrategy in #080, theme, codegenSoT
 * in #798/owners. The CONTRACT keeps every dimension flavor-id **open (`string`)** so WE holds **zero**
 * standard impl (#1282) and consumes **no** auto-define registry (the #1780 carve / #1779 prereq); the
 * concrete flavor union binds in the FUI resolver impl, not here.
 */
export type ThemeFlavorName = string; // owned by the theme dimension (#404/theme); open at this layer.
export type AutoDefineFlavorName = string; // owned by #227 registry (impl in FUI #1779); open at this layer.
export type RenderStrategyFlavorName = string; // owned by #080 (JSX render-strategy axis).
export type CodegenSoTFlavorName = string; // owned by #798 (codegen source-of-truth mode).
export type WindowedCollectionFlavorName = string; // owned by #2523 (list-virtualization strategy axis).

/**
 * What stands in when the cross-provider review/judge seat cannot sit (decision xb1e9nj, ruled 2026-10-03).
 * `park-now` parks for a human at once; `wait-then-park` (the platform default) waits for the provider's
 * hold to lift up to `waitTimeoutMs`, then parks; `same-provider-other-model` lets a different model from the
 * same provider count as independent (explicit opt-in only, never the default).
 */
export type CrossProviderFallbackPolicy = 'park-now' | 'wait-then-park' | 'same-provider-other-model';
export type CrossProviderFallbackFlavorName = CrossProviderFallbackPolicy;

/** The inline value shape of the `crossProviderFallback` dimension. */
export interface CrossProviderFallbackValue {
  policy: CrossProviderFallbackPolicy;
  /** How long `wait-then-park` waits for the seat before parking for a human, in milliseconds. */
  waitTimeoutMs: number;
}

/**
 * The root author surface. One key per dimension; the four known dimensions are typed to their own
 * flavor-id union (the compiler invariant). The index signature keeps the surface **open** — new
 * dimensions are added without a schema change (`config-extends-platform-default` is open-set).
 */
export interface WebEverythingConfig {
  /** Theme tokens dimension (#404 / theme) — JS-first token injector flavor chain. */
  theme?: DimensionEntry<ThemeFlavorName>;
  /** Auto-define strategy dimension (#227) — the precedent; flavors in `CustomAutoDefineRegistry`. */
  autoDefine?: DimensionEntry<AutoDefineFlavorName>;
  /** JSX render-strategy dimension (#080). */
  renderStrategy?: DimensionEntry<RenderStrategyFlavorName>;
  /** Codegen source-of-truth mode dimension (#798). */
  codegenSoT?: DimensionEntry<CodegenSoTFlavorName>;
  /**
   * List-virtualization strategy dimension (#2523) — how a large scrolling collection renders off-screen rows.
   * Native-first default `content-visibility` (rows stay real DOM nodes; selection / whole-list count / in-page
   * find / keyboard focus behave as if the whole list were present, #2513); the opt-in `js-windowing` strategy
   * renders only the visible slice + a sized spacer for lists in the tens of thousands, re-implementing those
   * behaviors (FUI impl, #1282). The a11y contract it conforms to is the `windowed-collection` intent
   * (`we:src/_data/intents/windowed-collection.json`). Resolved per project via `config-extends-platform-default`.
   */
  windowedCollection?: DimensionEntry<WindowedCollectionFlavorName>;
  /**
   * Cross-provider seat fallback dimension (xb1e9nj) — what stands in when the Codex review seat (and, per
   * xud2hha, the cross-provider judge) cannot sit. Values `park-now` | `wait-then-park` (default) |
   * `same-provider-other-model`, plus the `waitTimeoutMs` parameter. Resolved via `config-extends-platform-default`.
   */
  crossProviderFallback?: DimensionEntry<CrossProviderFallbackFlavorName, CrossProviderFallbackValue>;
  /** Open-set: any further dimension keyed by name. */
  [dimension: string]: DimensionEntry | undefined;
}

/** Thrown when an entry is neither an object (descriptor/inline value) nor a string pointer. */
export class InvalidConfigEntryError extends Error {
  constructor(dimension: string, received: unknown) {
    super(
      `webeverything.config dimension "${dimension}" must be an object (an inline value or an ` +
        `extendsFlavor descriptor) or a string path pointer — received ${typeof received}` +
        (received === null ? ' (null)' : ''),
    );
    this.name = 'InvalidConfigEntryError';
  }
}

/**
 * The author's typed entry point — Vite-`defineConfig`-style identity + light validation. Returns the
 * config unchanged (so editors get full inference) after checking every dimension key holds an object
 * or a string pointer. It deliberately does **not** resolve anything (resolution is lazy, in
 * {@link ./resolveDimension}) and does **not** merge across dimensions (#1662 Fork 1).
 *
 * @throws {InvalidConfigEntryError} when a dimension value is neither object nor string.
 */
export function defineConfig<T extends WebEverythingConfig>(config: T): T {
  if (config === null || typeof config !== 'object') {
    throw new InvalidConfigEntryError('<root>', config);
  }
  for (const [dimension, entry] of Object.entries(config)) {
    if (entry === undefined) continue; // an omitted/optional dimension is fine.
    const isObject = typeof entry === 'object' && entry !== null;
    const isPointer = typeof entry === 'string';
    if (!isObject && !isPointer) {
      throw new InvalidConfigEntryError(dimension, entry);
    }
  }
  return config;
}

/**
 * Build a per-dimension {@link ExtendsFlavorDescriptor}. `flavors` accepts a single flavor id or an
 * ordered array of base ids (nearest-first). The generic binds the descriptor to the dimension's
 * flavor-id type so it is **not** assignable into a different dimension's `extends` slot — the
 * compiler invariant that realizes #1662's per-dimension separation.
 *
 * Nearest-wins order at resolve time: `overrides` (if any) is the absolute top, then `flavors[0]`,
 * `flavors[1]`, … (farther bases). A later base only supplies what no nearer one declared.
 *
 * @typeParam Flavor    the dimension flavor-id union (e.g. `AutoDefineFlavorName`)
 * @typeParam Overrides the dimension's local-override shape
 * @example extendsFlavor('strict-explicit')                    // single base
 * @example extendsFlavor(['lazy-dom', 'strict-explicit'])      // lazy-dom nearer, strict-explicit farther
 * @example extendsFlavor('strict-explicit', { defaultKey: 'lazy-dom' }) // base + local override
 */
export function extendsFlavor<Flavor extends string = string, Overrides = unknown>(
  flavors: Flavor | readonly Flavor[],
  overrides?: Overrides,
): ExtendsFlavorDescriptor<Flavor, Overrides> {
  const list = Array.isArray(flavors) ? (flavors as readonly Flavor[]) : ([flavors] as readonly Flavor[]);
  if (list.length === 0) {
    throw new Error('extendsFlavor requires at least one flavor id');
  }
  return {
    kind: 'extends-flavor',
    flavors: list,
    ...(overrides !== undefined ? { overrides } : {}),
  };
}

/** Type guard: is a dimension entry an {@link ExtendsFlavorDescriptor}? */
export function isExtendsFlavorDescriptor(
  entry: unknown,
): entry is ExtendsFlavorDescriptor {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as { kind?: unknown }).kind === 'extends-flavor' &&
    Array.isArray((entry as { flavors?: unknown }).flavors)
  );
}

/** Type guard: is a dimension entry a string path pointer (the "extracted to its own file" case)? */
export function isDimensionPointer(entry: unknown): entry is DimensionPointer {
  return typeof entry === 'string';
}
