// eleventy/transforms.cjs — addTransform and eleventy.on registrations.
// Fragment of .eleventy.js (#2184). Transforms and lifecycle hooks; order within this file
// is immaterial — each is registered by a unique name or event type.

const { spliceDataTables } = require("../scripts/lib/data-table-build-hook.cjs");
const { spliceComponentsBatch } = require("../scripts/lib/component-render-build-hook.cjs");

/**
 * Register all transforms and lifecycle hooks on the given eleventyConfig.
 * @param {import("@11ty/eleventy").UserConfig} eleventyConfig
 * @param {string} repoRoot - absolute path to the repo root (passed in from .eleventy.js)
 */
function registerTransforms(eleventyConfig, repoRoot) {
  // SSR data-table build orchestration (#1905, slice C of the #1867 harness) — detect a deterministic
  // `<we-data-table rows="[[ ref ]]">` web-expression binding in the rendered page HTML, resolve the bare
  // ref from the build-known data cascade, shell out to the version-pinned FUI build-CLI over the
  // subprocess boundary (keyed-batch in / keyed-batch out), and splice the returned SSR `<table>`. The
  // evaluator + renderer live in FUI (a WE→FUI import is a banned backward DAG edge), so WE orchestrates
  // the FUI compute over a process boundary; the build NEVER reads the dev /_maas/data/ route — that's the
  // dev-freshness HMR seam, not a build transport. See docs/agent/platform-decisions.md#ssr-data-table-build-harness.
  // Non-deterministic / unresolved bindings are left intact for the client runtime; non-table pages pay a
  // single substring check. The pinned FUI artifact MUST already exist (FUI `build:tools` before WE
  // `build:docs`, ratified #1946) — a missing artifact is a hard build error, never a silent skip.
  eleventyConfig.addTransform("weDataTableSSR", function (content) {
    if (!/\.html?$/.test(this.page && this.page.outputPath || "")) return content;
    return spliceDataTables(content, this.data || {}, repoRoot);
  });

  // Generic template-facing card/badge SSR primitive (#2098, keystone #2016). The `weCard`/`weBadge`
  // macros (src/_includes/we-component.njk) emit inert `<we-card|we-badge data-we-spec='{…}'>`
  // placeholders for a ONE-OFF inline card/badge (the grid shortcodes above cover whole collections).
  //
  // #2185 — batch the SSR splice across the WHOLE build, not per page. The former per-page `addTransform`
  // paid a full `node`+happy-dom cold start on every page carrying a placeholder; the #2102 backlog dogfood
  // put 4 `weCard`s on all ~2167 backlog item pages, so a cold `build:docs` serially spawned ~2167
  // subprocesses (~16 min) — long enough that the 11ty dev server never bound its port in a usable time and
  // the Vite `/backlog/…` proxy ECONNREFUSED'd the whole window. Instead the placeholders survive into the
  // written page and `eleventy.after` shares bounded batches of every page's placeholders through the
  // pinned FUI CLI (`spliceComponentsBatch` → `renderComponents`), amortizing cold starts. Output is
  // byte-identical (the placeholder's `data-we-spec` is self-describing). In `--serve`, `results` is only
  // the changed pages, so a dev edit re-splices just what it touched. Same subprocess boundary +
  // pinned-artifact/missing-artifact hard error as the data-table hook above; the block factories live in
  // FUI (a WE→FUI import is a banned backward DAG edge). The client `<we-card>`/`<we-badge>` CE upgrade
  // (src/_layouts/base.njk) is a pure enhancement over the JS-off-correct SSR baseline. A page with no
  // `data-we-spec` placeholder pays a single substring check.
  eleventyConfig.on("eleventy.after", function ({ results }) {
    const { pages, components } = spliceComponentsBatch(results, repoRoot);
    if (components > 0) {
      // eslint-disable-next-line no-console
      console.log(`[component-render build] SSR-spliced ${components} component(s) across ${pages} page(s) in bounded batches.`);
    }
  });
}

module.exports = { registerTransforms };
