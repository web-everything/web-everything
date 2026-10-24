/**
 * #xnqxtdy — a recorded human clearance carries across a merge-of-main head move with a byte-identical net diff.
 * Pure decision, the real-git mechanical proof, the drain gate wiring (permission-change PR), and the replay of
 * WE PR #4722's e125ac999 → 1e48ae9a4 → de961efb5 sequence from its recorded markers and commit graph.
 */
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  proveHumanClearanceCarry, decideHumanClearanceCarry, latestHumanClearance, proveMechanicalMove, applyHumanClearanceCarry,
  resolveHumanClearanceCarrySetting, buildCarryRecordBody, HUMAN_CLEARANCE_CARRIED_MARKER, MAX_MECHANICAL_COMMITS, sanitizeActor,
} from '../human-clearance-carry.mjs';
import { normalizeDiffFingerprint, normalizeContributionFingerprint, parseLatestHumanClearedSha, REVIEW_LABELS } from '../review-escalation.mjs';
import { carryHumanClearanceOnIdenticalDiff, createTamperParkCarryCallback, decideDrainReviewGate, readDrainAcceptance } from '../../merge-ai-prs.mjs';

const DIFF = 'diff --git a/x.mjs b/x.mjs\n--- a/x.mjs\n+++ b/x.mjs\n@@ -1 +1 @@\n-old\n+new\n';
const FP = normalizeDiffFingerprint(DIFF);
const CLEARED = 'e125ac99929f8d0f210d253b0969d1f6017ffd4a';
const HEAD = 'de961efb57a31b31c7fb9ae65833880260e6e205';
const ON = { value: true, source: 'default' };
const quiet = () => {};

const clearHumanComment = (sha, fp = FP) => ({
  author: { login: 'chalbert' },
  body: `✅ review — \`review:human\` cleared via the sanctioned path\n\n<!-- reviewed-sha: ${sha} -->\n${fp ? `<!-- reviewed-diff: ${fp} -->\n` : ''}<!-- cleared-human: chalbert -->`,
});
const plainAccept = (sha, fp = FP) => ({ viewerDidAuthor: true, body: `✅ review — accepted\n<!-- reviewed-sha: ${sha} -->\n<!-- reviewed-diff: ${fp} -->` });

describe('decideHumanClearanceCarry (pure)', () => {
  const clearance = { sha: CLEARED, diff: FP, actor: 'chalbert' };
  const mech = { ok: true, reason: '1 merge(s) of origin/main' };
  it('carries an identical net diff across a mechanical move', () => {
    expect(decideHumanClearanceCarry({ clearance, headSha: HEAD, headDiff: DIFF, mechanical: mech }))
      .toEqual({ carry: true, fromSha: CLEARED, toSha: HEAD, fingerprint: FP, tier: 'strict', actor: 'chalbert' });
  });
  it('a contribution match requires a replay proof, not just a merge proof', () => {
    const moved = DIFF.replace('@@ -1 +1 @@', '@@ -4 +4 @@');
    const facts = { clearance: { ...clearance, contribution: normalizeContributionFingerprint(DIFF) }, headSha: HEAD, headDiff: moved };
    expect(decideHumanClearanceCarry({ ...facts, mechanical: { ok: true, kind: 'merge', reason: 'merge' } }))
      .toEqual({ carry: false, reason: 'not a mechanical move: a context-only match needs the replay proof (merge)' });
    expect(decideHumanClearanceCarry({ ...facts, mechanical: { ok: true, kind: 'replay', reason: 'replay' } })).toMatchObject({ carry: true, tier: 'contribution' });
  });
  it.each([
    ['setting off', { enabled: false }, 'off'],
    ['no clearance', { clearance: null }, 'no recorded human clearance'],
    ['unknown live head', { headSha: '' }, 'live head unknown'],
    ['already bound', { headSha: CLEARED }, 'already bound'],
    ['no recorded fingerprint', { clearance: { ...clearance, diff: null } }, 'no reviewed-diff'],
    ['unreadable live diff', { headDiff: null }, 'unreadable'],
    ['changed diff', { headDiff: DIFF.replace('+new', '+unreviewed') }, 'net diff changed'],
    ['non-mechanical push', { mechanical: { ok: false, reason: 'commit abc is not a merge' } }, 'not a mechanical move'],
  ])('refuses: %s', (_n, over, why) => {
    const d = decideHumanClearanceCarry({ clearance, headSha: HEAD, headDiff: DIFF, mechanical: mech, ...over });
    expect(d.carry).toBe(false);
    expect(d.reason).toContain(why);
  });
});

describe('latestHumanClearance', () => {
  it('reads the sha and diff from the SAME latest human comment', () => {
    expect(latestHumanClearance([clearHumanComment(CLEARED)])).toEqual({ sha: CLEARED, diff: FP, contribution: null, actor: 'chalbert' });
  });
  it('a later plain accept means no clearance to carry', () => {
    expect(latestHumanClearance([clearHumanComment(CLEARED), plainAccept(HEAD)])).toBe(null);
  });
  it('ignores an untrusted forger', () => {
    expect(latestHumanClearance([{ author: { login: 'mallory' }, body: clearHumanComment(CLEARED).body }])).toBe(null);
  });
  it('a diff-less clearance does NOT inherit an older accept\'s reviewed-diff', () => {
    expect(latestHumanClearance([plainAccept(PR4722.r1), clearHumanComment(CLEARED, null)])).toEqual({ sha: CLEARED, diff: null, contribution: null, actor: 'chalbert' });
  });
  it('a clearance with an empty actor is not an attributed clearance', () => {
    const c = { author: { login: 'chalbert' }, body: `<!-- reviewed-sha: ${CLEARED} -->\n<!-- reviewed-diff: ${FP} -->\n<!-- cleared-human: -->` };
    expect(latestHumanClearance([c])).toBe(null);
  });
  it('a short or mixed-case sha is not compared or fed to git', () => {
    const short = clearHumanComment(CLEARED.slice(0, 12));
    expect(latestHumanClearance([short])).toBe(null);
    expect(latestHumanClearance([clearHumanComment(CLEARED.toUpperCase())])).toEqual({ sha: CLEARED, diff: FP, contribution: null, actor: 'chalbert' });
  });
  it('the actor comes from the clearance comment, never from an untrusted later forgery', () => {
    const forged = { author: { login: 'mallory' }, body: '<!-- cleared-human: evil -->' };
    expect(latestHumanClearance([clearHumanComment(CLEARED), forged]).actor).toBe('chalbert');
  });
});

