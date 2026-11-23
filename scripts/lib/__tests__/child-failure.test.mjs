import { it, expect } from 'vitest';
import { childFailure } from '../child-failure.mjs';
import { classifyChildFailure } from '../child-failure-class.mjs';

it.each([
  'fast-drain: incomplete pass context (JSON snapshot unavailable/disabled/stale/dirty)',
  'fast-drain: incomplete pass context',
  'snapshot unavailable/disabled/stale/dirty',
])('classifies incomplete context before JSON parse errors: %s', stderr => {
  expect(classifyChildFailure(stderr)).toBe('incomplete-context');
});
it('keeps nested stderr, exit status, and timeout signals in the daemon diagnosis', () => {
  const error = Object.assign(new Error('Command failed: node tick-core.mjs'), {
    stderr: Buffer.from('✗ dispatch-plan failed: query rejected\nGitHub: rate limit exceeded\n'), status: 1,
  });
  const message = childFailure(error);
  expect(message).toContain('GitHub: rate limit exceeded');
  expect(message).toContain('status=1');
  expect(childFailure(error, { singleLine: true })).toContain(' | GitHub: rate limit exceeded');
  expect(childFailure(error, { singleLine: true })).not.toContain('\n');
  expect(childFailure({ message: 'spawnSync node ETIMEDOUT', code: 'ETIMEDOUT', signal: 'SIGKILL' })).toContain('signal=SIGKILL');
  expect(childFailure({ message, stderr: error.stderr })).toBe(message);
});
