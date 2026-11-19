import { criticalWorkVerdict } from './critical-work.mjs';

const isDoc = p => /\.(md|mdx)$/.test(p) || /^docs(\/|$)/.test(p);
const isTest = p => /(^|\/)(__tests__|tests)(\/|$)/.test(p) || /\.(test|spec)\.[^/]+$/.test(p);
/** Kind-agnostic allowlist shared by scope admission and every applied path. */
export function isAdmissibleTargetPath(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || /[\x00-\x1f\x7f-\x9f\\*?\[\]{}:]/.test(p)
    || p.split('/').some(s => !s || s === '.' || s === '..' || s.toLowerCase() === '.git')) return false;
  if (/^(\.github|scripts\/settings|backlog|agent-memory-src)(\/|$)/.test(p)
    || /(^|\/)(soak|breaks)(\/|$)/.test(p)
    || /\.(json|yml|yaml|toml)$/.test(p) || /\.real\.test\.mjs$/.test(p)
    || /(^|\/)(?:[^/]*\.config\.[^/]+|tsconfig[^/]*|[^/]*\.lockb?)$/.test(p)
    || !(isDoc(p) || isTest(p))) return false;
  // Fixtures and tests of critical modules protect enforcement: a test is admissible only when its SUBJECT is not critical.
  if (/(^|\/)fixtures?(\/|$)/.test(p)) return false;
  const subject = p.replace(/(^|\/)__tests__\//, '$1').replace(/\.(test|spec)(\.[^/.]+)$/, '$2');
  try {
    return criticalWorkVerdict({ filesTouched: [p, `${p}/`, ...(subject === p ? [] : [subject])] }).critical === false;
  } catch { return false; } // Unknown criticality uses the next provider/operator.
}

/** Repair admission is narrower than general build admission. Unknown evidence uses the next provider. */
export function deriveAgyFixAdmission(item = {}, launch = {}) {
  const repo = launch.claimRepo ?? launch.repo ?? 'we';
  const parseScope = declared => {
    const entries = Array.isArray(declared) ? declared : typeof declared === 'string' ? declared.split(',') : [];
    return Array.from(entries).map(p => typeof p === 'string' ? p : '').map(p => {
      const colon = p.indexOf(':');
      return colon < 0 ? p : p.slice(0, colon) === repo ? p.slice(colon + 1) : '';
    });
  };
  const launchScope = parseScope(launch.scope);
  const scope = item.scope == null ? launchScope : parseScope(item.scope);
  const taskKind = item.taskKind ?? item.taskType ?? item.kind ?? launch.taskKind ?? 'fix';
  const size = item.size ?? launch.size;
  if (!scope.length || scope.length > 20 || !scope.every(isAdmissibleTargetPath)) return null;
  if (!launchScope.length || launchScope.length > 20 || !launchScope.every(isAdmissibleTargetPath)
    || !scope.every(p => launchScope.some(root => p === root || p.startsWith(`${root}/`)))) return null;
  // Recheck the actual admitted paths, including directory forms, against the routing gate.
  try {
    if (criticalWorkVerdict({ ...launch, ...item, taskType: taskKind,
      filesTouched: scope.flatMap(p => [p, `${p}/`]) }).critical) return null;
  } catch { return null; } // Unknown criticality advances to the next provider/operator.
  if (!Number.isFinite(size) || size !== 1) return null;
  if (typeof taskKind !== 'string' || !/^[a-z][a-z0-9-]*$/.test(taskKind)) return null;
  const kind = taskKind === 'fix' && scope.every(isDoc) ? 'doc-fix'
    : taskKind === 'fix' && scope.every(isTest) ? 'test-fix' : taskKind;
  return { kind, size, scope };
}
