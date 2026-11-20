import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAuditedTipGate, revokedAppliedTips } from '../audited-tip.mjs';
import { readReadyCandidateStrict, readyCandidatePath, writeRebuildState, rebuildStatePath } from '../state.mjs';
import { overlayFilePath } from '../../daemon-overlays.mjs';
import { REBUILD_IDENTITY_ENV } from '../shared.mjs';

const ref = 'lane/pin', sha = 'a'.repeat(40), pin = 'b'.repeat(40), head = 'c'.repeat(40), main = 'd'.repeat(40);
const invalid = ['arbitrary', 'e'.repeat(40), pin.toUpperCase(), 'b'.repeat(39), 'b'.repeat(41), true, 7, null, {}, [pin]];
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(pinnedFrom = pin) {
  const root = mkdtempSync(join(tmpdir(), 'rebuild-pin-')); roots.push(root);
  const env = { WE_DAEMON_STATE_DIR: root, WE_DAEMON_OVERLAY_DIR: root,
    WE_FIX_READY_PATH: join(root, 'audited.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(root, 'platform.json'),
    WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only' };
  writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
  writeFileSync(env.WE_FIX_READY_PATH, JSON.stringify({ ref, sha: pin, tests: 'green', audit: 'NOT WEAKENED' }) + '\n');
  writeFileSync(overlayFilePath(root, env), JSON.stringify({ clone: root, overlays: [{ ref, pr: 42 }] }));
  const ready = { prevHead: head, tree: 'tree', passedAt: new Date(0).toISOString(), kind: 'candidate', forced: false,
    adopt: { finalSha: 'target', inputsKey: 'inputs', mainSha: main, applied: [{ ref, pr: 42, sha, pinnedFrom }] } };
  writeFileSync(readyCandidatePath(root, env), JSON.stringify(ready));
  // All history proofs succeed, isolating the independent audit membership requirement.
  const run = vi.fn(args => ({ status: 0, stdout: args[0] === 'log'
    ? `${main} ${sha}\t${REBUILD_IDENTITY_ENV.GIT_COMMITTER_EMAIL}\tdaemon-rebuild: merge overlay ${ref} (PR #42) onto main\n`
    : args.includes('HEAD') ? head : typeof pinnedFrom === 'string' ? pinnedFrom : pin }));
  return { root, env, ready, run };
}

describe('pin exemptions require exact audited membership for the ref', () => {
  for (const held of [false, true]) {
    it.each(invalid)(`refuses invalid/unaudited pin %j (held=${held}) and consults the tip audit`, pinnedFrom => {
      const f = fixture(pinnedFrom);
      const gate = vi.fn(makeAuditedTipGate(f.env));
      expect(revokedAppliedTips({ applied: f.ready.adopt.applied, auditedTip: gate, auditAdopted: [ref],
        held: held ? [{ detail: { ref, newTip: sha } }] : [] })).toEqual([ref]);
      expect(gate).toHaveBeenCalledWith(ref, sha);
    });
  }
  it('honours a lowercase 40-hex pin accepted by the audit gate', () => {
    const f = fixture();
    const gate = vi.fn(makeAuditedTipGate(f.env));
    expect(revokedAppliedTips({ applied: f.ready.adopt.applied, auditedTip: gate, auditAdopted: [ref],
      held: [{ detail: { ref, newTip: sha } }] })).toEqual([]);
    expect(gate).toHaveBeenCalledWith(ref, pin);
    expect(gate).not.toHaveBeenCalledWith(ref, sha);
  });
  it.each(['other ref', 'revoked'])('does not accept evidence for %s', kind => {
    const f = fixture();
    const row = { ref: kind === 'other ref' ? 'lane/other' : ref, sha: pin, tests: 'green', audit: 'NOT WEAKENED' };
    writeFileSync(f.env.WE_FIX_READY_PATH, [row, ...(kind === 'revoked' ? [{ ...row, tests: 'red' }] : [])].map(JSON.stringify).join('\n'));
    expect(revokedAppliedTips({ applied: f.ready.adopt.applied, auditedTip: makeAuditedTipGate(f.env), auditAdopted: [ref] })).toEqual([ref]);
    expect(() => readReadyCandidateStrict(f.root, f.env, readFileSync, { run: f.run })).toThrow();
  });
});

describe('strict ready pins cannot downgrade audit or history proof', () => {
  it.each(invalid)('refuses pin %j even if the caller requests strictPins:false', pinnedFrom => {
    const f = fixture(pinnedFrom);
    for (const options of [{ run: f.run }, { run: f.run, strictPins: false }]) {
      expect(() => readReadyCandidateStrict(f.root, f.env, readFileSync, options)).toThrow();
    }
  });
  it('accepts a legacy ready record with a proven registered, adopted and audited pin', () => {
    const f = fixture();
    expect(readReadyCandidateStrict(f.root, f.env, readFileSync, { run: f.run })).toEqual(f.ready);
  });
});

function resetFixture(stage = 'inProgress') {
  const f = fixture();
  f.ready.adopt.finalSha = 'f'.repeat(40);
  writeFileSync(readyCandidatePath(f.root, f.env), JSON.stringify(f.ready));
  const prior = f.run.getMockImplementation();
  f.run.mockImplementation(args => args.includes('HEAD') ? { status: 0, stdout: f.ready.adopt.finalSha } : prior(args));
  const { finalSha, ...plan } = f.ready.adopt;
  const record = stage === 'inProgress'
    ? { ...plan, prevHead: head, target: finalSha, verified: true, pid: 1, host: 'host', startedAt: f.ready.passedAt }
    : { ...plan, head: finalSha, at: f.ready.passedAt };
  const state = { [stage]: record };
  writeRebuildState(f.root, state, f.env);
  return { ...f, state, record };
}

it.each(['inProgress', 'adopted'])('strict pin proof accepts the production post-reset %s transition', stage => {
  const f = resetFixture(stage);
  expect(readReadyCandidateStrict(f.root, f.env, readFileSync, { run: f.run })).toEqual(f.ready);
});

it.each([
  ['inProgress', 'prevHead', 'other'], ['inProgress', 'target', 'other'], ['inProgress', 'verified', false],
  ['inProgress', 'inputsKey', 'other'], ['inProgress', 'mainSha', 'other'], ['inProgress', 'applied', []],
  ['adopted', 'head', 'other'], ['adopted', 'inputsKey', 'other'], ['adopted', 'mainSha', 'other'], ['adopted', 'applied', []],
])('strict pin proof refuses a mismatched post-reset %s.%s', (stage, key, value) => {
  const f = resetFixture(stage);
  f.record[key] = value;
  writeRebuildState(f.root, f.state, f.env);
  expect(() => readReadyCandidateStrict(f.root, f.env, readFileSync, { run: f.run })).toThrow('Unproven ready pin transition');
});

it.each(['missing', 'corrupt', 'wrong-type', 'revoked', 'other-head'])('strict post-reset pin proof refuses %s evidence', fault => {
  const f = resetFixture();
  if (fault === 'missing') rmSync(rebuildStatePath(f.root, f.env));
  if (fault === 'corrupt') writeFileSync(rebuildStatePath(f.root, f.env), '{corrupt');
  if (fault === 'wrong-type') {
    f.record.verified = 'true';
    writeRebuildState(f.root, f.state, f.env);
  }
  if (fault === 'revoked') writeFileSync(f.env.WE_FIX_READY_PATH, JSON.stringify({ ref, sha: pin, tests: 'red' }) + '\n');
  if (fault === 'other-head') {
    const prior = f.run.getMockImplementation();
    f.run.mockImplementation(args => args.includes('HEAD') ? { status: 0, stdout: '9'.repeat(40) } : prior(args));
  }
  expect(() => readReadyCandidateStrict(f.root, f.env, readFileSync, { run: f.run })).toThrow();
});
