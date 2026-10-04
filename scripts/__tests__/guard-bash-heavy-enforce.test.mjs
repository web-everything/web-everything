/**
 * @file scripts/__tests__/guard-bash-heavy-enforce.test.mjs
 * @description heavy-enforce (2026-10-04): the PreToolUse(Bash) guard denies any direct vitest / npm test /
 *   check-standards.mjs run that is not under heavy-admission.mjs run --, and prints the exact queued command.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { decide } from '../guard-bash.mjs';

const queue = 'node scripts/readiness/heavy-admission.mjs run -- ';

describe('heavy-enforce — every direct test run requires admission', () => {
  it.each([
    'vitest', 'vitest run', 'vitest related scripts/a.mjs --run', 'vitest watch',
    'vitest a.test.mjs', 'npx vitest run a.test.mjs b.test.mjs',
    'npx --yes vitest run a.test.mjs', 'pnpm exec vitest run a.test.mjs',
    'node_modules/.bin/vitest run a.test.mjs', './node_modules/.bin/vitest run a.test.mjs',
    'bunx vitest run a.test.mjs', 'FOO=1 npx vitest run a.test.mjs',
    'vitest --changed', 'WE_FULL_SUITE_OK=1 vitest run',
    'npm test', 'npm t', 'npm tst', 'npm run test',
    ...['npm', 'pnpm', 'yarn', 'bun'].flatMap((runner) =>
      ['test', 't', 'tst', 'run test'].flatMap((script) =>
        [`${runner} ${script}`, `${runner} ${script} -- a.test.mjs`])),
    'node scripts/check-standards.mjs', 'node ../check-standards.mjs --local',
    'node /tmp/lane/scripts/check-standards.mjs --local --files=a.mjs',
    'WE_FULL_SUITE_OK=1 npm test -- a.test.mjs',
  ])('denies %s in an ordinary session', (cmd) => {
    expect(decide(cmd, {})).not.toBeNull();
  });

  it.each([
    ['npx vitest run scripts/__tests__/a.test.mjs', queue + 'npx vitest run scripts/__tests__/a.test.mjs'],
    ['cd /tmp/lane && npx vitest run a.test.mjs', queue + 'npx vitest run a.test.mjs'],
    ['npx vitest related scripts/a.mjs --run', queue + 'npx vitest related scripts/a.mjs --run'],
    ['npm test', 'npm run test:unit -- <test-file>'],
    ['npm test -- a.test.mjs', 'npm run test:unit -- a.test.mjs'],
    ['node scripts/check-standards.mjs --local --files=a.mjs', 'npm run check:standards -- --local --files=a.mjs'],
    ['FOO=1 npx vitest run a.test.mjs', 'FOO=1 ' + queue + 'npx vitest run a.test.mjs'],
    ['FOO="a b" WE_FULL_SUITE_OK=1 npx vitest run "a file.test.mjs"', 'FOO="a b" WE_FULL_SUITE_OK=1 ' + queue + 'npx vitest run "a file.test.mjs"'],
    // the escape-carrying queued full-suite suggestion must itself be allowed (no deny loop)
    ['WE_FULL_SUITE_OK=1 npx vitest run', 'WE_FULL_SUITE_OK=1 ' + queue + 'npx vitest run'],
  ])('prints the exact replacement for %s', (cmd, replacement) => {
    const result = decide(cmd, {});
    expect(result).toContain('`' + replacement + '`');
    expect(result).toContain('heavy-enforce');
  });

  it.each([
    queue + 'npx vitest run a.test.mjs',
    'WE_FULL_SUITE_OK=1 ' + queue + 'npx vitest run',
    'node /tmp/lane/scripts/readiness/heavy-admission.mjs run -- npx vitest run a.test.mjs',
    'node scripts/readiness/heavy-admission.mjs run --container -- npx vitest run a.test.mjs',
    'npm run test:unit -- a.test.mjs', 'npm run check:standards',
    'npm run check:standards -- --local --files=x', 'npm run test:soak',
    'npm run test:integration:vitest', 'node scripts/verify-lane.mjs run',
    'node scripts/codex-direct-task.mjs run --gate=standards',
    'echo "npx vitest run"', 'grep -n vitest file', 'git commit -m "use npx vitest here"',
    'rg check-standards.mjs', 'cat scripts/check-standards.mjs',
    'node --check scripts/check-standards.mjs', 'node -c scripts/check-standards.mjs',
    ...['--version', '-v', '--help', '-h', 'list', 'init', 'bench'].map((arg) => `npx vitest ${arg}`),
  ])('allows %s', (cmd) => expect(decide(cmd, {})).toBeNull());

  it('keeps full-suite precedence and queues its targeted advice', () => {
    const result = decide('npx vitest run', {});
    expect(result).toContain('bare FULL-SUITE');
    expect(result).toContain('For one or two files: `' + queue + 'npx vitest run <file>`');
  });

  it('the actual PreToolUse hook denies a direct targeted run with its replacement', () => {
    const out = spawnSync('node', [resolve('scripts/guard-bash.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npx vitest run x.test.mjs' }, cwd: tmpdir() }),
      encoding: 'utf8', env: { ...process.env, WE_DISPATCH_KIND: '' },
    });
    expect(out.status).toBe(0);
    const decision = JSON.parse(out.stdout).hookSpecificOutput;
    expect(decision.permissionDecision).toBe('deny');
    expect(decision.permissionDecisionReason).toContain('`' + queue + 'npx vitest run x.test.mjs`');
  });
});
