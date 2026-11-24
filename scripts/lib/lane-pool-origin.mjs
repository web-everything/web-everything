/**
 * @file scripts/lib/lane-pool-origin.mjs
 * @description LANE-POOL-WRONG-REPO: pure origin comparison. A lane whose origin differs from its pool's
 *   configured origin is wrong-origin. Unknown (null/empty) never marks a lane wrong. Paths are compared
 *   case-sensitively and ports are kept. Home-relative SSH paths retain their login account; shared Git
 *   hosting namespaces keep their equivalent SSH/HTTPS spellings.
 */
const norm = (u) => {
  const s = String(u || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const url = /^([a-z][a-z\d+.-]*):\/\/(?:([^/@]+)@)?(\[[^\]]+\]|[^/:]+)(?::(\d+))?\/(.*)$/i.exec(s);
  const scp = !s.includes('://') && /^(?:([^@/:]+)@)?(\[[^\]]+\]|[^/:]+):(.+)$/.exec(s);
  if (!url && !scp) return s;
  const scheme = url ? url[1].toLowerCase() : 'ssh';
  const user = (url ? url[2] : scp[1]) || '';
  const host = url ? url[3] : scp[2];
  const port = url ? url[4] || '' : '';
  const path = url ? url[5] : scp[3];
  const authority = [host.toLowerCase(), port];
  if (['ssh', 'git+ssh', 'ssh+git'].includes(scheme)) {
    const homeRelative = scp ? !path.startsWith('/') : path.startsWith('~');
    // These services use a shared SSH account and repository namespace, not Unix home directories.
    const hosted = user === 'git' && ['github.com', 'gitlab.com', 'bitbucket.org'].includes(authority[0])
      && !path.startsWith('~') && !path.startsWith('/');
    if (homeRelative && !hosted) {
      return JSON.stringify(['ssh-home', ...authority, user, path.startsWith('~') ? path : `~/${path}`]);
    }
    return JSON.stringify(['remote', ...authority, path.replace(/^\//, '')]);
  }
  if (['http', 'https', 'git'].includes(scheme)) return JSON.stringify(['remote', ...authority, path]);
  return s;
};

/** @param {string|null} a @param {string|null} b */
export function originsDiffer(a, b) {
  return Boolean(a && b && norm(a) !== norm(b));
}
