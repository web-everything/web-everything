import { expect, it } from 'vitest';
import { findVitestWatchInvocations, vitestWatchCommands } from '../vitest-watch-lint.mjs';
it.each(['vitest', 'npx vitest x.test.mjs', 'CI=1 vitest --coverage', 'node node_modules/vitest/vitest.mjs', 'node scripts/readiness/heavy-admission.mjs run -- npx vitest', 'sh -c "vitest"', 'vitest run --watch'])('flags watch-capable command %s', command => {
  expect(vitestWatchCommands(command)).not.toHaveLength(0);
});
it.each(['vitest run', 'npx vitest related a --run', 'vitest --watch=false', 'echo vitest', '# vitest', 'node tool.mjs --label vitest'])('accepts terminating invocations or noncommands %s', command => {
  expect(vitestWatchCommands(command)).toEqual([]);
});
it('scans real spawn sites and variable argv, not prose/comments/fixtures', () => {
  expect(findVitestWatchInvocations(`// spawn('vitest');
    const prose = 'npx vitest'; const fixture = "spawn('vitest')";
    console.log('vitest');`)).toEqual([]);
  expect(findVitestWatchInvocations("const args = ['vitest']; spawn('npx', args);")).toHaveLength(1);
  expect(findVitestWatchInvocations("admittedArgv('npx', ['vitest', 'run', ...files]);")).toEqual([]);
  expect(findVitestWatchInvocations("execSync('npx vitest');")).toHaveLength(1);
  expect(findVitestWatchInvocations('# comment vitest\nnpx vitest run\n', 'scripts/a.sh')).toEqual([]);
});
it('refuses unreadable syntax and commands beyond the cost bound', () => {
  expect(findVitestWatchInvocations('spawn(')).toHaveLength(1);
  expect(findVitestWatchInvocations(null)).toHaveLength(1);
  expect(vitestWatchCommands('x'.repeat(1024 * 1024 + 1))).toHaveLength(1);
});
