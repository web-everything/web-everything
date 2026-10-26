import { createPrDiffStatReader } from './open-pr-io.mjs';

/** Reuse the submission reader, scoped to the caller's explicit checkout. */
export function createPrSizeReader({ createDiffStatReader = createPrDiffStatReader } = {}) {
  return ({ checkout }) => createDiffStatReader({ cwd: checkout })({ base: 'main', sha: 'HEAD' });
}
