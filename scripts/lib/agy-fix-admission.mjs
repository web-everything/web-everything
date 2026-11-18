import { isDocScopePath, isTestPath } from './dispatch-task-type.mjs';

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
  const kind = ['doc-fix', 'test-fix'].includes(taskKind) ? taskKind : taskKind === 'fix'
    ? scope.every(isDocScopePath) ? 'doc-fix'
      : scope.every(isTestPath) ? 'test-fix' : null
    : null;
  const size = item.size ?? launch.size;
  return kind && Number.isFinite(size) && size >= 0 && size <= 1 ? { kind, size, scope } : null;
}
