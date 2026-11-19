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
  expect(findVitestWatchInvocations("admittedArgv('npx', ['vitest', 'run', ...files]);")).toHaveLength(1);
  expect(findVitestWatchInvocations("execSync('npx vitest');")).toHaveLength(1);
  expect(findVitestWatchInvocations('# comment vitest\nnpx vitest run\n', 'scripts/a.sh')).toEqual([]);
});
it('refuses unreadable syntax and commands beyond the cost bound', () => {
  expect(findVitestWatchInvocations('spawn(')).toHaveLength(1);
  expect(findVitestWatchInvocations(null)).toHaveLength(1);
  expect(vitestWatchCommands('x'.repeat(1024 * 1024 + 1))).toHaveLength(1);
});

it.each([
  "const args = ['vitest']; function other() { const args = ['vitest', 'run']; } spawn('npx', args);",
  "const args = ['vitest']; { const args = ['vitest', 'run']; } spawn('npx', args);",
  "const args = ['vitest', 'run']; function launch(args) { spawn('npx', args); }",
  "const args = ['vitest', 'run']; { let args; spawn('npx', args); }",
  "let args = ['vitest', 'run']; function launch() { var args; spawn('npx', args); }",
])('resolves lexical bindings without shadowing bypasses: %s', source => {
  expect(findVitestWatchInvocations(source)).toHaveLength(1);
});
it.each([
  'args.pop();', 'args.shift();', 'args.splice(1, 1);',
  "args = ['vitest'];", "args[1] = '--watch';", "args.length = 1;",
  "args.push('--watch');", "const alias = args; alias.pop();", 'unknown(args);', '({ value: args } = source);', 'for (args of source) {}',
])('refuses mutated or escaped argv: %s', mutation => {
  expect(findVitestWatchInvocations(`let args = ['vitest', 'run']; ${mutation} spawn('npx', args);`)).toHaveLength(1);
});
it('refuses mutation after a call as well as unresolved executable/argv and dynamic templates', () => {
  for (const source of ["const args = ['vitest', 'run']; spawn('npx', args); args.push('--watch');",
    "spawn(command, ['vitest', 'run']);", "spawn('npx', args);", "execSync(`npx vitest ${mode}`);"]) {
    expect(findVitestWatchInvocations(source)).toHaveLength(1);
  }
});
it('accepts immutable bindings in independent scopes and literal spread arrays', () => {
  expect(findVitestWatchInvocations("const args = ['vitest', 'run']; { const args = ['vitest', '--run']; spawn('npx', args); } spawn('npx', args);")).toEqual([]);
  expect(findVitestWatchInvocations("const files = ['x.test.mjs']; spawn('npx', ['vitest', 'run', ...files]);")).toEqual([]);
});
