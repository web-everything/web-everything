import { configDefaults, defineConfig } from 'vitest/config';
import { maxTestWorkers, weAlias } from './vitest.shared';
import { TRUST_CHAIN_TIER_FILES } from './scripts/lib/trust-chain-tier.mjs';

export default defineConfig({
  // Mirror vite.config.mts so .tsx files (the shared mapping fixtures + conformance suites)
  // compile the JSX mirror dialect through the realigned renderer here exactly as they do in
  // the browser. esbuild only applies these to .tsx/.jsx, so plain .ts tests are unaffected.
  esbuild: {
    jsxFactory: 'jsx.createElement',
    jsxFragment: 'jsx.Fragment',
    jsxInject: `import jsx from '/blocks/renderers/jsx'`,
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    // #x1jcikc: cap this invocation's own worker count (see vitest.shared.ts#maxTestWorkers for the sizing
    // rationale) — otherwise the ~2000-file suite defaults to one thread per CPU core, which is how two
    // concurrently-admitted `test:unit` runs oversubscribe a 12-core host.
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: maxTestWorkers,
        minThreads: 1,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // #2082: the 80% bar governs the unit-tested STANDARDS/IMPL planes, not just blocks/. This mirrors
      // the tested standards planes in `test.include` below — every plane that ships real `*.ts` source
      // behind a unit suite. Deliberately EXCLUDED (own gates, not this rule): demos/ (the exercise apps
      // are forcing-functions, Playwright/conformance-gated), src/ (11ty templates), tools/ + scripts/
      // (build tooling, mostly .mjs). Measured 85% across this set (blocks-only was 85.45%); folding in
      // the UI/build planes craters it to ~68% and misrepresents the bar. Keep this list and the
      // `test.include` standards planes in lockstep when a new plane lands.
      // #2875: the ONE exception to the scripts/ exclusion is the TRUST-CHAIN TIER — the exact file list
      // `isTrustChainTier` names (scripts/lib/trust-chain-tier.mjs), spread in by path, never a scripts/ glob.
      // Before #2875 these files were not instrumented at all (0% measured, not "already at 80%"); they are
      // instrumented so the #2873 per-diff floor has coverage to attribute. They now count toward the
      // combined 80% bar like any other included file; this adds no tier-specific threshold.
      include: [
        ...TRUST_CHAIN_TIER_FILES,
        'blocks/**/*.ts',
        'capabilities/**/*.ts',
        'validity-merge/**/*.ts',
        'commitment-policy/**/*.ts',
        'error-summary/**/*.ts',
        'validator-resolution/**/*.ts',
        'capability-manifest/**/*.ts',
        'validation-generation/**/*.ts',
        'module-resolution/**/*.ts',
        'source-resolution/**/*.ts',
        'conformance-evidence/**/*.ts',
        'guard/**/*.ts',
        'reliability/**/*.ts',
        'intl/**/*.ts',
        'manifests/**/*.ts',
        'process/**/*.ts',
        'wrapper-conformance/**/*.ts',
        'conformance-vectors/**/*.ts',
        'webtheme/**/*.ts',
        'reproduction-parity/**/*.ts',
        'repro-bundle/**/*.ts',
        'explorer/**/*.ts',
        'webtraits/**/*.ts',
        'webcompliance/**/*.ts',
        'webcases/**/*.ts',
        'interaction-state/**/*.ts',
        'config/**/*.ts',
        'functions/**/*.ts',
      ],
      exclude: [
        'node_modules/**',
        'src/**',
        '_site/**',
        'coverage/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/__tests__/**',
        '**/__fixtures__/**',
        '**/index.ts', // Export/barrel files don't need coverage
        '.eleventy.js',
        'playwright.config.ts',
        'vitest.config.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    include: [
      // #1047: WE's plug tests relocated to FUI (the canonical impl home) when `we:plugs/` was deleted.
      'blocks/**/__tests__/**/*.test.{ts,tsx}',
      'src/**/__tests__/**/*.test.{ts,tsx}', // build-time data files (e.g. burndown accounting)
      'scripts/**/__tests__/**/*.test.mjs', // build/CI tooling (e.g. conformance auto-fix engine, #095)
      'skills-src/**/__tests__/**/*.test.mjs', // skill-local mechanism modules (e.g. the conveyor headless runner, #2702)
      'tools/**/__tests__/**/*.test.{ts,tsx}', // build-time Vite plugins (e.g. the trait-enforcer codegen, #484)
      'capabilities/**/__tests__/**/*.test.{ts,tsx}', // capability provider + static build-matrix (#204)
      'validity-merge/**/__tests__/**/*.test.{ts,tsx}', // validity-merge strategy plane (#212)
      'commitment-policy/**/__tests__/**/*.test.{ts,tsx}', // commitment-policy strategy plane (#1112)
      'error-summary/**/__tests__/**/*.test.{ts,tsx}', // GOV.UK error-summary aggregation model (#1114)
      'validator-resolution/**/__tests__/**/*.test.{ts,tsx}', // async validator resolution plane (#214)
      'capability-manifest/**/__tests__/**/*.test.{ts,tsx}', // capability-manifest schema + semver scheme (#266)
      'validation-generation/**/__tests__/**/*.test.{ts,tsx}', // validation-generation intents + adapter registry (#304)
      'module-resolution/**/__tests__/**/*.test.{ts,tsx}', // module-resolution axis model + materializer (#274)
      'source-resolution/**/__tests__/**/*.test.{ts,tsx}', // source-anchor contract + resolver chain (#575)
      'conformance-evidence/**/__tests__/**/*.test.{ts,tsx}', // conformance-evidence manifest contract (#599)
      'guard/**/__tests__/**/*.test.{ts,tsx}', // guard protocol provider+predicate seam (#288/#289)
      'reliability/**/__tests__/**/*.test.{ts,tsx}', // error-recovery handler registry + trust-boundary guard (#1019/#1052)
      'intl/**/__tests__/**/*.test.{ts,tsx}', // Intl-formatting provider registry + native-first default (#1020/#1055)
      'manifests/**/__tests__/**/*.test.{ts,tsx}', // changelog-manifest reader — strictest-wins severity + migration integrity gate (#1021/#1058)
      'process/**/__tests__/**/*.test.{ts,tsx}', // self-driven artefact contract runtime — meta-schema registries + driving loop (#1026/#1071)
      'wrapper-conformance/**/__tests__/**/*.test.{ts,tsx}', // behavioral wrapper conformance vectors + runner (#891)
      'conformance-vectors/**/__tests__/**/*.test.{ts,tsx}', // behavioral conformance-vector schema + per-standard suites (#1016)
      // webtheme runtime + its token/scheme/palette tests were deleted with the runtime (#1910 — impl→
      // fui:webtheme, WE keeps contract + vectors per #1282). The reproduction-parity harness now resolves
      // the runtime via the `@frontierui/webtheme` alias below.
      'reproduction-parity/**/__tests__/**/*.test.{ts,tsx}', // reproduction-conformance harness + per-target gap lists (#1226/#1243)
      'repro-bundle/**/__tests__/**/*.test.{ts,tsx}', // repro-bundle contract — shape + validator/serializer/schema (#1664)
      'explorer/**/__tests__/**/*.test.{ts,tsx}', // explorer result interchange — SARIF-compatible shape + validator/projector (#1769)
      'webtraits/**/__tests__/**/*.test.{ts,tsx}', // intent-profile → trait build-time resolver (#776)
      'webcompliance/**/__tests__/**/*.test.{ts,tsx}', // webcompliance gate runner over the policy model (#437)
      'webcases/**/__tests__/**/*.test.{ts,tsx}', // webcases mock-vs-real drift check (#334)
      'interaction-state/**/__tests__/**/*.test.{ts,tsx}', // interaction-state model — dirty/touched/focused/submitted (#1110)
      'config/**/__tests__/**/*.test.{ts,tsx}', // webeverything.config author surface + per-dimension resolver (#1702)
      'demos/**/__tests__/**/*.test.{ts,tsx}', // exercise-app domain logic (e.g. loan permission scopes, #687)
      'tests/a11y/**/__tests__/**/*.test.ts', // pure a11y-gate helpers (e.g. sitemap scope-C derivation, #847) — Playwright owns the *.spec.ts lane
      'functions/**/__tests__/**/*.test.{ts,tsx}', // Cloudflare Pages Functions — phase-1 deploy gate (#1137)
    ],
    // These files all shell real `git init`/`clone`/`push` or spawn real `node` child processes per test
    // (proof-of-CLI-behavior fixtures, not pure-logic unit tests) and moved out to their own
    // `vitest.integration.config.ts` (`npm run test:integration:vitest`), reusing the split the repo already
    // draws for Playwright (`test:unit` vs `test:integration`). Two motivations, not one: (1) contention —
    // sharing the `threads` pool with these subprocess-heavy files inflated OTHER files' cost (e.g. the
    // gate-entrypoint-integration test went ~3s alone → ~51s under full-suite contention); (2) local
    // resource pressure under N concurrently-running lanes — `verify-lane.mjs`'s default gate (#3372) is
    // diff-driven and already skips unrelated tests, but ANY lane touching `scripts/` (a deny-by-default
    // sensitive surface) falls back to the full `npm run test:unit`, which no longer needs to re-prove real
    // git semantics locally — `verify-lane.mjs` is a pre-CI sanity check, not the authority; CI's required
    // `test` job (which now runs the integration config too) still verifies these on every push before merge.
    // See `vitest.integration.config.ts`'s header for the full file list and the pool assignment within it.
    exclude: [
      ...configDefaults.exclude,
      // #3061 real-CLI regression proof (`check-standards.mjs`/`lane-review.mjs`, captured through a real
      // pipe — an in-process call can't reproduce the truncation bug this exists to catch). Measured at
      // 88.9s total, 2 of its tests alone at 48.4s/39.7s — the single most expensive file in the unit suite,
      // more than every git-fixture file above combined. Found via the CI slow-test report
      // (`scripts/dev/report-slow-tests.mjs`), not the original file-by-file audit that found the rest.
      'scripts/__tests__/stdout-flush.test.mjs',
      // #3417 — a real `cargo build --release` plus a real spawned `we-scan` binary (#3264 mechanics
      // qualifier: the whole claim is cross-language behavioral parity, which no stub can observe). Requires
      // the Rust toolchain; skips itself when `cargo` is absent rather than failing the default suite.
      'scripts/__tests__/rust-scan-stdout-flush-parity.test.mjs',
      'scripts/__tests__/rust-scan-secret-scrub-parity.test.mjs',
      'scripts/__tests__/rust-scan-locus-prefix-parity.test.mjs',
      'scripts/__tests__/rust-scan-citation-check-parity.test.mjs',
      'scripts/__tests__/gate-entrypoint-integration.test.mjs',
      'scripts/operations/__tests__/wake-cli.test.mjs',
      'scripts/__tests__/lane-pool-acquire-base.test.mjs',
      'scripts/__tests__/publish-secret-gate.test.mjs',
      'scripts/operations/__tests__/dispatch-spawn-live.test.mjs',
      'scripts/__tests__/lane-pool-reserve.test.mjs',
      'scripts/__tests__/lane-pool-cross-pool.test.mjs',
      'scripts/__tests__/lane-pool-reap-on-acquire.test.mjs',
      'scripts/__tests__/lane-pool-siblings.test.mjs',
      'scripts/__tests__/lane-pool-acquirable.test.mjs',
      'scripts/__tests__/lane-pool-reap-on-list-acquirable.test.mjs',
      'scripts/__tests__/lane-pool-refresh-guard.test.mjs',
      'scripts/__tests__/lane-pool-release-ownership.test.mjs',
      'scripts/__tests__/lane-pool-item-map.test.mjs',
      'scripts/__tests__/lane-pool-release-item-map.test.mjs',
      'scripts/__tests__/lane-pool-ahead-provably-pushed-single-spawn.test.mjs',
      'scripts/__tests__/lane-pool-acquire-stale-origin.test.mjs',
      // #x3jmao3 — real throwaway origin + a genuine background OS process sleeping across the poll
      // boundary (proves the retry actually waits, not just that the flag parses); same shape as its
      // lane-pool-acquire-* siblings above, excluded from the default suite for the same reason.
      'scripts/__tests__/lane-pool-acquire-wait-ms.test.mjs',
      // #3383 — same tier: real throwaway origin/reference/filler clones, real `git cherry`/`ls-remote`, real
      // spawned `lane-pool.mjs` CLI invocations (list/provision/acquire).
      'scripts/__tests__/lane-pool-squash-merge-and-litter-acquirable.test.mjs',
      // #3383-perf — same tier, plus a real PATH-shimmed git-spawn-counting wrapper (like its #2920 sibling).
      'scripts/__tests__/lane-pool-ahead-patch-equivalent-bounded-spawn.test.mjs',
      // #xn432dz — same tier: real throwaway origin/pool, a PATH git shim, real spawned (incl. concurrent)
      // `lane-pool.mjs list --acquirable` children proving the lease-first skip, cache and single-flight lock.
      'scripts/__tests__/lane-pool-list-cache.test.mjs',
      // #x5n4zn3 — same tier: real throwaway origin/reference/pool, a PATH git shim (this one deliberately
      // HANGS, ignoring SIGTERM), a real spawned `lane-pool.mjs status` child.
      'scripts/__tests__/lane-pool-hung-git-bounded.test.mjs',
      // #4025 — same tier: real throwaway origin/reference/pool, real spawned `lane-pool.mjs trim`/`provision`
      // children.
      'scripts/__tests__/lane-pool-trim.test.mjs',
      'scripts/__tests__/lane-pool-acquirable-growth-cap.test.mjs',
      // #3383 — same tier: real throwaway origin/reference/pool, real spawned `lane-pool.mjs` acquire/provision
      // children, a PATH git shim for the remote-probe-failure case (mirrors its growth-cap sibling above).
      'scripts/__tests__/lane-pool-acquire-growth.test.mjs',
      'scripts/operations/__tests__/backlog-ops-integration.test.mjs',
      'scripts/operations/__tests__/dispatch-lane-integration.test.mjs',
      'scripts/operations/__tests__/gate-health-integration.test.mjs',
      'scripts/operations/__tests__/mutation-check-integration.test.mjs',
      'scripts/operations/__tests__/record-verdict-integration.test.mjs',
      'scripts/operations/__tests__/stage-pr-view-integration.test.mjs',
      // #xu2krte — a real `withRealRepo` git-conflict fixture plus a real (fake, cost-nothing) `claude` CLI
      // spawn/list/stop round trip; same tier as the two files immediately above it.
      'scripts/conveyor/__tests__/parked-pr-conflict-dispatch-integration.test.mjs',
      // #x5n4zn3 — same tier: a real spawned node driver + a real hanging `gh` shim on `PATH`.
      'scripts/conveyor/__tests__/parked-pr-conflict-hung-gh-bounded.test.mjs',
    ],
  },
  resolve: {
    alias: weAlias,
  },
});
