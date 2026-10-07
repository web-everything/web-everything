// @vitest-environment node
/**
 * @file scripts/operations/__tests__/card-batch-extract.test.mjs
 * @description Card-batch extraction (#4703, xuz8m83) against a real bare origin and real git commits. Only GitHub
 * and the run.mjs operations are a recording double.
 */
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withNarrowClone } from './helpers/real-repo.mjs';
import { acquireLease, admitCard } from '../card-batch-io.mjs';
import { atomicRecord } from '../card-batch-io.mjs';
import { HOLD_LABEL } from '../card-batch-seal-io.mjs';
import { planSeal } from '../card-batch-seal.mjs';
import { attributeFindings, extractCard, findBatchState, isCardBatchRef, pushArgs } from '../card-batch-extract.mjs';

const CARDS = [['5201', 'one'], ['5202', 'two'], ['5203', 'three']];
const members = CARDS.map(([id]) => ({ cardId: id, cardPath: `backlog/${id}-card.md` }));
const finding = (file, over = {}) => ({ file, line: 3, summary: 'bad card', ...over });

describe('attributeFindings', () => {
  it('names the one card all findings cite', () => {
    const result = attributeFindings({ findings: [finding('backlog/5202-card.md'), finding('./backlog/5202-card.md', { line: 9 })], members });
    expect(result.action).toBe('extract');
    expect(result.member.cardId).toBe('5202');
    expect(result.survivors.map(member => member.cardId)).toEqual(['5201', '5203']);
  });
  it.each([
    ['no file', [{ summary: 'vague' }]],
    ['a non-card file', [finding('scripts/gate.mjs')]],
    ['a card outside the batch', [finding('backlog/9999-card.md')]],
    ['two card files', [finding('backlog/5201-card.md'), finding('backlog/5203-card.md')]],
    ['one card and a gate file', [finding('backlog/5201-card.md'), finding('scripts/gate.mjs')]],
    ['one card and a file-less finding', [finding('backlog/5201-card.md'), { summary: 'vague' }]],
    ['no findings', []],
  ])('holds for %s', (_name, findings) => {
    expect(attributeFindings({ findings, members }).action).toBe('hold');
  });
  it('recognises only lane/card-batch-* heads', () => {
    expect(isCardBatchRef('lane/card-batch-prevention-1')).toBe(true);
    expect(isCardBatchRef('lane/card-extract-1-abc')).toBe(false);
  });
});

describe('pushArgs', () => {
  // Git runs through execFileSync, not the gh/run.mjs recording double, so the push argv is pinned here directly.
  it('is a plain create of a fresh ref: no force flag, no leased force, no `+` refspec', () => {
    const argv = pushArgs('/some/remote', { sha: 'a'.repeat(40), ref: 'lane/card-extract-1-abc1234' });
    expect(argv).toEqual(['push', '/some/remote', `${'a'.repeat(40)}:refs/heads/lane/card-extract-1-abc1234`]);
    expect(argv.some(arg => /^--?(f|force|force-with-lease|force-if-includes)\b/.test(arg) || arg.startsWith('+'))).toBe(false);
    expect(argv.every(arg => !arg.includes(':+'))).toBe(true);
  });
});

/** Admit three cards and mark the batch sealed with PR 50, as the seal job leaves it. */
async function sealedBatch(ctx, stateDir) {
  const baseSha = ctx.git(['rev-parse', 'HEAD']).trim();
  mkdirSync(join(ctx.clone, 'backlog'), { recursive: true });
  let admitted;
  for (const [id, body] of CARDS) {
    writeFileSync(join(ctx.clone, `backlog/${id}-card.md`), `# Card ${id}\n\n${body}\n`);
    admitted = await admitCard({ laneDir: ctx.clone, baseSha, kind: 'prevention', cardId: id, idemKey: `k${id}`,
      cardPath: `backlog/${id}-card.md`, source: { repo: 'org/repo', pr: Number(id) } }, { stateDir });
  }
  const statePath = join(stateDir, 'org-repo-prevention.json');
  atomicRecord(statePath, { ...admitted.state, kind: 'prevention', repo: 'org/repo', pr: 50, sealedAt: '2026-10-07T00:00:00.000Z',
    verificationMarker: { sha: admitted.state.headSha, status: 'green' }, seal: { step: 'label-on-green', reason: 'count' } });
  return { baseSha, statePath, state: admitted.state };
}

