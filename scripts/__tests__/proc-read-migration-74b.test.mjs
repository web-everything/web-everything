/** @file proc-read-migration-74b.test.mjs — migrated gh/git reads (#74b): >1 MiB output reads fully; a failed read is never treated as empty. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIG = 2 * 1024 * 1024;
let dir; let savedPath; let savedThrottle;
// Fake `gh`/`git` that print a >1 MiB payload, or fail when FAKE_FAIL=1.
const fake = (body) => `#!/usr/bin/env node\nif (process.env.FAKE_FAIL === '1') { process.stderr.write('boom'); process.exit(1); }\n${body}\n`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'proc-read-74b-'));
  const gh = fake(`const a = process.argv.slice(2);
if (a[1] === 'diff') process.stdout.write('d'.repeat(${BIG}));
else if (a[0] === 'pr' && a[1] === 'list') process.stdout.write(JSON.stringify([{ body: '<!-- lane-manifest:begin -->\\n\`\`\`json\\n{"item":"74","pad":"' + 'x'.repeat(${BIG}) + '"}\\n\`\`\`\\n<!-- lane-manifest:end -->' }]));
else process.stdout.write(JSON.stringify({ body: 'b'.repeat(${BIG}), files: [{ path: 'a.md' }] }));`);
  const git = fake(`process.stdout.write(('f/' + 'p'.repeat(98) + '\\n').repeat(${Math.ceil(BIG / 101)}));`);
  writeFileSync(join(dir, 'gh'), gh); writeFileSync(join(dir, 'git'), git);
  chmodSync(join(dir, 'gh'), 0o755); chmodSync(join(dir, 'git'), 0o755);
  savedPath = process.env.PATH; savedThrottle = process.env.WE_GH_THROTTLE_CAP;
  process.env.PATH = `${dir}:${savedPath}`;
});
afterAll(() => {
  process.env.PATH = savedPath;
  if (savedThrottle === undefined) delete process.env.WE_GH_THROTTLE_CAP; else process.env.WE_GH_THROTTLE_CAP = savedThrottle;
  delete process.env.FAKE_FAIL;
  rmSync(dir, { recursive: true, force: true });
});

describe('merge-ai-prs migrated reads', () => {
  it('defaultFetchDiff reads a >1 MiB diff in full; a failed read is null, never an empty string', async () => {
    const { defaultFetchDiff } = await import('../merge-ai-prs.mjs');
    delete process.env.FAKE_FAIL;
    expect(defaultFetchDiff({ num: 1 })).toHaveLength(BIG);
    process.env.FAKE_FAIL = '1';
    expect(defaultFetchDiff({ num: 1 })).toBeNull();
  });

  it('defaultFetchLandGuardSignals parses a >1 MiB body; a failed read reports unknown files (null)', async () => {
    const { defaultFetchLandGuardSignals } = await import('../merge-ai-prs.mjs');
    delete process.env.FAKE_FAIL;
    const ok = defaultFetchLandGuardSignals({ num: 1 });
    expect(ok.body).toHaveLength(BIG);
    expect(ok.changedFiles).toEqual(['a.md']);
    process.env.FAKE_FAIL = '1';
    expect(defaultFetchLandGuardSignals({ num: 1 }).changedFiles).toBeNull();
  });
});

describe('lane-drain migrated reads', () => {
  it('readManifestFromPrBody reads a >1 MiB PR body in full; a failed read is null (unknown), not a manifest', async () => {
    const { readManifestFromPrBody } = await import('../lane-drain.mjs');
    delete process.env.FAKE_FAIL;
    expect(readManifestFromPrBody(process.cwd(), 'lane/x')?.item).toBe(74);
    process.env.FAKE_FAIL = '1';
    expect(readManifestFromPrBody(process.cwd(), 'lane/x')).toBeNull();
  });
});

describe('build-dispatch-orphan-adopt migrated reads', () => {
  it('defaultListLaneChangedFiles lists >1 MiB of paths in full; a failed read is null, never []', async () => {
    const { defaultListLaneChangedFiles } = await import('../conveyor/build-dispatch-orphan-adopt.mjs');
    delete process.env.FAKE_FAIL;
    expect(defaultListLaneChangedFiles({ lane: process.cwd() }).length).toBeGreaterThan(20000);
    process.env.FAKE_FAIL = '1';
    expect(defaultListLaneChangedFiles({ lane: process.cwd() })).toBeNull();
  });
});
