import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as snapshot from '../review-pr-snapshot.mjs';
import { readFixPackInputs, readCiPackInputs } from '../../conveyor/fix-context-pack.mjs';
const roots = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'pr-context-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const head = 'a'.repeat(40), next = 'b'.repeat(40);
const value = sha => ({ number: 7, headRefOid: sha, baseRefOid: 'c'.repeat(40), files: [{ path: 'a.mjs' }],
  comments: [], labels: [], commits: [], baseRefName: 'main', headRefName: 'lane/7', state: 'OPEN' });

it('a second contextual reader for repo+PR+head makes NO gh call (one total), and head changes miss', () => {
  const dir = temp(); let calls = 0, current = head;
  const exec = () => { calls++; return JSON.stringify(value(current)); };
  const read = (headSha = current, extra = {}) => snapshot.readPinnedPrContext({ repo: 'o/r', pr: 7, headSha, exec, dir, ...extra });
  expect(read().headRefOid).toBe(head);
  expect(read().headRefOid).toBe(head);
  expect(calls).toBe(1);
  current = next;
  expect(read().headRefOid).toBe(next);
  expect(calls).toBe(2);
  expect(() => read(head, { dir: temp() })).toThrow(/head/i);
});

it('context TTL expires and repo/PR/host identities cannot collide; failed reads never seed', () => {
  const dir = temp(); let calls = 0, at = 0;
  const exec = () => { calls++; return JSON.stringify(value(head)); };
  const read = (extra = {}) => snapshot.readPinnedPrContext({ repo: 'o/r', pr: 7, headSha: head, exec, dir,
    now: () => at, settings: { value: { ttlMs: 10 } }, ...extra });
  read(); read(); expect(calls).toBe(1);
  at = 10; read(); expect(calls).toBe(2);
  read({ repo: 'other/r' }); expect(calls).toBe(3);
  read({ env: { GH_HOST: 'elsewhere' } }); expect(calls).toBe(4);
  expect(() => read({ headSha: next, exec: () => { throw new Error('offline'); } })).toThrow('offline');
  expect(() => read({ headSha: next })).toThrow(/head/i);
});

it('fix context pack uses the shared head-pinned context and complete thread', () => {
  const dir = temp(); let views = 0, threads = 0;
  const exec = (_cmd, args) => { expect(args.slice(0, 2)).toEqual(['pr', 'view']); views++; return JSON.stringify(value(head)); };
  const readComments = () => { threads++; return [{ body: '🔁 review — changes requested\nask', author: { login: 'owner' } }]; };
  const read = () => readFixPackInputs({ repoSlug: 'o/r', pr: 7, headSha: head, exec, readComments,
    isTrusted: () => true, snapshotOptions: { dir } });
  expect(read().findings[0].body).toContain('ask'); read();
  expect(views).toBe(1); expect(threads).toBe(1);
});

it('CI context pack shares the same pinned files; checks remain live', () => {
  const dir = temp(); let views = 0, checks = 0;
  const exec = (_cmd, args) => {
    if (args[1] === 'checks') { checks++; return '[]'; }
    views++; return JSON.stringify(value(head));
  };
  const read = () => readCiPackInputs({ repoSlug: 'o/r', pr: 7, headSha: head, exec, snapshotOptions: { dir } });
  expect(read().files).toHaveLength(1); read();
  expect(views).toBe(1); expect(checks).toBe(2);
});

it('fixer context instructions point additional context reads to the shared CLI', () => {
  const brief = readFileSync('skills-src/conveyor/fix-agent-brief.md', 'utf8');
  expect(brief).toContain('scripts/pr-context.mjs');
  expect(brief).not.toContain('gh pr view {{PR_NUM}} --json title,body,comments');
});

it('review-pr live read warms the same snapshot jurors subsequently read without gh', async () => {
  const { ghPrView } = await import('../../operations/review-pr-io.mjs');
  const dir = temp(); let calls = 0;
  const exec = () => { calls++; return JSON.stringify(value(head)); };
  expect(ghPrView({ repo: 'o/r', pr: 7, exec, snapshotOptions: { dir } }).number).toBe(7);
  expect(snapshot.readPinnedPrContext({ repo: 'o/r', pr: 7, headSha: head, dir,
    exec: () => { throw new Error('juror must reuse'); } }).headRefOid).toBe(head);
  expect(calls).toBe(1);
});

