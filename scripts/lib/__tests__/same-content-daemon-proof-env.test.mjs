import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeAuditedTipGate } from '../daemon-rebuild/audited-tip.mjs';
import { netDiffFingerprint } from '../net-diff-fingerprint.mjs';
import { sameContentRepo } from './fixtures/same-content-repo.mjs';

function protectedCalls(calls) {
  expect(calls.length).toBeGreaterThan(0);
  for (const { env } of calls) {
    expect(env.GIT_GRAFT_FILE).toBe('/dev/null');
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe('1');
    const pins = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) =>
      [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    expect(pins.filter(([key]) => key === 'core.commitGraph').at(-1)).toEqual(['core.commitGraph', 'false']);
  }
}
it.each([false, true])('audited-tip hardens only carry proof IO; unreadable=%s refuses', unreadable => {
  const f = sameContentRepo('clean'), calls = [];
  const ref = 'lane/example', findings = ['code.js issue'];
  const env = { ...f.env, HOME: f.repo, WE_FIX_READY_PATH: join(f.repo, 'ready.jsonl'),
    WE_PLATFORM_PREFERENCES_FILE: join(f.repo, 'platform.json'), WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only',
    GIT_GRAFT_FILE: 'forged-grafts', GIT_NO_REPLACE_OBJECTS: '0', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.commitGraph', GIT_CONFIG_VALUE_0: 'true' };
  let audits = 0;
  try {
    f.write('ready.jsonl', JSON.stringify({ ref, sha: f.to, tests: 'green', audit: 'WEAKENED',
      auditRuling: 'R12', auditDisclosed: findings }) + '\n');
    f.write('platform.json', JSON.stringify({ prototypeLoad: { ruledWeakened: [
      { ref, sha: f.from, ruling: 'R12', findings },
    ] } }));
    const gate = makeAuditedTipGate(env, { repo: f.repo,
      exec(file, args, options) {
        calls.push(options);
        if (unreadable) throw Error('history unavailable');
        return execFileSync(file, args, options);
      },
      canonicalAudit(facts) {
        audits++;
        expect(netDiffFingerprint(f.repo, 'origin/main', f.to, { exec: facts.exec, env })).toBeTruthy();
        return { ok: true, record: { findings } };
      },
    });
    expect(gate(ref, f.to)).toBe(!unreadable);
    expect(audits).toBe(unreadable ? 0 : 1);
    protectedCalls(calls);
  } finally { f.cleanup(); }
});

it('merge net-diff proof disables forged history even with hostile ambient config', async () => {
  const { computeNetDiffText } = await import('../../merge-ai-prs.mjs');
  const { execFileSync } = await import('node:child_process');
  const f = sameContentRepo('clean'), calls = [];
  const oldGraft = process.env.GIT_GRAFT_FILE;
  const oldReplace = process.env.GIT_NO_REPLACE_OBJECTS;
  process.env.GIT_GRAFT_FILE = 'forged-grafts';
  process.env.GIT_NO_REPLACE_OBJECTS = '0';
  try {
    const result = computeNetDiffText({ rev: f.from, exec(file, args, options) {
      calls.push(options);
      return args[0] === 'fetch' ? '' : execFileSync(file, ['-C', f.repo, ...args], options);
    } });
    expect(result.scored).toBe(true);
    protectedCalls(calls);
  } finally {
    if (oldGraft === undefined) delete process.env.GIT_GRAFT_FILE; else process.env.GIT_GRAFT_FILE = oldGraft;
    if (oldReplace === undefined) delete process.env.GIT_NO_REPLACE_OBJECTS; else process.env.GIT_NO_REPLACE_OBJECTS = oldReplace;
    f.cleanup();
  }
}, 30000);
