import { buildStandDownComment } from '../../stand-down.mjs';

/** Persisted reader fixtures from before producers required a full head SHA.
 * Keep historical inputs explicit; never relax the production writer for tests.
 */
export function legacyStandDownComment(options = {}) {
  const fixtureHead = 'a'.repeat(40);
  const oldHead = typeof options.head === 'string' && /^[0-9a-f]{7,40}$/i.test(options.head) ? options.head : null;
  let body = buildStandDownComment({ ...options, head: fixtureHead }).replace(
    /(<!-- stand-down reason=[a-z-]+) head=[0-9a-f]{40}((?: findings=[A-Za-z0-9_-]+)? -->)$/,
    (_, prefix, suffix) => `${prefix}${oldHead ? ` head=${oldHead}` : ''}${suffix}`,
  );
  if (!oldHead) body = body.replace('This hold is for this head only and lapses automatically on a new push.\n', '');
  return body;
}
