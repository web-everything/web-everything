const matches = (value, identity) => value && value.repo === identity.repo && value.pr === identity.pr && value.head === identity.head;
// Recovery only hands evidence to the fixer; the drain owns same-head refreshes.
export function classifyMqFailureIntake(_input) {
  return 'fix';
}
export function admitMqFailureRoute(input) {
  const { route, repo, pr, head } = input;
  if (!matches(route, input) || route.stale !== false) return null;
  return { kind: 'fix', repo, pr, head, recoveryAction: classifyMqFailureIntake(input),
    evidence: structuredClone({ failedJobs: route.failedJobs, testFiles: route.testFiles,
      assertions: route.assertions, complete: route.complete,
      ...(typeof route.failureProven === 'boolean' ? { failureProven: route.failureProven } : {}) }) };
}
