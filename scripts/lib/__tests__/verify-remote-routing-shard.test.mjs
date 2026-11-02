import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { phaseAdmissionPlan, shouldConfirmRemoteRed, SHARD_RUN_SCRIPT } from '../verify-remote-routing.mjs';
it('a wrapper executing from an apostrophe path owns admission under every decision', () => {
  const directory = mkdtempSync(join(tmpdir(), "verify-executing-checkout's-"));
  try {
    const sourceUrl = pathToFileURL(resolve('scripts/lib/verify-remote-routing.mjs'));
    const source = readFileSync(sourceUrl, 'utf8').replace(/from '(\.\.?\/[^']+)'/g,
      (_, specifier) => `from ${JSON.stringify(new URL(specifier, sourceUrl).href)}`);
    const copy = join(directory, 'verify-remote-routing.mjs');
    writeFileSync(copy, source);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { phaseAdmissionPlan, SHARD_RUN_SCRIPT } from ${JSON.stringify(pathToFileURL(copy).href)};
const quote = value => "'" + value.replaceAll("'", "'\\\\''") + "'";
const command = 'node ' + quote(SHARD_RUN_SCRIPT) + ' --shards=2 --parallel=2 --budget-ms=1000 -- npx vitest run a b';
process.stdout.write(JSON.stringify([undefined, { remote: true }, { remote: false }].map(decision => phaseAdmissionPlan({ command, decision }))));
`], { encoding: 'utf8', timeout: 10000 });
    expect(child.status, child.stderr).toBe(0);
    for (const plan of JSON.parse(child.stdout)) {
      expect(plan).toMatchObject({ takeLocalSlot: false, setHeld: false, shardWrapper: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it('shard wrappers own admission and confirmation under every decision, including chains', () => {
  for (const decision of [undefined, { remote: true }, { remote: false }]) for (const suffix of ['']) {
  for (const head of [`node '${SHARD_RUN_SCRIPT}'`]) {
    const command = head + ' --shards=2 --parallel=2 --budget-ms=1000 -- npx vitest run a b' + suffix;
    const plan = phaseAdmissionPlan({ command, decision });
    expect(plan).toEqual({ command, takeLocalSlot: false, setHeld: false, shardWrapper: true });
    expect(shouldConfirmRemoteRed({ plan, exitCode: 1, ranOn: { location: 'remote', failureLocation: 'remote' } })).toBe(false);
  }}
});
it('a wrapper chained with raw vitest segments keeps ordinary admission', () => {
  const command = `node '${SHARD_RUN_SCRIPT}' --shards=2 --parallel=2 --budget-ms=1 -- npx vitest run a && npx vitest run scan`;
  expect(phaseAdmissionPlan({ command, decision: { remote: true } }).shardWrapper).toBeUndefined();
});
it('shell metacharacters after the wrapper defeat wrapper detection', () => {
  for (const tail of ['; npx vitest run b', ' | cat', ' $(id)', '\nnpx vitest run b']) {
    const command = `node '${SHARD_RUN_SCRIPT}' --shards=1 --parallel=1 --budget-ms=1 -- npx vitest run 'a b.test.mjs'` + tail;
    expect(phaseAdmissionPlan({ command, decision: { remote: true } }).shardWrapper).toBeUndefined();
  }
  const quoted = `node '${SHARD_RUN_SCRIPT}' --shards=1 --parallel=1 --budget-ms=1 -- npx vitest run 'a;b.test.mjs'`;
  expect(phaseAdmissionPlan({ command: quoted, decision: { remote: true } }).shardWrapper).toBe(true);
});
it('a lookalike wrapper elsewhere does not bypass admission', () => {
  const command = "node '/tmp/verify-shard-run.mjs' --shards=1 --parallel=1 --budget-ms=1 -- npx vitest run a";
  expect(phaseAdmissionPlan({ command, decision: { remote: false } }).shardWrapper).toBeUndefined();
});
it('ordinary local and remote plans stay unchanged', () => {
  expect(phaseAdmissionPlan({ command: 'npx vitest run a', decision: { remote: false } })).toEqual({ command: 'npx vitest run a', takeLocalSlot: true, setHeld: true });
  expect(shouldConfirmRemoteRed({ plan: { takeLocalSlot: false }, exitCode: 1, ranOn: { location: 'remote', failureLocation: 'remote' } })).toBe(true);
});
