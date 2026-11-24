/**
 * @file scripts/lib/lane-pool-origin.mjs
 * @description LANE-POOL-WRONG-REPO: pure origin comparison. A lane whose origin differs from its pool's
 *   configured origin is wrong-origin. Unknown (null/empty) never marks a lane wrong. Paths are compared
 *   case-sensitively and ports are kept, so ssh:// and scp-style spellings only match when they cannot differ.
 */
const norm = (u) => {
  let s = String(u || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::(\d+))?[:/](.+)$/i.exec(s);
  if (!m) return s;
  const scpStyle = !/^[a-z+]+:\/\//i.test(s);
  return `${m[1].toLowerCase()}${m[2] && !scpStyle ? `:${m[2]}` : ''}/${scpStyle && m[2] ? `${m[2]}/` : ''}${m[3]}`;
};

/** @param {string|null} a @param {string|null} b */
export function originsDiffer(a, b) {
  return Boolean(a && b && norm(a) !== norm(b));
}
