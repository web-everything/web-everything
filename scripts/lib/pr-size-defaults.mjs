/** R125: pure data stays in the review but does not consume the code line budget.
 * Dependency-free so operation declarations remain import-safe.
 */
export const BUILT_IN_PR_SIZE_SETTINGS = Object.freeze({
  dataExtensions: Object.freeze(['.json', '.yaml', '.yml', '.csv']),
  dataDirs: Object.freeze(['config', 'data']),
  dataPaths: Object.freeze([]),
});
