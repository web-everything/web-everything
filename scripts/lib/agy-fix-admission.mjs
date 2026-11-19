import { statSync } from 'node:fs';
import { URL } from 'node:url';
import { criticalWorkVerdict } from './critical-work.mjs';

const isDoc = p => /\.(md|mdx|txt|rst)$/.test(p);
const isDirectory = p => {
  try { return statSync(new URL(`../../${p}`, import.meta.url)).isDirectory(); }
  catch { return false; }
};
const isDocScope = p => isDoc(p) || p === 'docs' || p.startsWith('docs/') && isDirectory(p);
const isTest = p => /\.(mjs|js|ts|cjs)$/.test(p)
  && (/(^|\/)(__tests__|tests)\//.test(p) || /\.(test|spec)\.[^/]+$/.test(p))
  && !/(^|\/)setup(?:[.-]|Tests)/i.test(p);
// A test scope is a prefix only; every applied file is still checked by isTest, so no filesystem probe is needed.
const isTestScope = p => isTest(p) || /(^|\/)(__tests__|tests)(\/|$)/.test(p) && !/\.[^/]+$/.test(p);
/** Applied files must be prose or code tests; directory prefixes are scope-only. */
export const isAdmissibleTargetPath = p => admissible(p, false);
export const isAdmissibleTargetScope = p => admissible(p, true);
function admissible(p, scope) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || /[\x00-\x1f\x7f-\x9f\\*?\[\]{}:]/.test(p)
    // Any dot-segment is refused: .gitignore/.gitattributes inside docs change how git enumerates and filters files
    // (an ignore rule hides untracked files from the launcher's whole-run path check; audit).
    || p.split('/').some(s => !s || s === '.' || s === '..' || s.startsWith('.'))) return false;
  if (/^(\.github|scripts\/settings|backlog|agent-memory-src)(\/|$)/.test(p)
    || /(^|\/)(soak|breaks)(\/|$)/.test(p)
    || /\.(json|yml|yaml|toml)$/.test(p) || /\.real\.test\.mjs$/.test(p)
    || /(^|\/)(?:[^/]*\.config\.[^/]+|tsconfig[^/]*|[^/]*\.lockb?)$/.test(p)
    || p.startsWith('docs/') && !isDoc(p) && !(scope && isDirectory(p))
    || !((scope ? isDocScope(p) : isDoc(p)) || (scope ? isTestScope(p) : isTest(p)))) return false;
  // Fixtures and tests of critical modules protect enforcement: a test is admissible only when its SUBJECT is not critical.
  if (/(^|\/)fixtures?(\/|$)/.test(p)) return false;
  const subject = p.replace(/(^|\/)(?:__tests__|tests)\//, '$1')
    .replace(/\.(test|spec)(\.[^/.]+)$/, '$2').replace(/(?:-integration|-e2e|-unit)+(\.[^/.]+)$/, '$1');
  // Top-level script tests also exercise modules housed in scripts/lib.
  const subjects = [subject, subject.replace(/^scripts\/(?!.*\/)/, 'scripts/lib/')]
    .flatMap(p => [p, p.replace(/\.(mjs|js|ts|cjs)$/, '.mjs')]);
  try {
    return criticalWorkVerdict({ filesTouched: [p, `${p}/`, ...subjects] }).critical === false;
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
  if (!scope.length || scope.length > 20 || !scope.every(isAdmissibleTargetScope)) return null;
  if (!launchScope.length || launchScope.length > 20 || !launchScope.every(isAdmissibleTargetScope)
    || !scope.every(p => launchScope.some(root => p === root || p.startsWith(`${root}/`)))) return null;
  // Recheck the actual admitted paths, including directory forms, against the routing gate.
  try {
    if (criticalWorkVerdict({ ...launch, ...item, taskType: taskKind,
      filesTouched: scope.flatMap(p => [p, `${p}/`]) }).critical) return null;
  } catch { return null; } // Unknown criticality advances to the next provider/operator.
  if (!Number.isFinite(size) || size !== 1) return null;
  if (typeof taskKind !== 'string' || !/^[a-z][a-z0-9-]*$/.test(taskKind)) return null;
  const kind = taskKind === 'fix' && scope.every(isDocScope) ? 'doc-fix'
    : taskKind === 'fix' && scope.every(isTestScope) ? 'test-fix' : taskKind;
  return { kind, size, scope };
}
