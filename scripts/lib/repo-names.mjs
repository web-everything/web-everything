/**
 * repo-names.mjs — the repo-name SETTING (R945; lives in lib/ because settings/ holds only JSON feature files): owner/name per constellation repo that is named by setting.
 * Pure data with no imports on purpose: `constellation-repos.mjs` imports it, and read-only declarations assert
 * (static import-graph guard) that nothing they reach touches `node:` built-ins or JSON modules.
 * A later org move is a one-line change here. `longshore` is the delivery engine + backlog tooling repo (R160/#5488).
 */
export const REPO_NAMES = Object.freeze({
  longshore: Object.freeze({ owner: 'longshoreai', name: 'longshore' }),
});
