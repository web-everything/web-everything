/** Pure command planning for the remote workflow; existence checks are injected. */
// Keep identical to operationNamePattern in scripts/remote-test.mjs.
const operationNamePattern = /^[a-z][a-z0-9-]*$/;
export function remoteVerifyCommands({ mode, tests = '', operation = '' }, exists) {
  switch (mode) {
    case 'lane-check':
      return [['node', ['scripts/verify-lane.mjs', 'run']]];
    case 'full':
      return [['npm', ['run', 'check:standards']], ['npm', ['run', 'test:unit']]];
    case 'targeted': {
      const files = tests.trim().split(/\s+/).filter(Boolean);
      if (files.length) {
        if (files.some(file => file.startsWith('-') || !exists(file))) {
          throw new Error('Expected existing test file paths');
        }
        return [['npm', ['run', 'test:unit', '--', ...files]]];
      }
      const name = operation.trim();
      if (!operationNamePattern.test(name)) {
        throw new Error('Targeted mode requires tests or an operation name');
      }
      const declaration = `scripts/operations/${name}.mjs`;
      if (!exists(declaration)) throw new Error('Unknown operation');
      const related = [declaration, `scripts/operations/${name}-io.mjs`].filter(exists);
      return [['node', ['scripts/readiness/heavy-admission.mjs', 'run', '--',
        'npx', 'vitest', 'related', '--run', ...related]]];
    }
    default:
      throw new Error('Unknown verification mode');
  }
}