describe('resolveHumanClearanceCarrySetting', () => {
  it('defaults on; settings file and env override', () => {
    expect(resolveHumanClearanceCarrySetting({ env: {}, readFile: () => { throw new Error('ENOENT'); } })).toEqual({ value: true, source: 'default' });
    expect(resolveHumanClearanceCarrySetting({ env: {}, readFile: () => '{"review":{"humanClearanceCarryForward":false}}' })).toEqual({ value: false, source: 'settings' });
    expect(resolveHumanClearanceCarrySetting({ env: { WE_REVIEW_HUMAN_CLEARANCE_CARRY: 'off' }, readFile: () => '{}' })).toEqual({ value: false, source: 'env' });
  });
  it('the shipped settings file says true', () => {
    expect(resolveHumanClearanceCarrySetting({ env: {} })).toEqual({ value: true, source: 'settings' });
  });
});

describe('proveMechanicalMove (real git)', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-hcc-'));
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    g('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-qm', 'base');
    g('checkout', '-qb', 'lane');
    writeFileSync(join(dir, 'x.txt'), 'pr\n'); g('add', '.'); g('commit', '-qm', 'pr');
    const cleared = g('rev-parse', 'HEAD');
    g('checkout', '-q', 'main');
    writeFileSync(join(dir, 'b.txt'), 'b\n'); g('add', '.'); g('commit', '-qm', 'main moves');
    g('checkout', '-q', 'lane');
    return { dir, g, cleared };
  };
  const exec = (dir) => (cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd: dir });

  it('a merge of main is mechanical', () => {
    const { dir, g, cleared } = setup();
    try {
      g('merge', '-q', '--no-edit', 'main');
      const r = proveMechanicalMove({ exec: exec(dir), fromSha: cleared, toSha: g('rev-parse', 'HEAD'), mainRef: 'main' });
      expect(r.ok).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('an author commit after the clearance is not', () => {
    const { dir, g, cleared } = setup();
    try {
      g('merge', '-q', '--no-edit', 'main');
      writeFileSync(join(dir, 'y.txt'), 'sneak\n'); g('add', '.'); g('commit', '-qm', 'author push');
      const r = proveMechanicalMove({ exec: exec(dir), fromSha: cleared, toSha: g('rev-parse', 'HEAD'), mainRef: 'main' });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('not a merge');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([false, true])('author commits reverting to identical content are not mechanical (requireReplay=%s)', (requireReplay) => {
    const { dir, g, cleared } = setup();
    try {
      g('merge', '-q', '--no-edit', 'main');
      const mergedTree = g('rev-parse', 'HEAD^{tree}');
      writeFileSync(join(dir, 'x.txt'), 'unreviewed\n'); g('add', '.'); g('commit', '-qm', 'author push');
      g('revert', '--no-edit', 'HEAD');
      expect(g('rev-parse', 'HEAD^{tree}')).toBe(mergedTree);
      const r = proveMechanicalMove({ exec: exec(dir), fromSha: cleared, toSha: g('rev-parse', 'HEAD'), mainRef: 'main', requireReplay });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('not a merge');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([false, true])('a content-preserving rebase is mechanical (requireReplay=%s)', (requireReplay) => {
    const { dir, g, cleared } = setup();
    try {
      g('rebase', '-q', 'main');
      const r = proveMechanicalMove({ exec: exec(dir), fromSha: cleared, toSha: g('rev-parse', 'HEAD'), mainRef: 'main', requireReplay });
      expect(r).toMatchObject({ ok: true, kind: 'replay' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('fetches a cleared head absent from a real clone before checking ancestry', () => {
    const { dir, g, cleared } = setup();
    const clone = mkdtempSync(join(tmpdir(), 'we-hcc-clone-'));
    try {
      g('branch', 'cleared', cleared);
      g('rebase', '-q', 'main');
      const head = g('rev-parse', 'HEAD');
      // Transport cloning only lane excludes the old head retained by origin's cleared ref.
      g('clone', '--no-local', '--single-branch', '--branch', 'lane', dir, clone);
      const run = exec(clone);
      expect(() => run('git', ['cat-file', '-e', `${cleared}^{commit}`], { stdio: 'pipe' })).toThrow();
      run('git', ['fetch', '--no-tags', '-q', 'origin', 'main:refs/remotes/origin/main']);
      const tracked = vi.fn(run);
      expect(proveMechanicalMove({ exec: tracked, fromSha: cleared, toSha: head })).toMatchObject({ ok: true, kind: 'replay' });
      const calls = tracked.mock.calls.map(([, args]) => args);
      expect(calls.filter((args) => args[0] === 'fetch')).toEqual([['fetch', '--no-tags', '-q', 'origin', cleared]]);
      expect(calls.slice(0, 5)).toEqual([
        ['cat-file', '-e', `${cleared}^{commit}`],
        ['fetch', '--no-tags', '-q', 'origin', cleared],
        ['cat-file', '-e', `${cleared}^{commit}`],
        ['cat-file', '-e', `${head}^{commit}`],
        ['merge-base', '--is-ancestor', cleared, head],
      ]);
    } finally {
      rmSync(clone, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each([CLEARED, HEAD])('refuses unreadable commit %s before ancestry', (missing) => {
    const exec = vi.fn((_cmd, args) => {
      if (args[0] === 'fetch' || (args[0] === 'cat-file' && args[2] === `${missing}^{commit}`)) throw new Error('missing');
      return '';
    });
    expect(proveMechanicalMove({ exec, fromSha: CLEARED, toSha: HEAD })).toMatchObject({ ok: false, reason: expect.stringContaining('not readable locally') });
    expect(exec.mock.calls.some(([, args]) => args[0] === 'merge-base')).toBe(false);
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'fetch').map(([, args]) => args)).toEqual([['fetch', '--no-tags', '-q', 'origin', missing]]);
  });
  it('a rebase that changes one added line is not mechanical', () => {
    const { dir, g, cleared } = setup();
    try {
      g('rebase', '-q', 'main');
      writeFileSync(join(dir, 'x.txt'), 'changed\n'); g('add', '.'); g('commit', '--amend', '--no-edit');
      const head = g('rev-parse', 'HEAD');
      const r = proveMechanicalMove({ exec: exec(dir), fromSha: cleared, toSha: head, mainRef: 'main' });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(`cleared head ${cleared.slice(0, 9)} is not an ancestor of ${head.slice(0, 9)} — `);
      expect(r.reason).toContain('differs from the cleared change replayed onto main');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('a merge of main requiring replay also proves its tree', () => {
    const { dir, g, cleared } = setup();
    try {
      g('merge', '-q', '--no-edit', 'main');
      const facts = { exec: exec(dir), fromSha: cleared, mainRef: 'main', requireReplay: true };
      expect(proveMechanicalMove({ ...facts, toSha: g('rev-parse', 'HEAD') })).toMatchObject({ ok: true, kind: 'replay' });
      writeFileSync(join(dir, 'x.txt'), 'unreviewed resolution\n'); g('add', '.'); g('commit', '--amend', '--no-edit');
      const r = proveMechanicalMove({ ...facts, toSha: g('rev-parse', 'HEAD') });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('differs from the cleared change replayed onto main');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['head', 'parent'])('ancestry git errors refuse without replay (%s check)', (check) => {
    const exec = vi.fn((_cmd, args) => {
      if (args[0] === 'rev-list') return `${HEAD} parent1 parent2`;
      if (args[0] === 'merge-base' && (check === 'head' || args[2] === 'parent1')) {
        throw Object.assign(new Error('git read failed'), { status: 128 });
      }
      return '';
    });
    expect(proveMechanicalMove({ exec, fromSha: CLEARED, toSha: HEAD })).toMatchObject({ ok: false, reason: expect.stringContaining('git read failed') });
    expect(exec.mock.calls.some(([, args]) => args[0] === 'merge-tree')).toBe(false);
  });
  it('fails closed when git throws', () => {
    const exec = () => { throw new Error('git exploded'); };
    expect(proveMechanicalMove({ exec, fromSha: CLEARED, toSha: HEAD }).ok).toBe(false);
    expect(proveMechanicalMove({ fromSha: CLEARED, toSha: HEAD }).ok).toBe(false);
  });
  it('fails closed when rev-list throws', () => {
    const exec = (_c, args) => { if (args[0] === 'rev-list') throw new Error('bad object'); return ''; };
    const r = proveMechanicalMove({ exec, fromSha: CLEARED, toSha: HEAD });
    expect(r).toMatchObject({ ok: false });
    expect(r.reason).toContain('rev-list failed');
  });
  it('more than MAX_MECHANICAL_COMMITS new commits is not a refresh', () => {
    const lines = Array.from({ length: MAX_MECHANICAL_COMMITS + 1 }, (_, i) => `c${i} p${i} q${i}`).join('\n');
    const exec = (_c, args) => (args[0] === 'rev-list' ? lines : '');
    const r = proveMechanicalMove({ exec, fromSha: CLEARED, toSha: HEAD });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not a refresh');
  });
  it('a merge of a non-main branch is not', () => {
    const { dir, g, cleared } = setup();
    try {
      g('checkout', '-qb', 'other', 'main~1');
      writeFileSync(join(dir, 'o.txt'), 'o\n'); g('add', '.'); g('commit', '-qm', 'other');
      g('checkout', '-q', 'lane'); g('merge', '-q', '--no-edit', 'other');
      const r = proveMechanicalMove({ exec: exec(dir), fromSha: cleared, toSha: g('rev-parse', 'HEAD'), mainRef: 'main' });
      expect(r.ok).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/** A recorded commit graph: `parents[sha]`, and `main` = the set of shas reachable from the main ref. */
const graphExec = ({ parents, main, onComment = () => {}, view = null, tip = view?.headRefOid }) => vi.fn((cmd, args) => {
  if (cmd === 'gh' && args[1] === 'view') return JSON.stringify(view);
  if (cmd === 'git' && args[0] === 'rev-parse') {
    if (args.at(-1).endsWith('^{tree}')) throw Error('tree not recorded in fixture');
    return `${tip}\n`;
  } // the sha the branch tip (the net diff's rev) resolves to
  if (cmd === 'gh' && args[1] === 'comment') { onComment(args[args.indexOf('--body') + 1]); return ''; }
  // PR #4631 round 11: a moved head's coverage reads the PR's formal reviews (`gh api …/reviews`); none stand here.
  if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
    return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: view.comments.length } } } } });
  }
  if (cmd === 'gh' && args[0] === 'api') return args.some(a => a.includes('/comments'))
    ? view.comments.map((c, i) => [c.body.replaceAll('\n', '\\n'), c.createdAt || '', c.author?.login || 'chalbert', c.id ?? `IC_${i}`].join('\t')).join('\n') : '';
  if (cmd !== 'git') throw new Error(`unexpected ${cmd}`);
  const ancestors = (sha) => { const seen = new Set(); const st = [sha]; while (st.length) { const s = st.pop(); if (seen.has(s)) continue; seen.add(s); st.push(...(parents[s] || [])); } return seen; };
  const mainSet = new Set([...main].flatMap((m) => [...ancestors(m)]));
  if (args[0] === 'cat-file' && args[1] === '-e') {
    const sha = args[2].replace(/\^\{commit\}$/, '');
    if (!Object.hasOwn(parents, sha) && !Object.values(parents).some((ps) => ps.includes(sha))) throw new Error('missing commit');
    return '';
  }
  if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
    const [a, b] = args.slice(2);
    const ok = b === 'origin/main' ? mainSet.has(a) : ancestors(b).has(a);
    if (!ok) throw Object.assign(new Error('not ancestor'), { status: 1 });
    return '';
  }
  if (args[0] === 'rev-list') {
    const [, , to, notFrom] = args;
    const excluded = new Set([...ancestors(notFrom.slice(1)), ...mainSet]);
    return [...ancestors(to)].filter((s) => !excluded.has(s)).map((s) => [s, ...(parents[s] || [])].join(' ')).join('\n');
  }
  throw new Error(`unexpected git ${args.join(' ')}`);
});

// WE PR #4722, recorded 2026-10-10: e125ac999 cleared; 1e48ae9a4 = merge(1c76db3ed[main], e125ac999);
// de961efb5 = merge(e16bb39a9[main], 1e48ae9a4). reviewed-diff 67148bcd… at all three heads.
const PR4722 = {
  fp: '67148bcdf2f50a8ead8ed799efe249eb9b70563ae8ff5de00cd744e02db10583',
  e125: CLEARED, r1: '1e48ae9a4f21b2caacced2ac076f4512490437f3', head: HEAD,
  main1: '1c76db3ed5fb5ec5b454141ea6f496e970ef2d0d', main2: 'e16bb39a9e84fdc768f1dbe1cf84b910cc68e170',
};
const pr4722Graph = {
  [PR4722.r1]: [PR4722.main1, PR4722.e125], [PR4722.head]: [PR4722.main2, PR4722.r1],
  [PR4722.main2]: [PR4722.main1], [PR4722.e125]: ['c67450aff'], [PR4722.main1]: ['c67450aff'],
};
const restampComment = { author: { login: 'web-everything' }, body: `📌 review — acceptance re-stamped after a rebase (no new review)\n<!-- reviewed-sha: ${PR4722.r1} -->\n<!-- reviewed-diff: ${PR4722.fp} -->\n<!-- cleared-human: chalbert -->` };

describe('replay WE PR #4722 (e125ac999 → de961efb5)', () => {
  for (const [name, comments, from] of [
    ['straight from the clear-human on e125ac999', [clearHumanComment(PR4722.e125, PR4722.fp)], PR4722.e125],
    ['from the carried restamp on 1e48ae9a4 (the live state at 15:14 ET)', [clearHumanComment(PR4722.e125, PR4722.fp), restampComment], PR4722.r1],
  ]) {
    it(`carries the clearance ${name}; the drain merges the permission-change PR and records it`, () => {
      const posted = [];
      const view = { headRefOid: PR4722.head, headRefName: 'lane/resource-usage-service', comments };
      const exec = graphExec({ parents: pr4722Graph, main: [PR4722.main2], onComment: (b) => posted.push(b), view });
      const opts = { files: ['scripts/resource-usage-service.mjs'], filesComplete: true, listedHeadSha: PR4722.head, pr: 4722, repo: 'web-everything/web-everything', local: true, exec,
        netDiff: () => ({ scored: true, text: PR4722.fp, rev: PR4722.head, revSha: PR4722.head }), carry: { setting: ON, log: quiet } };
      const gate = decideDrainReviewGate({ labels: [REVIEW_LABELS.accepted], escalate: true, humanRequired: true, permissionChange: true }, opts);
      expect(gate.action).toBe('merge');
      expect(gate.carriedClearance).toMatchObject({ fromSha: from, toSha: PR4722.head, fingerprint: PR4722.fp, recorded: true });
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain(`<!-- ${HUMAN_CLEARANCE_CARRIED_MARKER}: from=${from} to=${PR4722.head} diff=${PR4722.fp} -->`);
      // Every reader of the binding (drain, review-hold reconcile, operator queue) now sees the live head cleared.
      expect(parseLatestHumanClearedSha([...comments, { viewerDidAuthor: true, body: posted[0] }])).toBe(PR4722.head);
    });
  }

  it('workflow edits cannot carry an older human clearance even across an identical diff', () => {
    const posted = [];
    const view = { headRefOid: PR4722.head, headRefName: 'lane/x', comments: [clearHumanComment(PR4722.e125, PR4722.fp)] };
    const exec = graphExec({ parents: pr4722Graph, main: [PR4722.main2], onComment: (b) => posted.push(b), view });
    const gate = decideDrainReviewGate({ labels: [REVIEW_LABELS.accepted], escalate: true }, {
      pr: 4722, local: true, files: ['.github/workflows/merge-gate.yml'], filesComplete: true, listedHeadSha: PR4722.head, exec,
      netDiff: () => ({ scored: true, text: PR4722.fp, rev: PR4722.head, revSha: PR4722.head }),
      carry: { setting: ON, log: quiet },
    });
    expect(gate).toMatchObject({ action: 'park', applyLabel: REVIEW_LABELS.human, reason: expect.stringContaining('human-only:') });
    expect(posted).toHaveLength(0);
    expect(gate.carriedClearance).toBeUndefined();
  });

  it('without the carry (setting off) the same state re-parks review:human — the bug', () => {
    const view = { headRefOid: PR4722.head, headRefName: 'lane/x', comments: [clearHumanComment(PR4722.e125, PR4722.fp), restampComment] };
    const exec = graphExec({ parents: pr4722Graph, main: [PR4722.main2], view });
    const gate = decideDrainReviewGate({ labels: [REVIEW_LABELS.accepted], escalate: true, humanRequired: true, permissionChange: true },
      { files: ['scripts/resource-usage-service.mjs'], filesComplete: true, listedHeadSha: PR4722.head, pr: 4722, local: true, exec, netDiff: () => ({ scored: true, text: PR4722.fp, rev: PR4722.head, revSha: PR4722.head }), carry: { setting: { value: false, source: 'env' }, log: quiet } });
    expect(gate).toMatchObject({ action: 'park', applyLabel: REVIEW_LABELS.human });
    expect(gate.reason).toContain('permission-change');
  });
});

describe('drain gate: what does NOT carry', () => {
  const base = (over = {}) => {
    const posted = [];
    const view = { headRefOid: PR4722.head, headRefName: 'lane/x', comments: [clearHumanComment(PR4722.e125, PR4722.fp)] };
    const exec = graphExec({ parents: over.parents || pr4722Graph, main: [PR4722.main2], onComment: (b) => posted.push(b), view });
    const gate = decideDrainReviewGate({ labels: [REVIEW_LABELS.accepted], escalate: true, humanRequired: true, permissionChange: true },
      { files: ['scripts/resource-usage-service.mjs'], filesComplete: true, listedHeadSha: PR4722.head, pr: 4722, local: true, exec, netDiff: () => ({ scored: true, text: over.diff || PR4722.fp, rev: PR4722.head, revSha: PR4722.head }), carry: { setting: ON, log: quiet } });
    return { gate, posted };
  };
  it('a changed net diff re-parks review:human, no record', () => {
    const { gate, posted } = base({ diff: DIFF });
    expect(gate.action).toBe('park');
    expect(gate.carriedClearance).toBeUndefined();
    expect(posted).toHaveLength(0);
  });
  it('a non-mechanical push (author commit on top) re-parks, even with an identical diff', () => {
    const { gate, posted } = base({ parents: { ...pr4722Graph, [PR4722.head]: [PR4722.r1] } });
    expect(gate).toMatchObject({ action: 'park', applyLabel: REVIEW_LABELS.human });
    expect(posted).toHaveLength(0);
  });
  it.each([
    ['the branch moved on after headRefOid was read', { tip: PR4722.main2 }],
    ['the tip does not resolve', { tip: '' }],
  ])('a net diff read from a different tip than the stamped head does not carry (no record): %s', (_n, { tip }) => {
    const posted = [];
    const view = { headRefOid: PR4722.head, headRefName: 'lane/x', comments: [clearHumanComment(PR4722.e125, PR4722.fp)] };
    const exec = graphExec({ parents: pr4722Graph, main: [PR4722.main2], onComment: (b) => posted.push(b), view });
    // the net diff names the sha it was pinned to (`revSha`); a different tip, or none, must not bind to the stamped head.
    // PR #4631 round 7: such a diff is not the live head's own, so it is a read miss — the pass parks without re-labelling
    // (UNVERIFIED, `applyLabel: null`), exactly as for any other diff that was not read at the head.
    const gate = decideDrainReviewGate({ labels: [REVIEW_LABELS.accepted], escalate: true, humanRequired: true, permissionChange: true },
      { files: ['scripts/resource-usage-service.mjs'], filesComplete: true, listedHeadSha: PR4722.head, pr: 4722, local: true, exec, netDiff: () => ({ scored: true, text: PR4722.fp, rev: tip || 'origin/lane/x', revSha: tip || undefined }), carry: { setting: ON, log: quiet } });
    expect(gate).toMatchObject({ action: 'park', applyLabel: null });
    expect(gate.carriedClearance).toBeUndefined();
    expect(posted).toHaveLength(0);
  });
  it('a failed record write defers without a label change', () => {
    const r = applyHumanClearanceCarry({ evidence: { humanClearance: { sha: PR4722.e125, diff: PR4722.fp, actor: 'chalbert' }, headSha: PR4722.head, headDiff: PR4722.fp, headDiffSha: PR4722.head },
      pr: 1, exec: graphExec({ parents: pr4722Graph, main: [PR4722.main2], onComment: () => { throw new Error('gh 502'); } }), setting: ON, log: quiet });
    expect(r).toMatchObject({ action: 'defer', applyLabel: null });
  });
  it('a diff-less human clearance after an older accept that HAD a diff does not carry (no record)', () => {
    const posted = [];
    const view = { headRefOid: PR4722.head, headRefName: 'lane/x', comments: [plainAccept(PR4722.r1, PR4722.fp), clearHumanComment(PR4722.e125, null)] };
    const exec = graphExec({ parents: pr4722Graph, main: [PR4722.main2], onComment: (b) => posted.push(b), view });
    const gate = decideDrainReviewGate({ labels: [REVIEW_LABELS.accepted], escalate: true, humanRequired: true, permissionChange: true },
      { files: ['scripts/resource-usage-service.mjs'], filesComplete: true, listedHeadSha: PR4722.head, pr: 4722, local: true, exec, netDiff: () => ({ scored: true, text: PR4722.fp, rev: PR4722.head, revSha: PR4722.head }), carry: { setting: ON, log: quiet } });
    expect(gate).toMatchObject({ action: 'park', applyLabel: REVIEW_LABELS.human });
    expect(gate.carriedClearance).toBeUndefined();
    expect(posted).toHaveLength(0);
  });
  it('an untrusted forged cleared-human comment cannot set the actor in the posted record', () => {
    const posted = [];
    const forged = { author: { login: 'mallory' }, body: '<!-- cleared-human: evil @victim -->' };
    const view = { headRefOid: PR4722.head, headRefName: 'lane/x', comments: [clearHumanComment(PR4722.e125, PR4722.fp), forged] };
    const exec = graphExec({ parents: pr4722Graph, main: [PR4722.main2], onComment: (b) => posted.push(b), view });
    const gate = decideDrainReviewGate({ labels: [REVIEW_LABELS.accepted], escalate: true, humanRequired: true, permissionChange: true },
      { files: ['scripts/resource-usage-service.mjs'], filesComplete: true, listedHeadSha: PR4722.head, pr: 4722, local: true, exec, netDiff: () => ({ scored: true, text: PR4722.fp, rev: PR4722.head, revSha: PR4722.head }), carry: { setting: ON, log: quiet } });
    expect(gate.action).toBe('merge');
    expect(gate.carriedClearance.actor).toBe('chalbert');
    expect(posted[0]).toContain('<!-- cleared-human: chalbert -->');
    expect(posted[0]).not.toContain('evil');
    expect(posted[0]).not.toContain('victim');
  });
  it('a forged cleared-human comment cannot inject markup, mentions or links into the drain\'s own revocation reason', () => {
    const forged = { author: { login: 'mallory' }, body: '<!-- cleared-human: @org/security-team\n[click](http://evil.example) -->' };
    const view = { headRefOid: PR4722.head, headRefName: 'lane/x', comments: [clearHumanComment(PR4722.e125, PR4722.fp), forged] };
    const exec = graphExec({ parents: pr4722Graph, main: [PR4722.main2], view });
    const gate = decideDrainReviewGate({ labels: [REVIEW_LABELS.accepted], escalate: true, humanRequired: true, permissionChange: true },
      { files: ['scripts/resource-usage-service.mjs'], filesComplete: true, listedHeadSha: PR4722.head, pr: 4722, local: true, exec, netDiff: () => ({ scored: true, text: DIFF, rev: PR4722.head, revSha: PR4722.head }), carry: { setting: ON, log: quiet } });
    expect(gate.action).toBe('park');
    const text = JSON.stringify([gate.reason, gate.clearance]);
    expect(text).not.toMatch(/@org|https?:\/\/|\[click\]|\]\(|\\n/);
    expect(gate.clearance.actor).toBe('org security-team click http evil.example');
  });
  it('logs the setting once per distinct value, and every carry and refused carry', () => {
    const lines = [];
    const log = (l) => lines.push(l);
    const evidence = { humanClearance: { sha: PR4722.e125, diff: PR4722.fp, actor: 'chalbert' }, headSha: PR4722.head, headDiff: PR4722.fp, headDiffSha: PR4722.head };
    const exec = graphExec({ parents: pr4722Graph, main: [PR4722.main2] });
    const setting = { value: true, source: 'env' };
    applyHumanClearanceCarry({ evidence, pr: 7, exec, setting, log });
    applyHumanClearanceCarry({ evidence: { ...evidence, headDiff: DIFF }, pr: 8, exec, setting, log });
    expect(lines.filter((l) => l.includes('policy · review.humanClearanceCarryForward=true (env)'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('#7: CARRIED'))).toBe(true);
    expect(lines.some((l) => l.includes('#8: NOT carried') && l.includes('net diff changed'))).toBe(true);
  });
  it('dry run carries without writing', () => {
    const onComment = vi.fn();
    const r = applyHumanClearanceCarry({ evidence: { humanClearance: { sha: PR4722.e125, diff: PR4722.fp, actor: 'chalbert' }, headSha: PR4722.head, headDiff: PR4722.fp, headDiffSha: PR4722.head },
      pr: 1, dryRun: true, exec: graphExec({ parents: pr4722Graph, main: [PR4722.main2], onComment }), setting: ON, log: quiet });
    expect(r.carried.recorded).toBe(false);
    expect(onComment).not.toHaveBeenCalled();
  });
});

describe('sanitizeActor', () => {
  it.each([
    ['chalbert', 'chalbert'],
    ['Nic Gilbert', 'Nic Gilbert'],
    ['see https://evil.example/x', 'see https evil.example x'],
    ['a\u200Bb\u202Ec', 'a b c'],
    ['org/repo#12 a@b.co', 'org repo 12 a b.co'],
    ['', 'the operator'],
    ['<>@@', 'the operator'],
  ])('%j → %j', (raw, safe) => { expect(sanitizeActor(raw)).toBe(safe); });
  it('caps the length', () => { expect(sanitizeActor('x'.repeat(500))).toHaveLength(64); });
});

describe('buildCarryRecordBody', () => {
  it('binds reviewed-sha and cleared-human to the new head in one comment', () => {
    const body = buildCarryRecordBody({ fromSha: CLEARED, toSha: HEAD, fingerprint: FP, tier: 'strict', actor: 'chalbert', headDiffText: DIFF });
    expect(body).toContain(`<!-- reviewed-sha: ${HEAD} -->`);
    expect(body).toContain(`<!-- reviewed-diff: ${FP} -->`);
    expect(body).toContain('<!-- cleared-human: chalbert -->');
  });
  it('neutralises newlines, markup, mentions and links in the actor wherever it is rendered', () => {
    const body = buildCarryRecordBody({ fromSha: CLEARED, toSha: HEAD, fingerprint: FP, tier: 'strict', actor: 'ev\nil <b>@victim</b> [x](http://e) `c`', headDiffText: DIFF });
    const prose = body.split('\n').find((l) => l.startsWith('Recorded by drain'));
    expect(prose).toContain('ev il');
    expect(prose).not.toMatch(/@|<|>|\]\(|`c`/);
    expect(body).not.toContain('@victim');
    expect(body.split('\n').filter((l) => l.includes('cleared-human:'))).toHaveLength(1);
    expect(parseLatestHumanClearedSha([{ viewerDidAuthor: true, body }])).toBe(HEAD);
  });
});

describe('the diff the carry reads is pinned to ONE resolved tip sha (a branch tip that moves mid-read)', () => {
  const OLD_TIP = 'c'.repeat(40);
  const NEW_TIP = 'd'.repeat(40);
  const FORK = 'e'.repeat(40);
  const view = () => ({ headRefOid: NEW_TIP, headRefName: 'lane/3432', comments: [plainAccept(CLEARED)] });
  const read = (exec, extra = {}) => readDrainAcceptance({ pr: 3432, repo: 'web-everything/web-everything', cwd: '/ws', local: true, exec, ...extra });
  // A tracking ref that a concurrent fetch advances right after the diff is read: `origin/lane/3432` is OLD_TIP until
  // a `git diff` has run, NEW_TIP after. Diffs of a sha are stable; diffs of the moving ref name are not.
  function movingTipExec() {
    let ref = OLD_TIP;
    const calls = [];
    const exec = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'gh') return args[0] === 'api' ? '' : JSON.stringify(view()); // no formal review stands (round 11)
      if (args[0] === 'fetch') throw new Error('offline'); // the fetch fails: the cached tracking ref is used
      // a remote-tracking ref named by a sha does not exist (git: unknown revision) — the bare sha is the candidate
      if (args.some((a) => /^origin\/[0-9a-f]{40}/.test(a))) throw new Error('unknown revision');
      if (args[0] === 'merge-base') return `${FORK}\n`;
      if (args[0] === 'rev-parse') return `${args.at(-1).startsWith('origin/lane/3432') ? ref : args.at(-1).replace(/\^\{commit\}$/, '')}\n`;
      if (args[0] === 'diff' && args.includes('--numstat')) return '1\t1\tx.mjs\n';
      if (args[0] === 'diff') { ref = NEW_TIP; return DIFF; }
      return '';
    };
    return { exec, calls };
  }

  it('reads the diff AT the head sha (PR #4631 round 7), so a branch tip that moves mid-read cannot supply it', () => {
    const { exec, calls } = movingTipExec();
    const evidence = read(exec);
    expect(evidence.headDiff).toBe(DIFF);
    expect(evidence.headDiffSha).toBe(NEW_TIP);
    expect(evidence.headDiffSha).toBe(evidence.headSha);
    // the text diff names the resolved head sha, never the moving ref name
    const textDiff = calls.find((c) => c.startsWith('git diff --no-ext-diff'));
    expect(textDiff).toContain(NEW_TIP);
    expect(textDiff).not.toContain('origin/lane/3432');
  });

  it('end to end: the moved-tip diff is refused by the carry (no record is written, nothing is carried)', () => {
    const { exec } = movingTipExec();
    // the read itself is head-bound now (round 7); the carry's own check still refuses evidence naming another tip
    const evidence = { ...read(exec), headDiffSha: OLD_TIP, humanClearance: { sha: CLEARED, diff: FP, actor: 'chalbert' } };
    const onComment = vi.fn();
    const r = applyHumanClearanceCarry({ evidence, pr: 3432, cwd: '/ws', exec: onComment, setting: ON, log: quiet });
    expect(r).toBe(null);
    expect(onComment).not.toHaveBeenCalled();
  });

  it('a tip that cannot be resolved reads as unscored (no diff, so no carry can bind it)', () => {
    const exec = (cmd, args) => {
      if (cmd === 'gh') return JSON.stringify(view());
      if (args[0] === 'rev-parse') throw new Error('unknown revision');
      return args[0] === 'diff' ? (args.includes('--numstat') ? '1\t1\tx.mjs\n' : DIFF) : `${FORK}\n`;
    };
    const evidence = read(exec);
    expect(evidence.headDiffSha).toBe(null);
    expect(evidence.headDiff).toBe(null);
  });

  it('a scored read that names no pinned sha is a read miss (round 7) — no second lookup labels it', () => {
    const exec = vi.fn((cmd, args) => (args[0] === 'api' ? '' : JSON.stringify(view())));
    const evidence = read(exec, { netDiff: () => ({ scored: true, text: DIFF, rev: 'origin/lane/3432' }) });
    expect(evidence.headDiff).toBe(null);
    expect(evidence.headDiffSha).toBe(null);
    expect(exec.mock.calls.filter(([cmd]) => cmd === 'git')).toEqual([]); // no post-diff rev-parse
  });

  it('a basis with no fork point (diffed against the moving base NAME) is unscored — the base side cannot be pinned', () => {
    const { exec: inner } = movingTipExec();
    const exec = (cmd, args) => {
      if (args?.[0] === 'merge-base') throw new Error('no merge base');
      return inner(cmd, args);
    };
    const evidence = read(exec);
    expect(evidence.headDiffSha).toBe(null);
    expect(evidence.headDiff).toBe(null);
    expect(evidence.headReadFailed).toBe(true);
  });

  it('the fork point is taken from the pinned head sha, not the moving ref name', () => {
    const { exec, calls } = movingTipExec();
    read(exec);
    expect(calls.filter((c) => c.startsWith('git merge-base')).at(-1)).toContain(NEW_TIP);
  });
});

describe('PR #4715 context movement and manifest-drop replay', () => {
  it.each(['strict', 'contribution', 'default', 'changed'].flatMap(mode => [true, false].map(netPatch => [mode, netPatch])))('%s policy through the durable carry (net patch: %s)', (mode, netPatch) => {
    const dir = mkdtempSync(join(tmpdir(), 'we-4715-'));
    const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const content = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n';
    const commit = (text) => { writeFileSync(join(dir, 'f.txt'), text); g('add', '.'); g('commit', '-qm', 'change'); };
    try {
      g('init', '-q', '-b', 'main'); commit(content);
      const oldBase = g('rev-parse', 'HEAD');
      g('checkout', '-qb', 'lane'); writeFileSync(join(dir, '.lane-manifest.json'), '{}'); commit(content.replace('five', 'lane'));
      const cleared = g('rev-parse', 'HEAD');
      const oldDiff = g('diff', oldBase, cleared);
      g('checkout', '-q', 'main'); commit(content.replace('three', 'main'));
      const newBase = g('rev-parse', 'HEAD');
      g('checkout', '-qb', 'replayed'); commit(content.replace('three', 'main').replace('five', mode === 'changed' ? 'different' : 'lane'));
      const headSha = g('rev-parse', 'HEAD');
      const headDiff = g('diff', newBase, headSha);
      const comment = clearHumanComment(cleared, normalizeDiffFingerprint(oldDiff));
      comment.body += `\n<!-- reviewed-contribution: ${normalizeContributionFingerprint(oldDiff)} -->`;
      const humanClearance = latestHumanClearance([comment]);
      expect(normalizeDiffFingerprint(headDiff)).not.toBe(humanClearance.diff);
      const posted = []; const logs = [];
      const exec = (cmd, args, opts) => {
        if (cmd === 'git') return execFileSync(cmd, args, { ...opts, cwd: dir });
        expect([cmd, ...args.slice(0, 2)]).toEqual(['gh', 'pr', 'comment']);
        posted.push(args[args.indexOf('--body') + 1]); return '';
      };
      const result = applyHumanClearanceCarry({ evidence: { humanClearance, headSha, headDiff, headDiffSha: headSha }, pr: 4715, cwd: dir, exec, dryRun: false, mainRef: 'main', setting: ON, netPatchSetting: { value: netPatch, source: 'test' }, log: (s) => logs.push(s), ...(mode === 'default' ? {} : { equivalence: mode === 'changed' ? 'contribution' : mode }) });
      if (mode === 'default' || mode === 'contribution') {
        expect(result).toMatchObject({ carried: { recorded: true, tier: 'contribution', fromSha: cleared, toSha: headSha } });
        expect(posted).toHaveLength(1);
      } else {
        expect(result).toBe(null); expect(posted).toHaveLength(0);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('tamper-park callback through the durable human carry writer', () => {
  it.each([true, false].flatMap(fingerprint => ['valid', 'mixed change', 'live hold', 'numbering off', 'master off', 'unpinned'].map(shape => [fingerprint, shape])))('numbering callback with fingerprint=%s, %s', (fingerprint, shape) => {
    const comments = [clearHumanComment(CLEARED, fingerprint ? FP : null)], posted = [];
    const headDiff = DIFF.replace('+new', '+numbered');
    const result = carryHumanClearanceOnIdenticalDiff({ setting: 'on', comments, reviews: [],
      humanClearedSha: CLEARED, headSha: HEAD, pinnedHeadSha: shape === 'unpinned' ? CLEARED : HEAD,
      readHeadDiff: () => ({ scored: true, text: headDiff, rev: HEAD }),
      applyNumberingCarry: createTamperParkCarryCallback({ pr: 5463, repo: 'owner/repo',
        setting: { value: shape !== 'master off', source: 'test' }, numberingSetting: { value: shape !== 'numbering off', source: 'test' }, log: quiet,
        exec: (cmd, args) => { if (cmd === 'git') throw Error('no general git proof in fixture'); posted.push(args); return ''; },
        proveNumbering: () => ({ ok: shape !== 'mixed change', reason: shape === 'mixed change' ? 'unrelated byte' : 'exact numbering' }),
        readNumberingLiveEvidence: () => ({ headSha: HEAD, comments: shape === 'live hold'
          ? [...comments, { author: { login: 'chalbert' }, body: 'Do not land this.' }] : comments, reviews: [] }),
      }),
    });
    expect(result).toMatchObject({ carried: shape === 'valid', humanClearedSha: shape === 'valid' ? HEAD : CLEARED });
    expect(posted).toHaveLength(shape === 'valid' ? 1 : 0);
    if (shape === 'valid') expect(posted[0].at(-1)).toContain(`from=${CLEARED} to=${HEAD}`);
  });
});

describe('human clearance numbering tier', () => {
  const evidence = { humanClearance: { sha: CLEARED, diff: FP, actor: 'chalbert' },
    headSha: HEAD, headDiffSha: HEAD, headDiff: DIFF.replace('+new', '+numbered') };
  it.each(['off', 'unread live diff'])('refuses %s before attempting numbering', (kind) => {
    let calls = 0;
    const e = { ...evidence, humanClearance: { ...evidence.humanClearance } };
    if (kind === 'unread live diff') e.headDiff = null;
    const d = proveHumanClearanceCarry({ evidence: e, enabled: kind !== 'off',
      proveNumbering: () => { calls++; return { ok: true }; } });
    expect(d.carry).toBe(false);
    expect(calls).toBe(0);
  });
  it('carries a fingerprint mismatch only with a numbering proof', () => {
    const d = proveHumanClearanceCarry({ evidence, proveNumbering: () => ({ ok: true, reason: 'verified renames' }) });
    expect(d).toMatchObject({ carry: true, tier: 'numbering', actor: 'chalbert' });
    expect(buildCarryRecordBody({ ...d, headDiffText: evidence.headDiff })).toContain('card-numbering');
  });
  it('keeps the original refusal when numbering also refuses', () => {
    const d = proveHumanClearanceCarry({ evidence, proveNumbering: () => ({ ok: false, reason: 'mixed change' }) });
    expect(d.carry).toBe(false);
    expect(d.reason).toContain('net diff changed');
    expect(d.reason).toContain('numbering tier: mixed change');
  });
  // Red team #5233 (sibling writer): the slow proof runs between the drain's evidence read and its record write.
  describe('re-reads the PR before posting the carry record', () => {
    const objection = { author: { login: 'chalbert' }, body: 'Do not land this. I found a bug and am preparing findings.' };
    const apply = (over = {}) => {
      const posted = [];
      const exec = (cmd, args) => { if (cmd === 'gh') posted.push(args); return ''; };
      const result = applyHumanClearanceCarry({ evidence, pr: 5233, exec, setting: ON, log: () => {},
        proveNumbering: () => ({ ok: true, reason: 'verified renames' }), ...over });
      return { result, posted };
    };
    const liveThread = (extra = {}) => () => ({ headSha: HEAD, comments: [clearHumanComment(CLEARED)], reviews: [], ...extra });
    it('records a numbering carry when nothing changed', () => {
      const { result, posted } = apply({ readLiveEvidence: liveThread() });
      expect(result).toMatchObject({ carried: { tier: 'numbering', recorded: true } });
      expect(posted).toHaveLength(1);
    });
    it.each([false, true])('never records a numbering carry without a live re-read (dry run: %s)', (dryRun) => {
      const { result, posted } = apply({ dryRun });
      expect(result).toBeNull();
      expect(posted).toEqual([]);
    });
    it.each([
      ['an operator objection', liveThread({ comments: [clearHumanComment(CLEARED), objection] })],
      ['a formal changes-requested review', liveThread({ reviews: [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-10-13T00:00:00Z' }] })],
      ['a head move', liveThread({ headSha: 'f'.repeat(40) })],
      ['a newer clearance', liveThread({ comments: [clearHumanComment(CLEARED), clearHumanComment(HEAD)] })],
      ['unreadable reviews', liveThread({ reviews: null })],
      ['a truncated thread', liveThread({ comments: null })],
      ['a failed re-read', () => { throw Error('gh offline'); }],
    ])('defers without a record after %s', (_name, readLiveEvidence) => {
      const { result, posted } = apply({ readLiveEvidence });
      expect(result).toMatchObject({ action: 'defer', applyLabel: null });
      expect(posted).toEqual([]);
    });
  });
});

// Observed #5414 markers: the original clearance had BOTH fingerprints; it was not an agent acceptance.
it('#5414 recorded heads: carries chalbert and updates acceptance as well as clearance', () => {
  const old = '4301480ce5fddad5f0621c3933f4335734ec91d7';
  const head = '21ce5fcd9ecd13cb8e1262fd35108f5bbfbd822a';
  const before = 'fc7b05325a715a0f5f5dd07bed6223044fd92f2f39475906c5f7c4f4c303cd0a';
  const after = 'dc5d53c7d39b4f24465cf98f24122e860e479d5b6513b9e2e41471c0c410ad56';
  const comment = clearHumanComment(old, before);
  comment.id = 'IC_clearance';
  comment.createdAt = '2026-10-15T23:41:24Z';
  comment.body += '\n<!-- reviewed-contribution: 39a4211c1e0740f32e484ba867419a7ae9eb137b670c574790ce23e1de14ba40 -->';
  const posted = []; const logs = []; const proofs = [];
  const exec = (cmd, args) => {
    if (cmd === 'gh' && args[1] === 'view') return JSON.stringify({ headRefOid: head, headRefName: 'lane/5414', comments: [comment] });
    if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
      return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 1 } } } } });
    }
    if (cmd === 'gh' && args[0] === 'api') return args.some(a => a.includes('/comments'))
      ? [comment.body.replaceAll('\n', '\\n'), comment.createdAt, 'chalbert', comment.id].join('\t') : '';
    if (cmd === 'gh' && args[1] === 'comment') { posted.push(args[args.indexOf('--body') + 1]); return ''; }
    throw Error('unexpected command');
  };
  const gate = decideDrainReviewGate({ labels: ['review:accepted'], escalate: true, humanRequired: true, permissionChange: true }, {
    pr: 5414, repo: 'web-everything/web-everything', local: true, exec,
    files: ['scripts/conveyor/reconcile-core.mjs'], filesComplete: true, listedHeadSha: head,
    netDiff: () => ({ scored: true, text: after, rev: head, revSha: head }),
    carry: { setting: ON, numberingSetting: { value: true, source: 'platform' }, log: line => logs.push(line),
      proveNumbering: o => { proofs.push([o.fromSha, o.toSha]); return { ok: true, reason: 'verified x3o0ohn→#6178' }; } },
  });
  expect(gate.action).toBe('merge');
  expect(proofs).toEqual([[old, head]]);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toContain('<!-- cleared-human: chalbert -->');
  expect(posted[0]).toContain(`from=${old} to=${head}`);
  expect(logs.join('')).toContain('review.carryHumanClearanceAcrossNumbering=true (platform)');
});

// Observed with gh pr view 5403 --json comments,headRefOid on 2026-10-17.
describe('#5403 clearance → prevention notice → numbering-only move', () => {
  const comments = [
  {
    "id": "IC_kwDORBt1-c8AAAABc9nsTA",
    "author": {
      "login": "chalbert"
    },
    "authorAssociation": "MEMBER",
    "body": "✅ review — `review:human` cleared via the sanctioned path\n\nCleared by chalbert via `review-set-label.mjs --to=clear-human` (#2895).\n\n> operator: Yes to all\n\nWhat this record proves: the clearance went through the sanctioned tool, so the label swap, the `reviewed-sha` stamp and this comment exist and agree. What it does NOT prove: that a human performed it. The actor name and the reason above are free text and nothing verifies who supplied them — #2895 deferred the unforgeable actor signal (no local construct survives an agent with shell access on the same machine), and #2946 is the durable fix.\n\nOperator approval (human review ceremony), 2026-10-17, at head 1847d5a. Operator: \"Yes to all\".\n\nBoth operator blocks are fixed with tests: main's literal-variable fallback is restored when HOME is unknown (hook-level deny rows), and home-derived ordinary variables are expanded (including +=, HOME rebinding and subshell isolation). 3d8763b restores main's orchestrator delegation, heredoc hardening and exec baseline that the branch had lost. The scope stays inside leading-cd home handling (all-landings is card x5tbryq). The advisory review accepted this head, and all gates pass.\n\n<!-- reviewed-sha: 1847d5a95180c890b12066d321c86492f69b800f -->\n<!-- reviewed-diff: 4cefa20412e79463ce05cd4952f23182f35ed300261a0c486756f1e05f8b4cf5 -->\n<!-- reviewed-contribution: f9e10e90488b8716889ce8ed521ee44f7fe96d30359e2aaa71c2fc55b9998810 -->\n<!-- cleared-human: chalbert -->\n<!-- cleared-by-actor: bd616854-1f67-4f80-8be5-40fe1456e3bf -->",
    "createdAt": "2026-10-17T18:32:22Z",
    "includesCreatedEdit": false,
    "isMinimized": false,
    "minimizedReason": "",
    "reactionGroups": [],
    "url": "https://github.com/web-everything/web-everything/pull/5403#issuecomment-6238628940",
    "viewerDidAuthor": true
  },
  {
    "id": "IC_kwDORBt1-c8AAAABc9n1JA",
    "author": {
      "login": "chalbert"
    },
    "authorAssociation": "MEMBER",
    "body": "<!-- approval-prevention-filed:1847d5a95180c890b12066d321c86492f69b800f --> <!-- approval-prevention-job:prevention-card-mvcqhmu8-c1s2fd -->\nFiled the prevention guard(s) owed by web-everything/web-everything#5403's independent review, mechanically, on approval (operator rule, 2026-09-27) — queued for landing via a lane (tracking pid:15819).",
    "createdAt": "2026-10-17T18:32:30Z",
    "includesCreatedEdit": false,
    "isMinimized": false,
    "minimizedReason": "",
    "reactionGroups": [],
    "url": "https://github.com/web-everything/web-everything/pull/5403#issuecomment-6238631204",
    "viewerDidAuthor": true
  }
];
  const head = 'a4f64bada9fdaf725480907acb67fe4946085c77';
  it.each([
    ['exact filer notice', '', true],
    ['appended prose', '\nDo not merge this PR.', false],
    ['appended verdict', '\n**Verdict:** changes requested', false],
  ])('%s', (_name, suffix, carries) => {
    const posted = [];
    const result = applyHumanClearanceCarry({
      evidence: { humanClearance: { sha: '1847d5a95180c890b12066d321c86492f69b800f',
        diff: '4cefa20412e79463ce05cd4952f23182f35ed300261a0c486756f1e05f8b4cf5', actor: 'chalbert' },
        headSha: head, headDiffSha: head, headDiff: DIFF },
      pr: 5403, setting: ON, log: quiet,
      exec: (cmd, args) => { if (cmd === 'gh') posted.push([cmd, args]); return ''; },
      proveNumbering: () => ({ ok: true, reason: 'numbering-only move' }),
      readLiveEvidence: () => ({ headSha: head, reviews: [], comments: [comments[0],
        { ...comments[1], body: comments[1].body + suffix }] }),
    });
    if (carries) expect(result).toMatchObject({ carried: { tier: 'numbering', recorded: true } });
    else expect(result).toMatchObject({ action: 'defer', reason: expect.stringContaining('later verdict or unknown comment') });
    expect(posted).toHaveLength(carries ? 1 : 0);
  });
});
