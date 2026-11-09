const matches = (value, identity) => value && value.repo === identity.repo && value.pr === identity.pr && value.head === identity.head;
function path(value) {
  if (typeof value !== 'string' || !value || /[\\\x00-\x1f]/.test(value) || value.startsWith('/')) return null;
  const parts = value.replace(/^(?:\.\/)+/, '').split('/');
  return parts.some(p => !p || p === '..' || p === '.') ? null : parts.join('/');
}
export function classifyMqFailureIntake(input) {
  const { route, changedFiles } = input;
  if (!matches(route, input) || route.stale !== false || route.complete !== true
    || !matches(changedFiles, input) || changedFiles.complete !== true
    || !Array.isArray(route.testFiles) || !route.testFiles.length || route.testFiles.length > 100
    || !Array.isArray(changedFiles.files) || changedFiles.files.length > 10000) return 'fix';
  const tests = route.testFiles.map(path), files = changedFiles.files.map(path);
  if (tests.includes(null) || files.includes(null)) return 'fix';
  const changed = new Set(files);
  return tests.every(file => !changed.has(file)) ? 'refresh' : 'fix';
}
export function admitMqFailureRoute(input) {
  const { route, repo, pr, head } = input;
  if (!matches(route, input) || route.stale !== false) return null;
  return { kind: 'fix', repo, pr, head, recoveryAction: classifyMqFailureIntake(input),
    evidence: structuredClone({ failedJobs: route.failedJobs, testFiles: route.testFiles,
      assertions: route.assertions, complete: route.complete }) };
}