it('round-history shares immutable commits but keeps its authority thread live', async () => {
  const { readRoundHistoryInputs } = await import('../../conveyor/fix-round-history.mjs');
  const dir = temp(); let views = 0, threads = 0;
  const exec = () => { views++; return JSON.stringify(value(head)); };
  const read = () => readRoundHistoryInputs({ repoSlug: 'o/r', pr: 7, headSha: head, exec,
    readComments: () => { threads++; return []; }, snapshotOptions: { dir } });
  expect(read()).not.toBeNull(); expect(read()).not.toBeNull();
  expect(views).toBe(1); expect(threads).toBe(2);
});

it('the context CLI shares complete threads with fixers', async () => {
  const { readPrContextCli } = await import('../../pr-context.mjs');
  const dir = temp(); let views = 0, threads = 0;
  const exec = args => {
    if (args[0] === 'api') { threads++; return 'note\t2026-01-01T00:00:00Z\towner\tIC_7\thttps://example.com'; }
    views++; return JSON.stringify(value(head));
  };
  const args = ['7', '--repo=o/r', `--head=${head}`];
  expect(readPrContextCli(args, { exec, dir }).comments[0].body).toBe('note');
  expect(readPrContextCli([...args, '--field=headRefName'], { exec, dir })).toBe('lane/7');
  expect(views).toBe(1); expect(threads).toBe(1);
});


it('production juror requests carry a concrete shared-context command for the pinned head', async () => {
  const { buildReviewJudgeRequest } = await import('../../operations/review-pr.mjs');
  const request = buildReviewJudgeRequest({ lens: 'correctness', read: {
    repo: 'o/r', pr: 7, netBasis: { rev: head }, netChangedFiles: [], title: 'example',
  } });
  expect(request.mandate).toContain('scripts/pr-context.mjs');
  expect(request.mandate).toContain('--repo=o/r');
  expect(request.mandate).toContain(`--head=${head}`);
});

it('review-detail uses pinned context when given a head and otherwise seeds from a live read', async () => {
  const { readReviewDetailView } = await import('../../review-detail.mjs');
  const dir = temp(); let calls = 0;
  const exec = () => { calls++; return JSON.stringify(value(head)); };
  const args = { repo: 'o/r', pr: 7, exec, snapshotOptions: { dir } };
  expect(readReviewDetailView(args).number).toBe(7);
  expect(readReviewDetailView({ ...args, headSha: head }).headRefOid).toBe(head);
  expect(calls).toBe(1);
});

it('keeps live authority reads live after same-head metadata changes and refuses a push during complete comments', () => {
  const dir = temp(); let current = value(head), calls = 0;
  const exec = () => { calls++; return JSON.stringify(current); };
  const args = { repo: 'o/r', pr: 7, exec, dir };
  expect(snapshot.readLivePrContext(args).labels).toEqual([]);
  current = { ...current, labels: ['new hold'] };
  expect(snapshot.readLivePrContext(args).labels).toEqual(['new hold']);
  expect(calls).toBe(2);
  expect(() => snapshot.readPinnedPrContext({ ...args, headSha: next,
    readComments: () => { current = value('d'.repeat(40)); return []; } })).toThrow(/head/i);
});

it('a corrupt cached subject misses, a different PR misses, and TTL zero disables sharing', async () => {
  const { readdirSync, writeFileSync } = await import('node:fs');
  const dir = temp(); let calls = 0, number = 7;
  const exec = () => { calls++; return JSON.stringify({ ...value(head), number }); };
  const args = { repo: 'o/r', pr: 7, headSha: head, exec, dir };
  snapshot.readPinnedPrContext(args);
  const path = join(dir, readdirSync(dir).find(f => f.endsWith('.json')));
  const cached = JSON.parse(readFileSync(path, 'utf8'));
  cached.data.number = 8;
  writeFileSync(path, JSON.stringify(cached));
  expect(snapshot.readPinnedPrContext(args).number).toBe(7);
  expect(calls).toBe(2);
  number = 8;
  expect(snapshot.readPinnedPrContext({ ...args, pr: 8 }).number).toBe(8);
  expect(calls).toBe(3);
  snapshot.readPinnedPrContext({ ...args, pr: 8, settings: { value: { ttlMs: 0 } } });
  expect(calls).toBe(4);
});

it('a truncated context-pack file list directs fixers back to the shared port', async () => {
  const { renderFixPack } = await import('../../conveyor/fix-context-pack.mjs');
  const pack = renderFixPack({ files: Array.from({ length: 100 }, (_, i) => ({ path: `scripts/file-${i}.mjs` })), maxBytes: 1200 });
  expect(pack).toContain('more (');
  expect(pack).toContain('pr-context.mjs');
  expect(pack).not.toContain('gh pr view --json files');
});
