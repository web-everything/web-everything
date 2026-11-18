const isDoc = p => /\.(md|mdx|txt|rst)$/.test(p) || /^(docs|backlog|agent-memory-src)(\/|$)/.test(p);
const isTest = p => /(^|\/)(__tests__|tests)(\/|$)/.test(p) || /\.(test|spec)\.[^/]+$/.test(p);
const protectedPaths = ['.github/workflows', 'scripts/settings'];
const forbidden = p => protectedPaths.some(s => p === s || p.startsWith(`${s}/`) || s.startsWith(`${p}/`))
  || p.split('/').some(s => /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock)$/.test(s));

/** Repair admission is narrower than general build admission. Unknown evidence uses the next provider. */
export function deriveAgyFixAdmission(item = {}, launch = {}) {
  const repo = launch.claimRepo ?? launch.repo ?? 'we';
  const declared = item.scope?.length ? item.scope : launch.scope;
  const entries = Array.isArray(declared) ? declared : typeof declared === 'string' ? declared.split(',') : [];
  const scope = entries.map(p => typeof p === 'string' ? p.trim().replace(/\/$/, '') : '').map(p => {
    const colon = p.indexOf(':');
    return colon < 0 ? p : p.slice(0, colon) === repo ? p.slice(colon + 1) : '';
  });
  if (!scope.length || !scope.every(p => p && !/^[\/]/.test(p) && !/[\x00-\x1f\x7f\\*?\[\]{}:]/.test(p)
    && !p.split('/').some(s => !s || s === '.' || s === '..' || s.toLowerCase() === '.git'))) return null;
  const taskKind = item.taskKind ?? item.taskType ?? item.kind ?? launch.taskKind ?? 'fix';
  const size = item.size ?? launch.size;
  if (!Number.isFinite(size) || size < scope.length || size > 1 || scope.some(forbidden)) return null;
  if (typeof taskKind !== 'string' || !/^[a-z][a-z0-9-]*$/.test(taskKind)) return null;
  if (taskKind === 'doc-fix' && !scope.every(isDoc) || taskKind === 'test-fix' && !scope.every(isTest)) return null;
  const kind = taskKind === 'fix' && scope.every(isDoc) ? 'doc-fix'
    : taskKind === 'fix' && scope.every(isTest) ? 'test-fix' : taskKind;
  return { kind, size, scope };
}
