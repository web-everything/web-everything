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
  decideHumanClearanceCarry, latestHumanClearance, proveMechanicalMove, applyHumanClearanceCarry,
  resolveHumanClearanceCarrySetting, buildCarryRecordBody, HUMAN_CLEARANCE_CARRIED_MARKER, MAX_MECHANICAL_COMMITS, sanitizeActor,
} from '../human-clearance-carry.mjs';
import { normalizeDiffFingerprint, parseLatestHumanClearedSha, REVIEW_LABELS } from '../review-escalation.mjs';
import { decideDrainReviewGate } from '../../merge-ai-prs.mjs';

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
      .toEqual({ carry: true, fromSha: CLEARED, toSha: HEAD, fingerprint: FP, actor: 'chalbert' });
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
    expect(latestHumanClearance([clearHumanComment(CLEARED)])).toEqual({ sha: CLEARED, diff: FP, actor: 'chalbert' });
  });
  it('a later plain accept means no clearance to carry', () => {
    expect(latestHumanClearance([clearHumanComment(CLEARED), plainAccept(HEAD)])).toBe(null);
  });
  it('ignores an untrusted forger', () => {
    expect(latestHumanClearance([{ author: { login: 'mallory' }, body: clearHumanComment(CLEARED).body }])).toBe(null);
  });
  it('a diff-less clearance does NOT inherit an older accept\'s reviewed-diff', () => {
    expect(latestHumanClearance([plainAccept(PR4722.r1), clearHumanComment(CLEARED, null)])).toEqual({ sha: CLEARED, diff: null, actor: 'chalbert' });
  });
  it('a clearance with an empty actor is not an attributed clearance', () => {
    const c = { author: { login: 'chalbert' }, body: `<!-- reviewed-sha: ${CLEARED} -->\n<!-- reviewed-diff: ${FP} -->\n<!-- cleared-human: -->` };
    expect(latestHumanClearance([c])).toBe(null);
  });
  it('a short or mixed-case sha is not compared or fed to git', () => {
    const short = clearHumanComment(CLEARED.slice(0, 12));
    expect(latestHumanClearance([short])).toBe(null);
    expect(latestHumanClearance([clearHumanComment(CLEARED.toUpperCase())])).toEqual({ sha: CLEARED, diff: FP, actor: 'chalbert' });
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
  it('a history rewrite (rebase) is not', () => {
    const { dir, g, cleared } = setup();
    try {
      g('rebase', '-q', 'main');
      const r = proveMechanicalMove({ exec: exec(dir), fromSha: cleared, toSha: g('rev-parse', 'HEAD'), mainRef: 'main' });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('not an ancestor');
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
  if (cmd === 'git' && args[0] === 'rev-parse') return `${tip}\n`; // the sha the branch tip (the net diff's rev) resolves to
  if (cmd === 'gh' && args[1] === 'comment') { onComment(args[args.indexOf('--body') + 1]); return ''; }
  if (cmd !== 'git') throw new Error(`unexpected ${cmd}`);
  const ancestors = (sha) => { const seen = new Set(); const st = [sha]; while (st.length) { const s = st.pop(); if (seen.has(s)) continue; seen.add(s); st.push(...(parents[s] || [])); } return seen; };
  const mainSet = new Set([...main].flatMap((m) => [...ancestors(m)]));
  if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
    const [a, b] = args.slice(2);
    const ok = b === 'origin/main' ? mainSet.has(a) : ancestors(b).has(a);
    if (!ok) throw new Error('not ancestor');
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
      const opts = { pr: 4722, repo: 'web-everything/web-everything', local: true, exec,
        netDiff: () => ({ scored: true, text: PR4722.fp, rev: 'origin/lane/x' }), carry: { setting: ON, log: quiet } };
      const gate = decideDrainReviewGate({ labels: [REVIEW_LABELS.accepted], escalate: true, humanRequired: true, permissionChange: true }, opts);
      expect(gate.action).toBe('merge');
      expect(gate.carriedClearance).toMatchObject({ fromSha: from, toSha: PR4722.head, fingerprint: PR4722.fp, recorded: true });
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain(`<!-- ${HUMAN_CLEARANCE_CARRIED_MARKER}: from=${from} to=${PR4722.head} diff=${PR4722.fp} -->`);
      // Every reader of the binding (drain, review-hold reconcile, operator queue) now sees the live head cleared.
      expect(parseLatestHumanClearedSha([...comments, { viewerDidAuthor: true, body: posted[0] }])).toBe(PR4722.head);
    });
  }

  it('without the carry (setting off) the same state re-parks review:human — the bug', () => {
    const view = { headRefOid: PR4722.head, headRefName: 'lane/x', comments: [clearHumanComment(PR4722.e125, PR4722.fp), restampComment] };
    const exec = graphExec({ parents: pr4722Graph, main: [PR4722.main2], view });
    const gate = decideDrainReviewGate({ labels: [REVIEW_LABELS.accepted], escalate: true, humanRequired: true, permissionChange: true },
      { pr: 4722, local: true, exec, netDiff: () => ({ scored: true, text: PR4722.fp, rev: 'origin/lane/x' }), carry: { setting: { value: false, source: 'env' }, log: quiet } });
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
      { pr: 4722, local: true, exec, netDiff: () => ({ scored: true, text: over.diff || PR4722.fp, rev: 'origin/lane/x' }), carry: { setting: ON, log: quiet } });
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
    const exec = graphExec({ parents: pr4722Graph, main: [PR4722.main2], onComment: (b) => posted.push(b), view, tip });
    const gate = decideDrainReviewGate({ labels: [REVIEW_LABELS.accepted], escalate: true, humanRequired: true, permissionChange: true },
      { pr: 4722, local: true, exec, netDiff: () => ({ scored: true, text: PR4722.fp, rev: 'origin/lane/x' }), carry: { setting: ON, log: quiet } });
    expect(gate).toMatchObject({ action: 'park', applyLabel: REVIEW_LABELS.human });
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
      { pr: 4722, local: true, exec, netDiff: () => ({ scored: true, text: PR4722.fp, rev: 'origin/lane/x' }), carry: { setting: ON, log: quiet } });
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
      { pr: 4722, local: true, exec, netDiff: () => ({ scored: true, text: PR4722.fp, rev: 'origin/lane/x' }), carry: { setting: ON, log: quiet } });
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
      { pr: 4722, local: true, exec, netDiff: () => ({ scored: true, text: DIFF, rev: 'origin/lane/x' }), carry: { setting: ON, log: quiet } });
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
    const body = buildCarryRecordBody({ fromSha: CLEARED, toSha: HEAD, fingerprint: FP, actor: 'chalbert', headDiffText: DIFF });
    expect(body).toContain(`<!-- reviewed-sha: ${HEAD} -->`);
    expect(body).toContain(`<!-- reviewed-diff: ${FP} -->`);
    expect(body).toContain('<!-- cleared-human: chalbert -->');
  });
  it('neutralises newlines, markup, mentions and links in the actor wherever it is rendered', () => {
    const body = buildCarryRecordBody({ fromSha: CLEARED, toSha: HEAD, fingerprint: FP, actor: 'ev\nil <b>@victim</b> [x](http://e) `c`', headDiffText: DIFF });
    const prose = body.split('\n').find((l) => l.startsWith('Recorded by drain'));
    expect(prose).toContain('ev il');
    expect(prose).not.toMatch(/@|<|>|\]\(|`c`/);
    expect(body).not.toContain('@victim');
    expect(body.split('\n').filter((l) => l.includes('cleared-human:'))).toHaveLength(1);
    expect(parseLatestHumanClearedSha([{ viewerDidAuthor: true, body }])).toBe(HEAD);
  });
});
