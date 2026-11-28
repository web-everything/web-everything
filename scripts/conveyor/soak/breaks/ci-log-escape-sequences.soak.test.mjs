import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import b, { collect } from './ci-log-escape-sequences.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
defineBreakTest(b);

it('collects evidence and detects the fix when TMPDIR is unset', async () => {
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP };
  // Keep scratch under the task's temporary root while exercising Node's portable fallback.
  process.env.TMP = tmpdir();
  delete process.env.TMPDIR;
  try {
    expect(b.judge(await b.run({ sourceRoot: ROOT }))).toEqual([]);
    expect(b.fixPresent(ROOT)).toBe(true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

it('requires the landed raw-log transport behavior in all collector reader modes', () => {
  expect(b.fixPresent(ROOT)).toBe(true);
});

it.each(['plain', 'facts-off', 'facts-on'])('reproduces log-unreadable without the flag and refuses unattributed evidence with it (%s)', async mode => {
  const broken = await collect(ROOT, { mode, stripFlag: true });
  expect(broken).toMatchObject({ logReads: 1, rejected: 1,
    evidence: { eligible: false, reason: 'log-unreadable' } });
  const fixed = await collect(ROOT, { mode });
  expect(fixed).toMatchObject({ logReads: 1, rejected: 0,
    evidence: { eligible: false, reason: 'timeout-evidence:unattributed-job-log' } });
});

it('fails closed on missing evidence or a regression in either raw-log reader', async () => {
  expect(b.judge({ cases: [] })).toHaveLength(6);
  const report = await b.run({ sourceRoot: ROOT });
  expect(b.judge(report)).toEqual([]);
  for (const row of report.cases.filter(c => !c.stripFlag)) {
    expect(b.judge({ cases: report.cases.map(c => c === row
      ? { ...c, rejected: 1, evidence: { eligible: false, reason: 'log-unreadable' } } : c) })).toHaveLength(1);
  }
});
