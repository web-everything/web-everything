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
    // alternate spellings of the same runs (advisory finding on #3932): runner flags before the subcommand,
    // a pinned vitest version, exec wrappers, vitest's own entry script, separate-valued node options
    'pnpm vitest run a.test.mjs', 'yarn vitest run a.test.mjs', 'bun vitest run a.test.mjs',
    'npm -s test', 'npm --silent test -- a.test.mjs', 'npm --prefix . test', 'npm -w x test -- a.test.mjs',
    'npx vitest@latest run a.test.mjs', 'npx -y vitest@2 run a.test.mjs',
    'timeout 300 npx vitest run a.test.mjs', 'timeout -s KILL 300 npx vitest run a.test.mjs',
    'nice -n 5 npx vitest run a.test.mjs', 'nice -5 npx vitest run a.test.mjs',
    'node node_modules/vitest/vitest.mjs run a.test.mjs',
    // other direct entry points of the same vitest install (advisory finding on #3932, round 2)
    'node ./node_modules/vitest/dist/cli.js run a.test.mjs', 'node node_modules/vitest/dist/cli.js a.test.mjs',
    'node node_modules/.bin/vitest run a.test.mjs', 'node ../node_modules/.bin/vitest run a.test.mjs',
    'node --title standards scripts/check-standards.mjs --local',
    'node --max-old-space-size 4096 scripts/check-standards.mjs',
    'node --env-file .env scripts/check-standards.mjs',
    'node --require ./setup.js scripts/check-standards.mjs',
  ])('denies %s in an ordinary session', (cmd) => {
    expect(decide(cmd, {})).not.toBeNull();
  });

  it.each([
    ['npx vitest run scripts/__tests__/a.test.mjs', queue + 'npx vitest run scripts/__tests__/a.test.mjs'],
    ['cd /tmp/lane && npx vitest run a.test.mjs', queue + 'npx vitest run a.test.mjs'],
    ['npx vitest related scripts/a.mjs --run', queue + 'npx vitest related scripts/a.mjs --run'],
    // the escape-carrying whole-suite run names a pasteable command (no `<test-file>` placeholder)
    ['WE_FULL_SUITE_OK=1 npm test', 'WE_FULL_SUITE_OK=1 npm run test:unit'],
    ['npm test -- a.test.mjs', 'npm run test:unit -- a.test.mjs'],
    ['npm -s test -- a.test.mjs', 'npm run test:unit -- a.test.mjs'],
    ['pnpm vitest run a.test.mjs', queue + 'pnpm vitest run a.test.mjs'],
    // a watch/dev process would hold an admission slot until killed: queue a one-shot `run` instead
    ['vitest watch a.test.mjs', queue + 'vitest run a.test.mjs'],
    ['npx vitest dev a.test.mjs', queue + 'npx vitest run a.test.mjs'],
    // watch spelled as a FLAG (`--watch` / `-w` / `--watch=true`) is the same long-lived process: drop it and queue a one-shot run
    ['npx vitest --watch a.test.mjs', queue + 'npx vitest run a.test.mjs'],
    ['vitest -w a.test.mjs', queue + 'vitest run a.test.mjs'],
    ['npx vitest run --watch a.test.mjs', queue + 'npx vitest run a.test.mjs'],
    ['npx vitest --watch=true a.test.mjs', queue + 'npx vitest run a.test.mjs'],
    ['npx vitest related a.mjs --watch', queue + 'npx vitest related a.mjs --run'],
    ['npm test -- --watch a.test.mjs', 'npm run test:unit -- a.test.mjs'],
    ['npm test -- -w a.test.mjs', 'npm run test:unit -- a.test.mjs'],
    ['npm test -- a.test.mjs --watch', 'npm run test:unit -- a.test.mjs'],
    // vitest's other direct entry points keep their own spelling inside the queue
    ['node ./node_modules/vitest/dist/cli.js run a.test.mjs', queue + 'node ./node_modules/vitest/dist/cli.js run a.test.mjs'],
    ['node node_modules/.bin/vitest run a.test.mjs', queue + 'node node_modules/.bin/vitest run a.test.mjs'],
    // npm workspace / prefix selection must survive into the replacement (it picks WHICH package's tests run)
    ['npm -w x test -- a.test.mjs', 'npm -w x run test:unit -- a.test.mjs'],
    ['npm --workspace=x test -- a.test.mjs', 'npm --workspace=x run test:unit -- a.test.mjs'],
    ['npm --prefix x test -- a.test.mjs', 'npm --prefix x run test:unit -- a.test.mjs'],
    ['npm -C x -s test -- a.test.mjs', 'npm -C x run test:unit -- a.test.mjs'],
    ['npm --workspaces test -- a.test.mjs', 'npm --workspaces run test:unit -- a.test.mjs'],
    ['npm test -w x -- a.test.mjs', 'npm -w x run test:unit -- a.test.mjs'],
    ['npm -w x test -- related a.mjs --run', queue + 'npm -w x exec -- vitest related a.mjs --run'],
    // …also when there is no `--` (npm still parses every option), so the package name never becomes a file filter
    ['npm test -w x a.test.mjs', 'npm -w x run test:unit -- a.test.mjs'],
    ['npm test --workspace=x a.test.mjs', 'npm --workspace=x run test:unit -- a.test.mjs'],
    ['npm test --prefix x a.test.mjs', 'npm --prefix x run test:unit -- a.test.mjs'],
    ['npm test -ws a.test.mjs', 'npm -ws run test:unit -- a.test.mjs'],
    ['npm test -w x related a.mjs', queue + 'npm -w x exec -- vitest related a.mjs'],
    // other spellings of the watch flag, and a stray `true`/`false` value must not become a file filter
    ['npx vitest --watch=1 a.test.mjs', queue + 'npx vitest run a.test.mjs'],
    ['npx vitest --watch=TRUE a.test.mjs', queue + 'npx vitest run a.test.mjs'],
    ['npx vitest --watch true a.test.mjs', queue + 'npx vitest run a.test.mjs'],
    ['npx vitest --watch false a.test.mjs', queue + 'npx vitest run a.test.mjs'],
    // a value flag's own value is a pattern even when it reads like a watch flag
    ['npx vitest run -t -w a.test.mjs', queue + 'npx vitest run -t -w a.test.mjs'],
    // a forwarded vitest subcommand has no test:unit equivalent (it would become a filename filter after `vitest run`)
    ['npm test -- related scripts/a.mjs --run --passWithNoTests', queue + 'npx vitest related scripts/a.mjs --run --passWithNoTests'],
    ['npm test related scripts/a.mjs', queue + 'npx vitest related scripts/a.mjs'],
    ['FOO=1 npm test -- related scripts/a.mjs', 'FOO=1 ' + queue + 'npx vitest related scripts/a.mjs'],
    ['npm test -- list', queue + 'npx vitest list'],
    ['npm test -- watch a.test.mjs', 'npm run test:unit -- a.test.mjs'],
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

  it('the queued replacement for `npm test -- related …` is itself allowed (no deny loop)', () => {
    const suggested = decide('npm test -- related scripts/a.mjs --run --passWithNoTests', {}).match(/Use: `([^`]+)`/)[1];
    expect(suggested).toBe(queue + 'npx vitest related scripts/a.mjs --run --passWithNoTests');
    expect(decide(suggested, {})).toBeNull();
  });

  // Every deny message's `Use: \`…\`` suggestion must itself be allowed — the whole deny-loop class, not one row.
  it.each([
    'npx vitest run a.test.mjs', 'vitest watch a.test.mjs', 'npx vitest dev a.test.mjs',
    'pnpm vitest run a.test.mjs', 'timeout 300 npx vitest run a.test.mjs', 'nice -n 5 npx vitest run a.test.mjs',
    'node node_modules/vitest/vitest.mjs run a.test.mjs', 'npm -s test -- a.test.mjs', 'npm test',
    'npm --prefix . test -- a.test.mjs', 'WE_FULL_SUITE_OK=1 npm test', 'WE_FULL_SUITE_OK=1 npx vitest run',
    'FOO=1 npx vitest@2 run a.test.mjs', 'node --title x scripts/check-standards.mjs --local',
    // whole-suite `npm test` spellings the full-suite arm does not parse: its message, never `npm run test:unit`
    'npm -s test', 'npm -s t', 'timeout 5 npm test', 'npm --prefix x --silent test', 'npm -w x test',
    'npm --workspace=x test', 'npm -C x test',
    // flag-only tails select the WHOLE suite whichever way the flag is spelled (boolean, `=`, separate value)
    'npm -s test -- --coverage', 'npm -s test -- --reporter=dot', 'npm -s test -- --reporter dot',
    'npm -s test -- --bail 1', 'timeout 5 npm test -- --coverage', 'npm -w x test -- --coverage',
    // watch spelled as a flag, scope flags kept, and the other direct vitest entry points
    'npx vitest --watch a.test.mjs', 'vitest -w a.test.mjs', 'npx vitest run --watch a.test.mjs',
    'npx vitest related a.mjs --watch', 'npm test -- --watch a.test.mjs', 'npm test -- -w a.test.mjs',
    'npm -w x test -- a.test.mjs', 'npm --prefix x test -- a.test.mjs', 'npm -C x test -- a.test.mjs',
    'npm test -w x -- a.test.mjs', 'npm -w x test -- related a.mjs --run',
    'node ./node_modules/vitest/dist/cli.js run a.test.mjs', 'node node_modules/.bin/vitest run a.test.mjs',
    'npm test -w x a.test.mjs', 'npm test --prefix x a.test.mjs', 'npm test -w x related a.mjs',
    'npx vitest --watch=1 a.test.mjs', 'npx vitest --watch true a.test.mjs',
  ])('the suggestion for the denied `%s` is itself allowed (no deny loop)', (cmd) => {
    const reason = decide(cmd, {});
    expect(reason).not.toBeNull();
    for (const [, suggested] of reason.matchAll(/Use: `([^`]+)`/g)) {
      expect(suggested, suggested).not.toMatch(/<[^>]+>/); // a literal placeholder cannot be pasted
      expect(decide(suggested, {}), suggested).toBeNull();
    }
  });

  // No suggestion may itself be a long-lived watch process holding one of the 2 admission slots.
  it.each([
    'vitest watch a.test.mjs', 'npx vitest dev a.test.mjs', 'npx vitest --watch a.test.mjs', 'vitest -w a.test.mjs',
    'npx vitest run --watch a.test.mjs', 'npx vitest --watch=true a.test.mjs', 'npx vitest related a.mjs --watch',
    'npm test -- --watch a.test.mjs', 'npm test -- -w a.test.mjs', 'npm test -- a.test.mjs --watch',
    'npm test -- watch a.test.mjs', 'npm -w x test -- --watch a.test.mjs',
  ])('the suggestion for `%s` contains no watch-mode token', (cmd) => {
    const reason = decide(cmd, {});
    expect(reason).not.toBeNull();
    const suggested = [...reason.matchAll(/Use: `([^`]+)`/g)].map((m) => m[1]);
    expect(suggested.length).toBeGreaterThan(0);
    for (const s of suggested) {
      // `-w` is npm's own workspace flag in an `npm …` suggestion, vitest's watch flag everywhere else
      const watchToken = s.startsWith('npm ') ? /^(?:watch|dev|--watch(?:=true)?)$/ : /^(?:watch|dev|--watch(?:=true)?|-w)$/;
      for (const tok of s.split(/\s+/)) expect(tok, s).not.toMatch(watchToken);
    }
  });

  // vitest's entry scripts behind `node` are the same bare whole-suite run: the full-suite message, not a queued full run
  it.each([
    'node node_modules/vitest/dist/cli.js', 'node node_modules/vitest/dist/cli.js run', 'node node_modules/vitest/vitest.mjs run --coverage',
    'node node_modules/.bin/vitest --coverage', 'node node_modules/.bin/vitest run --coverage',
  ])('denies the bare whole-suite `%s` with the full-suite message', (cmd) => {
    expect(decide(cmd, {})).toContain('bare FULL-SUITE');
  });

  it.each(['node node_modules/vitest/package.json', 'node node_modules/vitest/dist/chunks/foo.js'])(
    'does not treat `%s` (not a vitest entry script) as a test run', (cmd) => expect(decide(cmd, {})).toBeNull());

  it('a flag-only npm test run gets the full-suite message, not a replacement that is itself denied', () => {
    const result = decide('npm -s test -- --coverage', {});
    expect(result).toContain('bare FULL-SUITE');
    expect(result).not.toContain('heavy-enforce:');
  });

  it('keeps full-suite precedence and queues its targeted advice', () => {
    const result = decide('npx vitest run', {});
    expect(result).toContain('bare FULL-SUITE');
    expect(result).toContain('For one or two files: `' + queue + 'npx vitest run <file>`');
  });

  it('a bare full-suite deny appends no second, self-denying replacement', () => {
    for (const cmd of ['npx vitest run', 'npm test', 'npm run test:unit', 'vitest', 'npm -s test', 'timeout 5 npm test']) {
      expect(decide(cmd, {}), cmd).not.toContain('heavy-enforce:');
    }
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