/** Recording double for gh and the run.mjs operations. */
function doubles({ existing = {} } = {}) {
  const calls = [];
  let nextPr = 101;
  const prs = { ...existing };
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'node' && args[0].endsWith('open-pr') === false && args[1] === 'open-pr') {
      const ref = args.find(arg => arg.startsWith('--ref=')).slice(6);
      prs[ref] ??= nextPr++;
      return JSON.stringify({ findings: { submit: { effects: [{ result: { outcome: 'opened', pr: prs[ref] } }] } } });
    }
    return '';
  };
  const gh = args => {
    calls.push(['gh', ...args]);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs[args[args.indexOf('--head') + 1]] ? [{ number: prs[args[args.indexOf('--head') + 1]] }] : []);
    return '';
  };
  return { calls, exec, gh, prs };
}

const lsRemote = (ctx, ref) => ctx.git(['ls-remote', '--refs', 'origin', ref]).trim().split(/\s+/)[0];

describe('extractCard (real git)', () => {
  it('splits a 3-card batch around the middle card, with no force and nothing carried over', async () => {
    await withNarrowClone(async ctx => {
      const stateDir = mkdtempSync(join(tmpdir(), 'extract-'));
      try {
        const { baseSha, state } = await sealedBatch(ctx, stateDir);
        const { calls, exec, gh } = doubles();
        const findings = [finding('backlog/5202-card.md')];
        const result = await extractCard({ pr: 50, findings, laneDir: ctx.clone }, { stateDir, exec, gh });
        expect(result.action).toBe('extracted');
        const { journal } = result;
        ctx.git(['fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/inspect/*']);
        // Standalone ref: exactly the middle card commit on top of main.
        const standalone = journal.plan.standalone;
        expect(lsRemote(ctx, standalone.ref)).toBe(standalone.sha);
        expect(ctx.git(['rev-list', '--reverse', `${baseSha}..${standalone.sha}`]).trim().split('\n')).toEqual([standalone.sha]);
        expect(ctx.git(['diff-tree', '--no-commit-id', '--name-status', '-r', standalone.sha]).trim()).toBe('A\tbacklog/5202-card.md');
        // Remainder ref: the other two commits, byte-identical card files.
        const remainder = journal.plan.remainder;
        expect(lsRemote(ctx, remainder.ref)).toBe(remainder.sha);
        expect(ctx.git(['rev-list', '--reverse', `${baseSha}..${remainder.sha}`]).trim().split('\n')).toHaveLength(2);
        for (const id of ['5201', '5203']) {
          expect(ctx.git(['rev-parse', `${remainder.sha}:backlog/${id}-card.md`]).trim())
            .toBe(ctx.git(['rev-parse', `${state.headSha}:backlog/${id}-card.md`]).trim());
        }
        expect(ctx.git(['ls-tree', '-r', '--name-only', remainder.sha, '--', 'backlog/5202-card.md']).trim()).toBe('');
        // Manifests.
        expect(journal.standaloneManifest).toMatchObject({ pr: 101, members: ['5202'] });
        const manifest = JSON.parse(readFileSync(journal.remainderState, 'utf8'));
        expect(manifest.members.map(member => member.cardId)).toEqual(['5201', '5203']);
        expect(manifest.members.map(member => member.commitSha)).toEqual(
          ctx.git(['rev-list', '--reverse', `${baseSha}..${remainder.sha}`]).trim().split('\n'));
        expect(manifest).toMatchObject({ batchRef: remainder.ref, pr: 102, headSha: remainder.sha });
        // No approval or verify carried over; the seal job must re-verify.
        expect(manifest.verificationMarker).toBeUndefined();
        expect(manifest.seal.step).toBeUndefined();
        // The remainder is held off main by the hold label, and the seal job's first remaining step is a fresh verify.
        expect(manifest.holdApplied).toBe(true);
        expect(calls.filter(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'edit' && call.includes('--add-label')))
          .toEqual([['gh', 'pr', 'edit', '102', '--repo', 'org/repo', '--add-label', HOLD_LABEL]]);
        expect(planSeal({ state: manifest }).steps[0]).toBe('verify');
        expect(JSON.stringify(calls)).not.toMatch(/review:accepted|ready-to-merge|--requireVerified/);
        // Old PR closed with pointers to both new PRs; findings posted on the standalone PR; no force anywhere.
        const close = calls.find(call => call[1] === 'pr' && call[2] === 'close');
        expect(close).toContain('50');
        expect(close.join(' ')).toMatch(/#101[\s\S]*#102/);
        const labelling = calls.find(call => call[0] === 'node' && call[1].endsWith('reconcile-finding.mjs'));
        expect(labelling[2]).toBe('101');
        expect(calls.flat().join(' ')).not.toMatch(/--force|\+refs|-f\b/);
        // The old batch ref is untouched.
        expect(lsRemote(ctx, state.batchRef)).toBe(state.headSha);
      } finally { rmSync(stateDir, { recursive: true, force: true }); }
    });
  }, 30000);

  it('a rerun after a crash opens no duplicate PR and reproduces identical refs', async () => {
    await withNarrowClone(async ctx => {
      const stateDir = mkdtempSync(join(tmpdir(), 'extract-'));
      try {
        await sealedBatch(ctx, stateDir);
        const d = doubles();
        const input = { pr: 50, findings: [finding('backlog/5202-card.md')], laneDir: ctx.clone };
        await expect(extractCard(input, { stateDir, exec: d.exec, gh: d.gh, crashAt: 'standalone-open' })).rejects.toThrow('crash');
        const opensAfterCrash = d.calls.filter(call => call[2] === 'open-pr').length;
        expect(opensAfterCrash).toBe(1);
        const result = await extractCard(input, { stateDir, exec: d.exec, gh: d.gh });
        expect(result.action).toBe('extracted');
        // Exactly one open-pr per new head across both runs; the closed PR is closed once.
        expect(d.calls.filter(call => call[2] === 'open-pr')).toHaveLength(2);
        expect(d.calls.filter(call => call[2] === 'close')).toHaveLength(1);
        // A third run is a no-op.
        const before = d.calls.length;
        expect((await extractCard(input, { stateDir, exec: d.exec, gh: d.gh })).action).toBe('extracted');
        expect(d.calls).toHaveLength(before);
        // A crash before the push rebuilds the same shas (repeatable commits), still no duplicate.
        expect(lsRemote(ctx, result.journal.plan.standalone.ref)).toBe(result.journal.plan.standalone.sha);
      } finally { rmSync(stateDir, { recursive: true, force: true }); }
    });
  }, 30000);

  it('a crash between planning and pushing is repeatable', async () => {
    await withNarrowClone(async ctx => {
      const stateDir = mkdtempSync(join(tmpdir(), 'extract-'));
      try {
        await sealedBatch(ctx, stateDir);
        const d = doubles();
        const input = { pr: 50, findings: [finding('backlog/5202-card.md')], laneDir: ctx.clone };
        await expect(extractCard(input, { stateDir, exec: d.exec, gh: d.gh, crashAt: 'planned' })).rejects.toThrow('crash');
        const planned = JSON.parse(readFileSync(join(stateDir, 'extractions/org-repo-50.json'), 'utf8')).plan;
        const result = await extractCard(input, { stateDir, exec: d.exec, gh: d.gh });
        expect(result.journal.plan.standalone.sha).toBe(planned.standalone.sha);
        expect(result.journal.plan.remainder.sha).toBe(planned.remainder.sha);
      } finally { rmSync(stateDir, { recursive: true, force: true }); }
    });
  }, 30000);

  it('resumes after a crash between the two pushes even though main advanced, keeping the planned shas', async () => {
    await withNarrowClone(async ctx => {
      const stateDir = mkdtempSync(join(tmpdir(), 'extract-'));
      try {
        const { baseSha } = await sealedBatch(ctx, stateDir);
        const d = doubles();
        const input = { pr: 50, findings: [finding('backlog/5202-card.md')], laneDir: ctx.clone };
        await expect(extractCard(input, { stateDir, exec: d.exec, gh: d.gh, crashAt: 'push-0' })).rejects.toThrow('crash');
        const planned = JSON.parse(readFileSync(join(stateDir, 'extractions/org-repo-50.json'), 'utf8')).plan;
        // The standalone ref is on the remote; the remainder ref and journal.pushed are not.
        expect(lsRemote(ctx, planned.standalone.ref)).toBe(planned.standalone.sha);
        expect(lsRemote(ctx, planned.remainder.ref)).toBe('');
        // main moves on before the retry.
        ctx.seedOriginBranch('main', { 'unrelated.md': 'main moved\n' }, 'main');
        expect(lsRemote(ctx, 'main')).not.toBe(baseSha);
        const result = await extractCard(input, { stateDir, exec: d.exec, gh: d.gh });
        expect(result.action).toBe('extracted');
        expect(result.journal.plan.baseSha).toBe(baseSha);
        expect(result.journal.plan.standalone.sha).toBe(planned.standalone.sha);
        expect(result.journal.plan.remainder.sha).toBe(planned.remainder.sha);
        expect(lsRemote(ctx, planned.remainder.ref)).toBe(planned.remainder.sha);
      } finally { rmSync(stateDir, { recursive: true, force: true }); }
    });
  }, 30000);

  it('resumes the same card after a partial push even if the retry reports findings on another card', async () => {
    await withNarrowClone(async ctx => {
      const stateDir = mkdtempSync(join(tmpdir(), 'extract-'));
      try {
        await sealedBatch(ctx, stateDir);
        const d = doubles();
        const first = { pr: 50, findings: [finding('backlog/5202-card.md')], laneDir: ctx.clone };
        await expect(extractCard(first, { stateDir, exec: d.exec, gh: d.gh, crashAt: 'push-0' })).rejects.toThrow('crash');
        const planned = JSON.parse(readFileSync(join(stateDir, 'extractions/org-repo-50.json'), 'utf8')).plan;
        const result = await extractCard({ ...first, findings: [finding('backlog/5203-card.md')] }, { stateDir, exec: d.exec, gh: d.gh });
        expect(result.action).toBe('extracted');
        expect(result.journal.plan.standalone).toEqual(planned.standalone);
        expect(result.journal.plan.remainder.sha).toBe(planned.remainder.sha);
      } finally { rmSync(stateDir, { recursive: true, force: true }); }
    });
  }, 30000);

  describe('refusals that never overwrite a ref', () => {
    it('refuses `ref-exists` when the standalone ref is already on the remote at another sha', async () => {
      await withNarrowClone(async ctx => {
        const stateDir = mkdtempSync(join(tmpdir(), 'extract-'));
        try {
          const { state } = await sealedBatch(ctx, stateDir);
          const d = doubles();
          const squatter = `lane/card-extract-5202-${state.members[1].commitSha.slice(0, 7)}`;
          ctx.seedOriginBranch(squatter, { 'other.md': 'someone else\n' }, 'main');
          const squatterSha = lsRemote(ctx, squatter);
          const result = await extractCard({ pr: 50, findings: [finding('backlog/5202-card.md')], laneDir: ctx.clone }, { stateDir, exec: d.exec, gh: d.gh });
          expect(result).toEqual({ action: 'refuse', reason: 'ref-exists' });
          expect(lsRemote(ctx, squatter)).toBe(squatterSha);
          expect(d.calls).toEqual([]);
        } finally { rmSync(stateDir, { recursive: true, force: true }); }
      });
    }, 30000);

    it('refuses `ff-reject` when the remote rejects the push as non-fast-forward, opening nothing', async () => {
      await withNarrowClone(async ctx => {
        const stateDir = mkdtempSync(join(tmpdir(), 'extract-'));
        try {
          await sealedBatch(ctx, stateDir);
          const d = doubles();
          // A remote that reports a lost race, as a concurrent push to the same ref would.
          const hook = join(ctx.origin, 'hooks', 'pre-receive');
          mkdirSync(join(ctx.origin, 'hooks'), { recursive: true });
          writeFileSync(hook, '#!/bin/sh\necho "non-fast-forward: ref moved" >&2\nexit 1\n');
          chmodSync(hook, 0o755);
          const result = await extractCard({ pr: 50, findings: [finding('backlog/5202-card.md')], laneDir: ctx.clone }, { stateDir, exec: d.exec, gh: d.gh });
          expect(result).toEqual({ action: 'refuse', reason: 'ff-reject' });
          expect(d.calls).toEqual([]);
        } finally { rmSync(stateDir, { recursive: true, force: true }); }
      });
    }, 30000);

    it('refuses `lease-held` while another run holds the extraction lease', async () => {
      await withNarrowClone(async ctx => {
        const stateDir = mkdtempSync(join(tmpdir(), 'extract-'));
        try {
          await sealedBatch(ctx, stateDir);
          const d = doubles();
          mkdirSync(join(stateDir, 'extractions'), { recursive: true });
          expect(acquireLease(join(stateDir, 'extractions/org-repo-50.json.lock'), 'other-run', Date.now(), 60 * 60_000)).toBeTruthy();
          const result = await extractCard({ pr: 50, findings: [finding('backlog/5202-card.md')], laneDir: ctx.clone }, { stateDir, exec: d.exec, gh: d.gh });
          expect(result).toEqual({ action: 'refuse', reason: 'lease-held' });
          expect(d.calls).toEqual([]);
        } finally { rmSync(stateDir, { recursive: true, force: true }); }
      });
    }, 30000);
  });

  describe('a failed GitHub call while holding does not lose the human signal', () => {
    // `failOnce('edit')` makes the first `gh pr edit` throw (as a rate limit would); calls that fail are not recorded.
    const flaky = (d, verb) => {
      let armed = true;
      return args => {
        if (armed && args[1] === verb) { armed = false; throw new Error('gh: API rate limit exceeded'); }
        return d.gh(args);
      };
    };
    const labels = d => d.calls.filter(call => call[2] === 'edit' && call.includes('review:human'));
    const comments = d => d.calls.filter(call => call[2] === 'comment');

    // The comment goes first and the label last, so a failed comment never leaves the label set with nothing explained.
    it.each([['comment', 0, 0], ['edit', 0, 1]])('retries the comment and label after a failed `gh pr %s`', async (verb, labelsBeforeRetry, commentsBeforeRetry) => {
      await withNarrowClone(async ctx => {
        const stateDir = mkdtempSync(join(tmpdir(), 'extract-'));
        try {
          await sealedBatch(ctx, stateDir);
          const d = doubles();
          const gh = flaky(d, verb);
          const input = { pr: 50, findings: [finding('scripts/gate.mjs')], laneDir: ctx.clone };
          await expect(extractCard(input, { stateDir, exec: d.exec, gh })).rejects.toThrow('rate limit');
          expect(labels(d)).toHaveLength(labelsBeforeRetry);
          expect(comments(d)).toHaveLength(commentsBeforeRetry);
          // The retry finishes whichever effect is still owed, and applies each exactly once overall.
          const result = await extractCard(input, { stateDir, exec: d.exec, gh });
          expect(result.action).toBe('hold');
          expect(labels(d)).toHaveLength(1);
          expect(comments(d)).toHaveLength(1);
          // Then it is settled: a further run sends nothing.
          const before = d.calls.length;
          expect((await extractCard(input, { stateDir, exec: d.exec, gh })).action).toBe('hold');
          expect(d.calls).toHaveLength(before);
        } finally { rmSync(stateDir, { recursive: true, force: true }); }
      });
    }, 30000);
  });

  it.each([
    ['no card file', [{ summary: 'gate says no' }]],
    ['two card files', [finding('backlog/5201-card.md'), finding('backlog/5203-card.md')]],
    ['a non-card file', [finding('scripts/gate.mjs')]],
  ])('holds for a human when a finding cites %s, extracting and dropping nothing', async (_name, findings) => {
    await withNarrowClone(async ctx => {
      const stateDir = mkdtempSync(join(tmpdir(), 'extract-'));
      try {
        const { state } = await sealedBatch(ctx, stateDir);
        const d = doubles();
        const refsBefore = ctx.git(['ls-remote', '--refs', 'origin']);
        const result = await extractCard({ pr: 50, findings, laneDir: ctx.clone }, { stateDir, exec: d.exec, gh: d.gh });
        expect(result.action).toBe('hold');
        expect(result.reason).toBeTruthy();
        expect(ctx.git(['ls-remote', '--refs', 'origin'])).toBe(refsBefore);
        expect(d.calls.some(call => call[2] === 'close' || call[2] === 'open-pr')).toBe(false);
        expect(d.calls.some(call => call.includes('review:human'))).toBe(true);
        expect(readdirSync(stateDir)).not.toContain('sealed');
        // Held once: a rerun neither re-comments nor extracts.
        const before = d.calls.length;
        expect((await extractCard({ pr: 50, findings: [finding('backlog/5202-card.md')], laneDir: ctx.clone }, { stateDir, exec: d.exec, gh: d.gh })).action).toBe('hold');
        expect(d.calls).toHaveLength(before);
        expect(findBatchState({ stateDir, pr: 50 }).state.headSha).toBe(state.headSha);
      } finally { rmSync(stateDir, { recursive: true, force: true }); }
    });
  }, 30000);

  it('refuses a batch whose remote head moved, and an unsealed batch', async () => {
    await withNarrowClone(async ctx => {
      const stateDir = mkdtempSync(join(tmpdir(), 'extract-'));
      try {
        const { statePath, state } = await sealedBatch(ctx, stateDir);
        const d = doubles();
        const input = { pr: 50, findings: [finding('backlog/5202-card.md')], laneDir: ctx.clone };
        atomicRecord(statePath, { ...state, kind: 'prevention', repo: 'org/repo', pr: 50 });
        expect(await extractCard(input, { stateDir, exec: d.exec, gh: d.gh })).toEqual({ action: 'refuse', reason: 'batch-not-sealed' });
        atomicRecord(statePath, { ...state, kind: 'prevention', repo: 'org/repo', pr: 50, sealedAt: 'x', headSha: 'a'.repeat(40) });
        expect(await extractCard(input, { stateDir, exec: d.exec, gh: d.gh })).toEqual({ action: 'refuse', reason: 'head-mismatch' });
        expect(d.calls).toEqual([]);
        expect(await extractCard({ ...input, pr: 999 }, { stateDir, exec: d.exec, gh: d.gh })).toEqual({ action: 'refuse', reason: 'unknown-batch' });
      } finally { rmSync(stateDir, { recursive: true, force: true }); }
    });
  }, 30000);
});
