// eleventy/passthroughs.cjs — addPassthroughCopy and addWatchTarget registrations.
// Fragment of .eleventy.js (#2184). Passthrough/watch entries are additive and order-insensitive.

/**
 * Register all passthrough copies and watch targets on the given eleventyConfig.
 * @param {import("@11ty/eleventy").UserConfig} eleventyConfig
 */
function registerPassthroughs(eleventyConfig) {
  // The backlog feeds off backlog/*.md (parsed by src/_data/backlog.js, which
  // lives outside the input dir) — watch it so edits trigger a rebuild in dev.
  // reports/*.md is watched too: pointer items mirror a report, so editing a
  // report must refresh the backlog that loads it.
  eleventyConfig.addWatchTarget("backlog");
  eleventyConfig.addWatchTarget("reports");
  // The per-adapter files are read fresh in the flatAdapters collection (not the data cascade), so watch
  // the directory explicitly — otherwise new adapter pages 404 on the live dev server until restart.
  eleventyConfig.addWatchTarget("src/_data/adapters");

  eleventyConfig.addPassthroughCopy("src/css");
  // Eleventy 2 forwards copy options to recursive-copy; filter paths are relative to src/assets.
  eleventyConfig.addPassthroughCopy("src/assets", {
    filter: (path) => !path.split("/").includes("__tests__") && !/\.(test|spec)\.[^/]*$/.test(path),
  });
  eleventyConfig.addPassthroughCopy("demos");
  eleventyConfig.addPassthroughCopy("plugs");
  // Design-reference corpus (#382): serve the WebP shots under the gallery page's URL, and watch
  // design-refs so new captures (and the designRefs data loader) hot-reload on the dev server.
  eleventyConfig.addPassthroughCopy({ "design-refs/items": "research/design-references/shots" });
  eleventyConfig.addWatchTarget("design-refs");
}

module.exports = { registerPassthroughs };
