/**
 * @file scripts/lib/data-table-build-hook.cjs
 * @description WE Eleventy build orchestration for the SSR data-table harness (#1905, slice C of #1867).
 *
 *   The integration slice of the ratified harness
 *   (`docs/agent/platform-decisions.md#ssr-data-table-build-harness`). At build time this hook:
 *     1. DETECTS a `<we-data-table rows="[[ ref ]]">` web-expression binding in rendered page HTML;
 *     2. RESOLVES the bare `ref` from the deterministic, build-known Eleventy data context (NEVER the dev
 *        `/_maas/data/` route — that route is the dev-freshness HMR seam, not a build transport);
 *     3. SHELLS OUT to the version-pinned FUI build-CLI over the subprocess boundary — keyed-batch JSON in
 *        on stdin, keyed-batch `{producer, results:[{key, html|error}]}` out on stdout — and
 *     4. SPLICES the returned SSR `<table>` HTML back into the element.
 *
 *   WHY a subprocess and not an import: the `<we-data-table>` evaluator + `renderDataTable` live in FUI; a
 *   WE→FUI code import is a banned backward DAG edge (constellation-placement). So WE orchestrates the FUI
 *   compute over a process boundary — the offline-build sibling of the WE-data → FUI-runtime served route.
 *
 *   The CLI is resolved as a LOCKED build-artifact at a FIXED relative path, never PATH-resolved (Fork 1
 *   skeptic amendment — else the build is non-reproducible). FUI's `npm run build:tools` (#1946) emits it;
 *   the cross-repo build ordering (FUI `build:tools` BEFORE WE `build:docs`) is ratified — a missing
 *   artifact is a hard build error here, never a silent skip.
 *
 *   Authored as CommonJS so the sync-only Eleventy 2.x config can `require` it directly.
 */

const path = require('node:path');
const fs = require('node:fs');
const { runCliToFile } = require('./run-cli-batch.cjs');

/**
 * The pinned FUI build-artifact. A FIXED relative path resolved from the WE repo root against the sibling
 * `../frontierui` checkout — no PATH lookup, no version probe (the reproducibility amendment). FUI's
 * `npm run build:tools` (#1946) esbuild-bundles the CLI to exactly this self-contained ESM file.
 */
const PINNED_CLI_RELATIVE = path.join('..', 'frontierui', 'dist', 'tools', 'data-table-build', 'cli.mjs');

/** Producer pin the FUI harness stamps onto its batch envelope — surfaced so a stale/mismatched artifact
 *  is visible. Kept in sync with `frontierui/.../buildHarness.ts:BUILD_HARNESS_PRODUCER`. */
const EXPECTED_PRODUCER = 'frontierui/data-table-build-harness/1';

/**
 * The `<we-data-table …>` open-tag scanner. Captures the whole open tag and its `rows="…"` attribute so a
 * deterministic `[[ ref ]]` binding can be detected and the SSR table spliced after the open tag. Matches
 * both self-closing and paired forms; the body (if any) is replaced wholesale by the SSR `<table>`.
 */
const DATA_TABLE_TAG = /<we-data-table\b([^>]*)>([\s\S]*?)<\/we-data-table>/gi;
const SELF_CLOSING_TAG = /<we-data-table\b([^>]*)\/>/gi;

/** A bare deterministic web-expression: `[[ ref ]]` resolving a single dotted ref against build context.
 *  Anything richer (pipes, magic vars, calls) is NOT build-deterministic and is left for the runtime/client
 *  path (the non-deterministic app case is #1827) — this hook only resolves the bare-ref subset. */
const BARE_REF = /^\s*\[\[\s*([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)\s*\]\]\s*$/;

/** Pull an attribute's value out of an open-tag attribute string. Returns undefined when absent. */
function readAttr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)
    || new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(attrs);
  return m ? m[1] : undefined;
}

/**
 * Resolve a bare dotted ref (`a.b.c`) against the build-known Eleventy data context. Pure dotted-path
 * lookup, no evaluation — the deterministic build subset. Returns `{ ok, value }`; `ok:false` when any
 * segment is missing (so the caller can leave the binding for the runtime path rather than emit a wrong
 * table). NEVER reaches out to a network/origin — build hermeticity (Bazel-style).
 */
function resolveBareRef(ref, data) {
  let cur = data;
  for (const seg of ref.split('.')) {
    if (cur == null || typeof cur !== 'object' || !(seg in cur)) return { ok: false };
    cur = cur[seg];
  }
  return { ok: true, value: cur };
}

/**
 * Detect the deterministic data-table bindings in one page's HTML. Returns an array of
 * `{ ref, rows, config, marker }` for each `<we-data-table rows="[[ ref ]]">` whose ref resolves from the
 * build context to a `{ rows, config }` (or a bare row array). Bindings that are non-deterministic
 * (non-bare-ref) or unresolved are skipped — left intact for the client runtime.
 *
 * The element's declarative `config` is taken from a sibling `config="[[ ref ]]"` / `data-config` binding
 * when present, else an empty config (columns inferred downstream by the FUI renderer).
 */
