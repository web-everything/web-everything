// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sandbox from '../../lib/agy-sandbox.mjs';
import { AGY_FIX_PROVIDER } from '../agy-fix-provider.mjs';
import { runFixCli } from '../fix-run.mjs';

afterEach(() => vi.restoreAllMocks());

// Only the worker boundary is simulated; the real launcher owns lane acquisition,
// output checks, staging, evidence, push and review re-arm for both providers.
async function fixture(provider, paths = ['docs/guide.md'], scope = 'docs/guide.md') {
  const root = mkdtempSync(join(tmpdir(), 'gemini-fix-contract-'));
  const initial = 'a'.repeat(40), updated = 'b'.repeat(40);
  let head = initial, ran = false;
  const calls = [], errors = [];
  const runTask = vi.fn(async () => { ran = true; return { status: 'ok', finalMessage: 'fixed', stdout: 'trace' }; });
  const stageEntry = vi.fn(() => ({ mode: '100644', data: Buffer.from('fixed\n') }));
  const persistEvidence = vi.fn();
  const run = vi.fn((cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gh') return JSON.stringify({ title: 'T', body: 'B', headRefOid: initial });
    if (args.includes('acquire')) return JSON.stringify({ path: join(root, 'lane-1'), holder: 'fixture' });
    if (args.includes('--absolute-git-dir')) return root;
    if (args.includes('commit')) head = updated;
    if (args.includes('--verify') && args.at(-1) === `${head}^1`) return initial;
    if (args.includes('rev-parse') && args.includes('HEAD')) return head;
    if (args.includes('status')) return ran ? paths.map(p => ` M ${p}\0`).join('') : '';
    return '';
  });
  const argv = ['--pr=7', '--session=fix-7', '--ref=lane/fix', '--prompt-file=brief.md',
    `--provider=${provider}`, '--task-kind=doc-fix', '--size=1', `--scope=we:${scope}`];
  // The production hold remains tested below; this seam exercises the dormant
  // adapter contract without authorizing a real agy process.
  vi.spyOn(sandbox, 'assertAgyBuildConfinement').mockImplementation(() => {});
  try {
    const result = await runFixCli(argv, {
      run, stageEntry, persistEvidence, readPrompt: () => 'Fix the documented typo.', removePrompt: () => {},
      readComments: async () => [{ body: '🔁 review — changes requested\nFix typo', createdAt: '2026-01-01' }],
      resolveProvider: () => provider === 'antigravity'
        ? { spawn: (request, io) => AGY_FIX_PROVIDER.spawn(request, { ...io, runTask }) }
        : { spawn: async () => { await runTask(); return { finalMessage: 'fixed', stdout: 'trace' }; } },
      readLease: () => ({ holder: 'fixture' }), renewLease: () => {},
      readFile: path => path.endsWith('.fix-evidence.md') ? 'Fix evidence' : null,
      fileExists: () => false, pendingRearm: { read: () => null, write: () => {}, clear: () => {} },
      timingPolicy: { pushAfterCi: false }, readRequired: () => ({ checks: [] }),
      releaseClaim: async () => ({ released: [] }), recordOutcome: () => {}, recordRouted: () => ({}),
      recordPush: () => {}, appendLoopRow: () => {}, write: () => {}, writeErr: line => errors.push(line),
    });
    return { result, calls, errors, runTask, stageEntry, persistEvidence, root };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it.each(['codex', 'antigravity'])('an agy fix runs in a lane and opens one PR with the same evidence as codex (%s)', async provider => {
  const f = await fixture(provider);
  expect(f.result.code, f.errors.join('')).toBe(0);
  expect(f.calls.filter(c => c.includes('acquire'))).toHaveLength(1);
  expect(f.stageEntry).toHaveBeenCalledTimes(1);
  expect(f.persistEvidence).toHaveBeenCalledWith(expect.objectContaining({ pr: '7', text: 'Fix evidence' }));
  expect(f.calls.filter(c => c.includes('push'))).toHaveLength(1);
  // A fix updates the existing PR, never creates a duplicate.
  expect(f.calls.filter(c => c.includes('pr') && c.includes('create'))).toHaveLength(0);
  expect(f.calls.filter(c => c.some(a => String(a).endsWith('rearm-review.mjs')))).toHaveLength(1);
  if (provider === 'antigravity') expect(f.runTask).toHaveBeenCalledWith(expect.objectContaining({
    laneDir: join(f.root, 'lane-1'), scope: ['docs/guide.md'], kind: 'doc-fix', size: 1,
  }));
});

it.each(['docs/other.md', 'docs/agent/testing.md', 'blocks/selection/setup.test.ts'])(
  'an agy run that edits an out-of-scope file is refused: %s', async path => {
    const f = await fixture('antigravity', ['docs/guide.md', path]);
    expect(f.runTask).toHaveBeenCalledTimes(1);
    expect(f.result.code).toBe(1);
    expect(f.errors.join('')).toMatch(/scope|admission/);
    expect(f.stageEntry).not.toHaveBeenCalled();
    expect(f.calls.some(c => c.includes('add') || c.includes('update-index') || c.includes('commit') || c.includes('push'))).toBe(false);
  });

it('keeps the production confinement hold closed', async () => {
  const runTask = vi.fn();
  await expect(AGY_FIX_PROVIDER.spawn({ kind: 'doc-fix', size: 1, scope: ['docs/guide.md'] },
    { resolveLane: () => 'lane-1', runTask })).rejects.toThrow(/confinement unavailable/);
  expect(runTask).not.toHaveBeenCalled();
});

it('rechecks admission even for an output path inside the admitted docs directory', async () => {
  const f = await fixture('antigravity', ['docs/agent/testing.md'], 'docs');
  expect(f.runTask).toHaveBeenCalledTimes(1);
  expect(f.result.code).toBe(1);
  expect(f.errors.join('')).toMatch(/scope|admission/);
  expect(f.stageEntry).not.toHaveBeenCalled();
  expect(f.calls.some(c => c.includes('add') || c.includes('update-index') || c.includes('commit') || c.includes('push'))).toBe(false);
});