function findDataTableBindings(html, data) {
  const bindings = [];
  let key = 0;
  const collect = (attrs) => {
    const rowsAttr = readAttr(attrs, 'rows');
    if (!rowsAttr) return null;
    const m = BARE_REF.exec(rowsAttr);
    if (!m) return null; // non-deterministic binding — runtime path owns it
    const rowsRes = resolveBareRef(m[1], data);
    if (!rowsRes.ok) return null; // ref not build-known — leave for runtime
    // Resolve a co-located config ref if declared; default to the empty declarative config.
    let config = {};
    const configAttr = readAttr(attrs, 'config') || readAttr(attrs, 'data-config');
    if (configAttr) {
      const cm = BARE_REF.exec(configAttr);
      if (cm) {
        const cRes = resolveBareRef(cm[1], data);
        if (cRes.ok && cRes.value && typeof cRes.value === 'object') config = cRes.value;
      }
    }
    const resolved = rowsRes.value;
    // Allow either a bare rows array, or a { rows, config } envelope on the ref.
    const rows = Array.isArray(resolved) ? resolved
      : (resolved && Array.isArray(resolved.rows) ? resolved.rows : null);
    if (rows == null) return null; // resolved to a non-row-set — not our shape
    if (resolved && !Array.isArray(resolved) && resolved.config && typeof resolved.config === 'object')
      config = { ...resolved.config, ...config };
    return { key: `we-data-table-${key++}`, ref: m[1], rows, config };
  };

  // Paired form: <we-data-table …>…</we-data-table>
  let mm;
  while ((mm = DATA_TABLE_TAG.exec(html)) !== null) {
    const b = collect(mm[1]);
    if (b) bindings.push({ ...b, match: mm[0], openTag: `<we-data-table${mm[1]}>` });
  }
  // Self-closing form: <we-data-table … />
  while ((mm = SELF_CLOSING_TAG.exec(html)) !== null) {
    const b = collect(mm[1]);
    if (b) bindings.push({ ...b, match: mm[0], openTag: `<we-data-table${mm[1].replace(/\/\s*$/, '')}>` });
  }
  return bindings;
}

/**
 * Shell out to the pinned FUI build-CLI: keyed-batch JSON on stdin, keyed-batch envelope on stdout.
 * `repoRoot` is the WE repo root the fixed relative artifact path is resolved against. Throws a hard
 * build error when the artifact is absent (the ratified ordering means FUI built it first) or the process
 * fails — a missing/mis-emitted artifact must NOT silently skip (non-reproducible build).
 */
function runBuildBatch(entries, repoRoot, runner = runCliToFile) {
  const cliPath = path.resolve(repoRoot, PINNED_CLI_RELATIVE);
  if (!fs.existsSync(cliPath)) {
    throw new Error(
      `[data-table build] pinned FUI artifact missing at ${cliPath} — run FUI \`npm run build:tools\` `
      + `before WE \`build:docs\` (ratified ordering, #1946). A missing artifact is a hard build error.`,
    );
  }
  const input = JSON.stringify(entries);
  const out = runner('node', [cliPath], { input, encoding: 'utf8' });
  let batch;
  try {
    batch = JSON.parse(out);
  } catch (e) {
    throw new Error(`[data-table build] CLI returned non-JSON output: ${e && e.message}`);
  }
  if (!batch || batch.producer !== EXPECTED_PRODUCER) {
    throw new Error(
      `[data-table build] producer pin mismatch (got ${batch && batch.producer}, expected `
      + `${EXPECTED_PRODUCER}) — the pinned artifact is stale or PATH-resolved.`,
    );
  }
  return batch;
}

/**
 * The Eleventy transform body: detect deterministic `<we-data-table>` bindings in `content`, resolve them
 * from the page's build data, shell the batch to the pinned FUI CLI once, and splice each returned SSR
 * `<table>` into its element. `data` is the page's Eleventy data cascade (build-known context). Returns the
 * content unchanged when there are no deterministic bindings (the common case) so non-table pages pay
 * nothing. Per-entry errors are isolated: a failed binding leaves the original element intact and is logged,
 * never aborting the page (keyed-batch isolation — one bad table never poisons the others or the build).
 */
function spliceDataTables(content, data, repoRoot, runner = runCliToFile) {
  if (typeof content !== 'string' || content.indexOf('we-data-table') === -1) return content;
  const bindings = findDataTableBindings(content, data || {});
  if (bindings.length === 0) return content;

  const batch = runBuildBatch(
    bindings.map((b) => ({ key: b.key, rows: b.rows, config: b.config })),
    repoRoot,
    runner,
  );
  const byKey = new Map(batch.results.map((r) => [r.key, r]));

  let out = content;
  for (const b of bindings) {
    const res = byKey.get(b.key);
    if (!res || res.error || !res.html) {
      // Isolate the failure: keep the original element, surface the error to the build log.
      if (res && res.error) {
        // eslint-disable-next-line no-console
        console.warn(`[data-table build] binding "${b.ref}" failed, left un-SSR'd: ${res.error}`);
      }
      continue;
    }
    // Splice the SSR <table> as the element's body (replacing any placeholder/SSR-empty body), so the
    // single rendered table is the SSR output and the in-place client enhancer (slice B, #1904)
    // progressively enhances the EXISTING rows — no JSON island, no client re-render, no skew class.
    out = out.replace(b.match, `${b.openTag}${res.html}</we-data-table>`);
  }
  return out;
}

module.exports = {
  PINNED_CLI_RELATIVE,
  EXPECTED_PRODUCER,
  resolveBareRef,
  findDataTableBindings,
  runBuildBatch,
  spliceDataTables,
};
