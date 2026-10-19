/**
 * @file land-prevention-card.test.mjs — #4317. `landPreventionCard` is the detached job
 * `we:scripts/review-set-label.mjs#fileApprovalPreventionCard` spawns instead of shelling `file-item` inline:
 * it acquires a REAL lane, files the card there, commits it, runs the gate, opens the PR, and releases the
 * lane. This is the half of the #4317 regression proof that shows the card genuinely REACHES `main` — the
 * OTHER half (`review-set-label.approval-prevention-filing.test.mjs`) shows the calling checkout itself is
 * never written to.
 *
 * Every subprocess call is a scripted stub (`exec`) — no real `node`, `git`, `lane-pool.mjs` or `gh` runs
 * here, matching the no-fs/no-subprocess convention every sibling operation test already uses.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { readRaisedBy, raisedByFile } from '../../lib/raised-by.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  landPreventionCard as realLandPreventionCard, parseLandPreventionCardArgv, parseRunJsonTail, runLandPreventionCardCli,
  boundCardText, boundLandPreventionCardInput, CARD_TEXT_CAPS, buildLandingRetractionComment, postLandingRetraction,
  runCardDedupe, foldOpenSingles,
} from '../land-prevention-card.mjs';
import {
  hasApprovalPreventionMarkerForHead, buildApprovalPreventionMarker, buildApprovalPreventionJobMarker,
  buildApprovalPreventionKey, APPROVAL_PREVENTION_DIGEST_KEY_SEP,
} from '../../lib/approval-prevention-notice.mjs';
import { findBadBodyLinks } from '../../check-standards-rules.mjs';
import { renderItem } from '../../backlog/scaffold.mjs';
import yaml from 'js-yaml';
import { fileIntoBatch } from '../card-batch-file.mjs';
import { resolvePreventionBatchSettings } from '../../lib/card-batch-settings.mjs';
import { loadCardBatchPolicy } from '../../lib/card-batch-policy.mjs';

const landPreventionCard = (input, deps) => realLandPreventionCard(input, {
  pendingDir: '/tmp/no-prevention-spool-for-unit-tests',
  batch: async () => ({ batched: false, disabled: true, reason: 'per-card test' }), ...deps,
});

const INPUT = {
  title: 'File the prevention guard(s) owed by o/r#42\'s independent review',
  kind: 'story', size: '3', digest: '1. Reject malformed flags', scope: 'we:a.mjs', parent: '4075', queue: 'true',
  session: 'prevention-card-test',
};

/** A scripted `exec` keyed by which real call it stands in for, in call order. Each entry is either a JSON
 *  string to return, or a function `(cmd, args, opts) => string` for a call needing to inspect its own args. */
function scriptedExec(steps) {
  let i = 0;
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const step = steps[i];
    i += 1;
    if (!step) throw new Error(`scriptedExec: no step scripted for call #${i} (${cmd} ${args.join(' ')})`);
    if (typeof step === 'function') return step(cmd, args, opts);
    if (step instanceof Error) throw step;
    return step;
  };
  return { exec, calls };
}

const ACQUIRE_OK = JSON.stringify({ lane: 7, path: '/workspace/.lanes/web-everything/lane-7', session: 'prevention-card-test', holder: 'h' });
const FILE_ITEM_OK = JSON.stringify({ verdict: { num: 9001, rel: 'backlog/9001-file-the-prevention.md' } });
const VERIFY_GREEN = JSON.stringify({ verdict: { ok: true, passed: 2, failed: 0, unrun: 0, blocking: [] } });
const OPEN_PR_OPENED = JSON.stringify({
  runId: 'r1', op: 'open-pr', stopped: 'complete', applied: [], inFlight: [], pending: null,
  findings: { submit: { effects: [{ result: { outcome: 'opened', pr: 5555, url: 'https://github.com/web-everything/web-everything/pull/5555' } }] } },
});

describe('landPreventionCard — the real acquire → file-item → commit → verify → open-pr → release sequence', () => {
  // #4317 advisory review (2026-09-29 04:47, logic): a hash-id card has no `num`, and the first cut fell back to
  // ONE shared `lane/x-prevention-card` ref — two in-flight hash-id cards then collided on the same branch.
  it('two unnumbered (hash-id) cards open on DISTINCT branch refs', async () => {
    const refFor = async (rel, session) => {
      const fileOk = JSON.stringify({ verdict: { num: null, rel } });
      const { exec, calls } = scriptedExec([ACQUIRE_OK, fileOk, 'added', 'committed', VERIFY_GREEN, OPEN_PR_OPENED, 'labelled', 'released']);
      const result = await landPreventionCard({ ...INPUT, session }, {
        exec, write: () => {}, mkTmp: () => '/tmp/x', rmTmp: () => {}, writeFile: () => {},
      });
      expect(result.ok).toBe(true);
      return calls[5].args.find((a) => a.startsWith('--ref=')).slice('--ref='.length);
    };
    const a = await refFor('backlog/xab12cd-file-the-prevention.md', 'prevention-card-a');
    const b = await refFor('backlog/xef34gh-file-the-prevention.md', 'prevention-card-b');
    expect(a).toBe('lane/xab12cd-prevention-card');
    expect(b).toBe('lane/xef34gh-prevention-card');
    // No id derivable from the path at all → the job's own (unique) session slug, never a shared constant.
    const c = await refFor('backlog/weird.md', 'prevention-card-c');
    expect(c).toBe('lane/prevention-card-c');
    // A plain slug word is never mistaken for a hash id (it would collide across cards again).
    const d = await refFor('backlog/file-the-prevention.md', 'prevention-card-d');
    expect(d).toBe('lane/prevention-card-d');
  });

  it('lands the card: reaches an opened, labelled PR, and releases the lane', async () => {
    const { exec, calls } = scriptedExec([ACQUIRE_OK, FILE_ITEM_OK, 'added', 'committed', VERIFY_GREEN, OPEN_PR_OPENED, 'labelled', 'released']);
    const written = [];
    const result = await landPreventionCard(INPUT, {
      exec, write: () => {}, mkTmp: () => '/tmp/land-prevention-card-x', rmTmp: () => {}, writeFile: (p, c) => written.push({ p, c }),
    });
    expect(written.find(({ p }) => p.endsWith('commit-msg.txt')).c.split('\n')[0]).toBe('WE #9001: prevention — Reject malformed flags (from #42 review)');
    expect(result).toEqual({ ok: true, step: 'done', num: 9001, rel: 'backlog/9001-file-the-prevention.md', pr: 5555, url: 'https://github.com/web-everything/web-everything/pull/5555', reason: null });

    // acquire — a real lane, never the daemon clone that spawned this job.
    expect(calls[0].cmd).toBe('node');
    expect(calls[0].args[0]).toMatch(/scripts[/\\]lane-pool\.mjs$/);
    expect(calls[0].args.slice(1)).toEqual(['acquire', '--purpose=prevention-card', '--session=prevention-card-test', '--json']);
    // file-item — IN the acquired lane (cwd), running the LANE's OWN run.mjs (never a run.mjs resolved from
    // wherever this script itself lives — codex plan review, 2026-09-28: `scaffold-io.mjs`/`file-item-io.mjs`
    // resolve their repo root by SCRIPT LOCATION, not cwd, so running the wrong run.mjs would silently re-file
    // the card into the WRONG checkout even with `cwd: lane` set).
    expect(calls[1].opts.cwd).toBe('/workspace/.lanes/web-everything/lane-7');
    expect(calls[1].args[0]).toBe('/workspace/.lanes/web-everything/lane-7/scripts/operations/run.mjs');
    expect(calls[1].args).toContain('file-item');
    expect(calls[1].args).toContain('--title=Prevention — Reject malformed flags (from o/r#42 review)');
    // git add + commit, in the lane, of exactly the filed card.
    expect(calls[2].cmd).toBe('git');
    expect(calls[2].args).toEqual(['-C', '/workspace/.lanes/web-everything/lane-7', 'add', '--', 'backlog/9001-file-the-prevention.md']);
    expect(calls[3].cmd).toBe('git');
    expect(calls[3].args[0]).toBe('-C');
    expect(calls[3].args).toContain('commit');
    // verify — for real, `mode=run`, over the lane, via the LANE's OWN run.mjs.
    expect(calls[4].args[0]).toBe('/workspace/.lanes/web-everything/lane-7/scripts/operations/run.mjs');
    expect(calls[4].args).toContain('verify');
    expect(calls[4].args).toContain('--checkout=/workspace/.lanes/web-everything/lane-7');
    expect(calls[4].args).toContain('--mode=run');
    // open-pr — label-on-green, requiring the fresh verify marker, via the LANE's OWN run.mjs.
    expect(calls[5].args[0]).toBe('/workspace/.lanes/web-everything/lane-7/scripts/operations/run.mjs');
    expect(calls[5].args).toContain('open-pr');
    expect(calls[5].args).toContain('--mode=label-on-green');
    expect(calls[5].args).toContain('--requireVerified=true');
    expect(calls[5].args.some((a) => a.startsWith('--ref=lane/9001-'))).toBe(true);
    // release — the pool slot is freed once the content is pushed, by lane NUMBER.
    expect(calls[7].args).toEqual(expect.arrayContaining(['release', '--lane=7', '--session=prevention-card-test']));
    expect(written.some((w) => w.p.endsWith('commit-msg.txt') && w.c.includes('Co-Authored-By'))).toBe(true);
    expect(written.some((w) => w.p.endsWith('pr-body.md') && w.c.includes(INPUT.digest))).toBe(true);
  });

  // web-everything/web-everything#2766's own approval (2026-09-27) FAILED live because the OLD synchronous seam
  // (this file's own predecessor, inline in `review-set-label.mjs` before #4317) fell back to `execFileSync`'s
  // thrown `e.message` — Node's "Command failed: <cmd> <args…>" reconstruction — whenever `e.stderr` was empty,
  // which leaked a fragment of THIS CALL'S OWN argv (the multi-line digest running straight into the next
  // `--scope=` flag) instead of the real reason. The fix moved here with the rest of the seam: `e.stdout`
  // carries a real, structured `file-item` payload on an ordinary refusal, and it wins whenever it parses.
  it('#2766 regression, preserved at its new home: a real file-item refusal reports its own `.error`, never a leaked argv fragment', async () => {
    const digest = 'multi\nline\ndigest\ntext\n1. Reject malformed flags';
    const realError = 'locus-prefix: 1 bare code-path ref(s) lack a <repo>: prefix (#883)';
    const refusalStdout = JSON.stringify({ stopped: 'effect-halted', error: realError });
    const { exec, calls } = scriptedExec([
      ACQUIRE_OK,
      (cmd, args) => {
        const e = new Error(`Command failed: node scripts/operations/run.mjs file-item --digest=${digest} --scope=we:x --json`);
        e.status = 1; e.stdout = refusalStdout; e.stderr = '';
        throw e;
      },
      'released',
    ]);
    const result = await landPreventionCard({ ...INPUT, digest }, { exec, write: () => {} });
    expect(result).toMatchObject({ ok: false, step: 'file-item', reason: realError });
    expect(result.reason).not.toContain('--scope=');
    expect(calls).toHaveLength(3); // acquire, file-item (thrown), release — never a 4th, unretried call
  });

  it('acquire refusal: fails cleanly with no lane to release', async () => {
    const err = new Error('no free lane');
    const { exec, calls } = scriptedExec([err]);
    const result = await landPreventionCard(INPUT, { exec, write: () => {} });
    expect(result).toMatchObject({ ok: false, step: 'acquire' });
    expect(calls).toHaveLength(1); // no release call — nothing was ever acquired
  });

  it('a file-item refusal releases the lane and reports the real reason', async () => {
    const refused = JSON.stringify({ stopped: 'effect-halted', error: 'locus-prefix: bare ref' });
    const { exec, calls } = scriptedExec([ACQUIRE_OK, refused, 'released']);
    const result = await landPreventionCard(INPUT, { exec, write: () => {} });
    expect(result).toMatchObject({ ok: false, step: 'file-item', reason: 'locus-prefix: bare ref' });
    expect(calls.at(-1).args).toEqual(expect.arrayContaining(['release', '--lane=7']));
  });

  it('a red gate releases the lane and never opens a PR', async () => {
    const red = JSON.stringify({ verdict: { ok: false, blocking: [{ check: 'check:standards', why: 'failed', detail: '1 error' }] } });
    const { exec, calls } = scriptedExec([ACQUIRE_OK, FILE_ITEM_OK, 'added', 'committed', red, 'released']);
    const result = await landPreventionCard(INPUT, { exec, write: () => {}, mkTmp: () => '/tmp/x', rmTmp: () => {}, writeFile: () => {} });
    expect(result).toMatchObject({ ok: false, step: 'verify', num: 9001, rel: 'backlog/9001-file-the-prevention.md' });
    expect(result.reason).toContain('check:standards');
    expect(calls.at(-1).args).toEqual(expect.arrayContaining(['release']));
  });

  it('a refused PR (e.g. red required check) still releases the lane and reports the PR number if one exists', async () => {
    const refused = JSON.stringify({
      findings: { submit: { effects: [{ result: { outcome: 'refused', reason: 'check-red', pr: 5556, url: 'https://x/5556' } }] } },
    });
    const { exec, calls } = scriptedExec([ACQUIRE_OK, FILE_ITEM_OK, 'added', 'committed', VERIFY_GREEN, refused, 'released']);
    const result = await landPreventionCard(INPUT, { exec, write: () => {}, mkTmp: () => '/tmp/x', rmTmp: () => {}, writeFile: () => {} });
    expect(result).toMatchObject({ ok: false, step: 'open-pr', pr: 5556, reason: 'check-red' });
    // release happens even on an open-pr refusal (the lane's local worktree is done either way).
    expect(calls.some((c) => c.args?.includes?.('release'))).toBe(true);
  });

  // codex plan review (2026-09-28), finding 3: `mkTmp()`/`writeFile()` for the PR body used to sit OUTSIDE
  // any try/catch — a throw there (a full disk, a permission error) propagated out of this async function
  // uncaught, leaking the lane forever (never released) instead of failing cleanly.
  it('a PR-body write failure still releases the lane and fails cleanly, never leaking or throwing', async () => {
    const { exec, calls } = scriptedExec([ACQUIRE_OK, FILE_ITEM_OK, 'added', 'committed', VERIFY_GREEN, 'released']);
    const result = await landPreventionCard(INPUT, {
      exec, write: () => {}, mkTmp: () => '/tmp/x', rmTmp: () => {},
      // Succeeds for the commit-msg write, throws only on the LATER pr-body write.
      writeFile: (p) => { if (String(p).endsWith('pr-body.md')) throw new Error('ENOSPC: no space left'); },
    });
    expect(result).toMatchObject({ ok: false, step: 'unexpected' });
    expect(result.reason).toContain('ENOSPC');
    expect(calls.at(-1).args).toEqual(expect.arrayContaining(['release', '--lane=7']));
  });

  // #4317 advisory review (2026-09-29): every run used to `mkdtempSync` TWO scratch dirs (commit message, PR
  // body) and never remove either — a permanent `land-prevention-card-*` leak in the OS temp dir per filing.
  // Real dirs here (the default `rmTmp`), so the assertion is on the filesystem, not on a stub's call count.
  describe('scratch dir cleanup — the one scratch dir is created once and removed on every exit path', () => {
    const realScratch = () => {
      const made = [];
      const mkTmp = () => { const d = mkdtempSync(join(tmpdir(), 'land-prevention-card-test-')); made.push(d); return d; };
      return { made, mkTmp };
    };

    it('success: exactly one scratch dir, gone after the job returns', async () => {
      const { exec } = scriptedExec([ACQUIRE_OK, FILE_ITEM_OK, 'added', 'committed', VERIFY_GREEN, OPEN_PR_OPENED, 'labelled', 'released']);
      const { made, mkTmp } = realScratch();
      const result = await landPreventionCard(INPUT, { exec, write: () => {}, mkTmp });
      expect(result.ok).toBe(true);
      expect(made).toHaveLength(1);
      expect(existsSync(made[0])).toBe(false);
    });

    it('failure after the commit (gate red): the scratch dir is still removed', async () => {
      const VERIFY_RED = JSON.stringify({ verdict: { ok: false, blocking: ['x'] } });
      const { exec } = scriptedExec([ACQUIRE_OK, FILE_ITEM_OK, 'added', 'committed', VERIFY_RED, 'released']);
      const { made, mkTmp } = realScratch();
      const result = await landPreventionCard(INPUT, { exec, write: () => {}, mkTmp });
      expect(result).toMatchObject({ ok: false, step: 'verify' });
      expect(made).toHaveLength(1);
      expect(existsSync(made[0])).toBe(false);
    });
  });
});

// Dedupe before filing (operator go 2026-10-10): a REAL lane dir holding a real open card, the real planner, only the
// policy and the PR lookup injected (no gh, no settings file read).
describe('landPreventionCard — dedupe before filing', () => {
  const CLAIM = 'Treat any non-empty probeErrors as unreadable, or have readPrFacts expose a degraded flag. Add a table-driven test over each probe error string.';
  const AGAIN = 'Make deriveRow treat any non-empty facts.probeErrors as unreadable. Add a table-driven test over every probe error readPrFacts can emit.';
  const cardText = (status) => `---\nkind: story\nstatus: ${status}\ndateOpened: "2026-10-03"\n---\n\n`
    + `# Prevention — Treat probeErrors as unreadable (from o/r#10 review)\n\nFiled mechanically ON APPROVAL — owed:\n\n`
    + `1. \`we:scripts/review-ledger-check.mjs:40\` — ${CLAIM}\n\n## Done when\n\n1. tests pass\n`;
  const REL = 'backlog/4706-prevention-treat-probeerrors.md';
  let lane;
  const setup = (status = 'open') => {
    lane = mkdtempSync(join(tmpdir(), 'land-prevention-dedupe-'));
    mkdirSync(join(lane, 'backlog'));
    writeFileSync(join(lane, REL), cardText(status));
    return JSON.stringify({ lane: 7, path: lane, session: 's', holder: 'h' });
  };
  const dedupe = (input, o) => runCardDedupe(input, { ...o, loadPolicy: () => ({ dedupe: true, similarity: 0.3, source: { dedupe: 'test', similarity: 'test' } }), readPrCards: () => [] });
  const input = (file = 'scripts/review-ledger-check.mjs') => ({
    ...INPUT, title: 'Prevention — Make deriveRow treat probeErrors as unreadable (from o/r#77 review)',
    digest: `Filed mechanically ON APPROVAL — owed:\n\n1. \`we:${file}:44\` — ${AGAIN}\n\nIdempotency key (do not edit): approval-prevention-key:o/r#77@abc`,
    scope: `we:${file}`,
  });
  const cleanup = () => rmSync(lane, { recursive: true, force: true });

  it('A1 duplicate creates one raise file and leaves the parent byte-identical', async () => {
    const acquire = setup();
    try {
      const { exec, calls } = scriptedExec([acquire, 'added-card', 'committed', VERIFY_GREEN, OPEN_PR_OPENED, 'labelled', 'released']);
      const written = [];
      const batch = vi.fn();
      const result = await landPreventionCard(input(), {
        exec, batch, write: () => {}, mkTmp: () => '/tmp/x', rmTmp: () => {}, dedupe,
        writeFile: (p, c, e) => { written.push({ p, c }); if (p.startsWith(lane)) writeFileSync(p, c, e); },
      });
      expect(batch).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, step: 'done', num: null, rel: null, pr: 5555, mentions: 1 });
      expect(calls.some((c) => c.args.includes('file-item'))).toBe(false);
      expect(calls[1].args.slice(0, 4)).toEqual(['-C', lane, 'add', '--']);
      expect(calls[1].args[4]).toMatch(/^backlog\/raised-by\/4706\//);
      const after = readFileSync(join(lane, REL), 'utf8');
      expect(after).toBe(cardText('open'));
      expect(readRaisedBy('4706', lane)).toHaveLength(1);
      expect(readRaisedBy('4706', lane)[0].line).toContain('approval-prevention-key:o/r#77@abc');
      expect(written.find(({ p }) => p.endsWith('commit-msg.txt')).c.split('\n')[0]).toMatch(/^WE #4706: prevention — also raised: /);
      expect(calls[4].args.find((a) => a.startsWith('--ref='))).toBe('--ref=lane/prevention-card-test');
      const retry = scriptedExec([acquire, 'released']);
      const writeAgain = vi.fn();
      const again = await landPreventionCard(input(), { exec: retry.exec, dedupe, write: () => {}, writeFile: writeAgain });
      expect(again).toMatchObject({ ok: true, step: 'mentioned' });
      expect(writeAgain).not.toHaveBeenCalled();
      expect(readRaisedBy('4706', lane)).toHaveLength(1);
      expect(readFileSync(join(lane, REL), 'utf8')).toBe(cardText('open'));
    } finally { cleanup(); }
  });

  it('dry-run lists the exact new file without acquiring a lane or modifying the parent', async () => {
    setup();
    try {
      const exec = vi.fn();
      const write = vi.fn();
      const result = await landPreventionCard({ ...input(), dryRun: true, root: lane }, { exec, write, dedupe });
      expect(result).toMatchObject({ ok: true, step: 'dry-run', modifies: [] });
      expect(result.creates).toHaveLength(1);
      expect(result.creates[0]).toMatch(/^backlog\/raised-by\/4706\//);
      expect(exec).not.toHaveBeenCalled();
      expect(readFileSync(join(lane, REL), 'utf8')).toBe(cardText('open'));
      expect(readRaisedBy('4706', lane)).toEqual([]);
    } finally { cleanup(); }
  });

  it('a partial dedupe keeps the new card and lane-local mention together on the per-card path', async () => {
    const acquire = setup();
    try {
      const mixed = input();
      mixed.digest = mixed.digest.replace('\n\nIdempotency key',
        '\n\n2. `we:scripts/other-check.mjs:10` — Reject malformed flags before dispatch.\n\nIdempotency key');
      mixed.scope += ',we:scripts/other-check.mjs';
      const { exec, calls } = scriptedExec([acquire, 'mention-added', FILE_ITEM_OK, 'added', 'committed', VERIFY_GREEN, OPEN_PR_OPENED, 'labelled', 'released']);
      const batch = vi.fn(async () => ({ batched: true, batchRef: 'should-not-be-used' }));
      const result = await landPreventionCard(mixed, {
        exec, batch, dedupe, write: () => {}, mkTmp: () => '/tmp/x', rmTmp: () => {},
        writeFile: (p, c, e) => { if (p.startsWith(lane)) writeFileSync(p, c, e); },
      });
      expect(result).toMatchObject({ ok: true, step: 'done', rel: 'backlog/9001-file-the-prevention.md', mentions: 1 });
      expect(readFileSync(join(lane, REL), 'utf8')).toBe(cardText('open'));
      expect(readRaisedBy('4706', lane)).toHaveLength(1);
      expect(batch).not.toHaveBeenCalled();
      expect(calls.some(({ args }) => args.includes('file-item'))).toBe(true);
      expect(calls.some(({ args }) => args.includes('open-pr'))).toBe(true);
    } finally { cleanup(); }
  });

  it('a different target file is filed as today, and the open card is untouched', async () => {
    const acquire = setup();
    try {
      const { exec, calls } = scriptedExec([acquire, FILE_ITEM_OK, 'added', 'committed', VERIFY_GREEN, OPEN_PR_OPENED, 'labelled', 'released']);
      const result = await landPreventionCard(input('scripts/other-check.mjs'), { exec, write: () => {}, mkTmp: () => '/tmp/x', rmTmp: () => {}, writeFile: () => {}, dedupe });
      expect(result).toMatchObject({ ok: true, num: 9001 });
      expect(calls[1].args).toContain('file-item');
      expect(readFileSync(join(lane, REL), 'utf8')).toBe(cardText('open'));
    } finally { cleanup(); }
  });

  it('a claimed (status active) card is never touched: the finding is filed instead', async () => {
    const acquire = setup('active');
    try {
      const { exec, calls } = scriptedExec([acquire, FILE_ITEM_OK, 'added', 'committed', VERIFY_GREEN, OPEN_PR_OPENED, 'labelled', 'released']);
      const result = await landPreventionCard(input(), { exec, write: () => {}, mkTmp: () => '/tmp/x', rmTmp: () => {}, writeFile: () => {}, dedupe });
      expect(result).toMatchObject({ ok: true, num: 9001 });
      expect(calls[1].args).toContain('file-item');
      expect(readFileSync(join(lane, REL), 'utf8')).toBe(cardText('active'));
    } finally { cleanup(); }
  });

  it('a card claimed between the plan and the write is re-checked on the lane copy: filed, not mentioned', async () => {
    const acquire = setup();
    try {
      const { exec, calls } = scriptedExec([acquire, FILE_ITEM_OK, 'added', 'committed', VERIFY_GREEN, OPEN_PR_OPENED, 'labelled', 'released']);
      const racing = (i, o) => { const plan = dedupe(i, o); writeFileSync(join(lane, REL), cardText('active')); return plan; };
      const result = await landPreventionCard(input(), { exec, write: () => {}, mkTmp: () => '/tmp/x', rmTmp: () => {}, writeFile: () => {}, dedupe: racing });
      expect(result).toMatchObject({ ok: true, num: 9001 });
      const fileArgs = calls[1].args;
      expect(fileArgs).toContain('file-item');
      expect(fileArgs.find((a) => a.startsWith('--digest='))).toContain('probeErrors');
      expect(readFileSync(join(lane, REL), 'utf8')).toBe(cardText('active'));
    } finally { cleanup(); }
  });

  it('a dedupe that throws files exactly as before', async () => {
    const { exec, calls } = scriptedExec([ACQUIRE_OK, FILE_ITEM_OK, 'added', 'committed', VERIFY_GREEN, OPEN_PR_OPENED, 'labelled', 'released']);
    const result = await landPreventionCard(INPUT, { exec, write: () => {}, mkTmp: () => '/tmp/x', rmTmp: () => {}, writeFile: () => {}, dedupe: () => { throw new Error('boom'); } });
    expect(result).toMatchObject({ ok: true, num: 9001 });
    expect(calls[1].args).toContain('file-item');
  });
});

describe('parseLandPreventionCardArgv — PURE', () => {
  it('parses every required flag', () => {
    expect(parseLandPreventionCardArgv([
      '--title=t', '--kind=story', '--size=3', '--digest=d', '--scope=we:a.mjs', '--parent=4075', '--queue=true', '--session=s',
    ])).toEqual({
      title: 't', kind: 'story', size: '3', digest: 'd', scope: 'we:a.mjs', parent: '4075', queue: 'true', session: 's', retract: null,
    });
  });

  it('parses the retraction target only when all three --retract-* flags are present', () => {
    const base = ['--title=t', '--kind=story', '--size=3', '--digest=d', '--scope=we:a.mjs', '--queue=true', '--session=s'];
    expect(parseLandPreventionCardArgv([...base, '--retract-repo=o/r', '--retract-pr=7', '--retract-head=abc1234']).retract)
      .toEqual({ repo: 'o/r', pr: '7', headSha: 'abc1234' });
    expect(parseLandPreventionCardArgv([...base, '--retract-repo=o/r', '--retract-pr=7']).retract).toBeNull();
  });

  it('throws, by name, on a missing required flag', () => {
    expect(() => parseLandPreventionCardArgv(['--title=t'])).toThrow(/--kind=/);
  });

  it('defaults an omitted --parent to the empty string', () => {
    expect(parseLandPreventionCardArgv([
      '--title=t', '--kind=story', '--size=3', '--digest=d', '--scope=we:a.mjs', '--queue=true', '--session=s',
    ]).parent).toBe('');
  });
});

describe('parseRunJsonTail — tolerant of a leading warning line', () => {
  it('parses the JSON payload after a deprecation warning', () => {
    expect(parseRunJsonTail('(node:1) DeprecationWarning: x\n' + JSON.stringify({ ok: true }))).toEqual({ ok: true });
  });
  it('returns null on no parseable JSON', () => {
    expect(parseRunJsonTail('nothing here')).toBeNull();
  });
});

describe('runLandPreventionCardCli — exit-code mapping', () => {
  it('exits 0 and reports the PR on a successful land', async () => {
    const { code, result } = await runLandPreventionCardCli(
      ['--title=t', '--kind=story', '--size=3', '--digest=d', '--scope=we:a.mjs', '--queue=true', '--session=s'],
      { land: async () => ({ ok: true, step: 'done', num: 1, rel: 'r', pr: 9, url: 'u', reason: null }), write: () => {} },
    );
    expect(code).toBe(0);
    expect(result.pr).toBe(9);
  });

  it('exits 1 with the reason on stderr when the land did not reach a PR', async () => {
    const stderrLines = [];
    const { code } = await runLandPreventionCardCli(
      ['--title=t', '--kind=story', '--size=3', '--digest=d', '--scope=we:a.mjs', '--queue=true', '--session=s'],
      {
        land: async () => ({ ok: false, step: 'verify', num: 1, rel: 'r', pr: null, url: null, reason: 'gate red' }),
        write: () => {}, writeErr: (l) => stderrLines.push(l),
      },
    );
    expect(code).toBe(1);
    expect(stderrLines.join('')).toContain('verify');
    expect(stderrLines.join('')).toContain('gate red');
  });

  it('exits 1 on a bad argv, before any land is attempted', async () => {
    let landCalled = false;
    const { code } = await runLandPreventionCardCli(['--title=t'], {
      land: async () => { landCalled = true; return { ok: true }; }, write: () => {}, writeErr: () => {},
    });
    expect(code).toBe(1);
    expect(landCalled).toBe(false);
  });

  it('a failing land with --retract-* flags calls retract once; a retract that throws never changes the exit', async () => {
    const calls = [];
    const argv = ['--title=t', '--kind=story', '--size=3', '--digest=d', '--scope=we:a.mjs', '--queue=true',
      '--session=s1', '--retract-repo=o/r', '--retract-pr=7', `--retract-head=${'a'.repeat(40)}`];
    const failing = async () => ({ ok: false, step: 'acquire', num: null, rel: null, pr: null, url: null, reason: 'no lane' });
    const { code } = await runLandPreventionCardCli(argv, {
      land: failing, write: () => {}, writeErr: () => {},
      retract: (r) => { calls.push(r); throw new Error('gh down'); },
    });
    expect(code).toBe(1);
    expect(calls).toEqual([{ repo: 'o/r', pr: '7', headSha: 'a'.repeat(40), session: 's1', result: expect.objectContaining({ step: 'acquire' }) }]);
  });

  it('does NOT retract when a PR may already exist (open-pr named a PR but did not report `opened`)', async () => {
    const calls = [];
    const argv = ['--title=t', '--kind=story', '--size=3', '--digest=d', '--scope=we:a.mjs', '--queue=true',
      '--session=s1', '--retract-repo=o/r', '--retract-pr=7', `--retract-head=${'a'.repeat(40)}`];
    const { code } = await runLandPreventionCardCli(argv, {
      land: async () => ({ ok: false, step: 'open-pr', num: 1, rel: 'r', pr: 55, url: 'u', reason: 'check red' }),
      write: () => {}, writeErr: () => {}, retract: (r) => calls.push(r),
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe('card text bounding (#4317 advisory review, 2026-09-29)', () => {
  it('boundCardText strips control chars, neutralizes HTML comments, and caps with a visible note', () => {
    expect(boundCardText('a\u0007b\u001b[1m<!-- x -->\nc', 100)).toBe('a b [1m&lt;!-- x --&gt;\nc');
    // Never joins text around a stripped char into a new bare path the #883 gate would refuse.
    expect(boundCardText('use foo\u0007.mjs', 100)).toBe('use foo .mjs');
    expect(boundCardText('a\nb\tc', 100, { singleLine: true })).toBe('a b c');
    const long = boundCardText('y'.repeat(500), 120);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long).toMatch(/truncated: 380 chars over the 120-char cap/);
  });

  // #4317 advisory review (2026-09-29 04:47, security): the C0-only strip let Unicode format / bidi / line-separator
  // characters through, so a card that auto-lands on main could read differently to a human than to an agent.
  // Code points, never literal characters: the #2866 standards check forbids these invisibles in source.
  it.each([
    ['C1 NEL', 0x85], ['C1 CSI', 0x9b], ['line separator', 0x2028], ['paragraph separator', 0x2029],
    ['RLO bidi override', 0x202e], ['LRE bidi embedding', 0x202a], ['RLI bidi isolate', 0x2067],
    ['PDI bidi isolate', 0x2069], ['zero-width space', 0x200b], ['zero-width joiner', 0x200d],
    ['byte-order mark', 0xfeff], ['soft hyphen', 0xad], ['word joiner', 0x2060],
  ])('boundCardText neutralizes %s', (_name, cp) => {
    const ch = String.fromCodePoint(cp);
    expect(boundCardText(`a${ch}b`, 100)).toBe('a b');
    expect(boundCardText(`a${ch}b`, 100, { singleLine: true })).toBe('a b');
  });

  describe('wiki-link syntax in quoted reviewer text (#4457)', () => {
    it.each([
      ['a described link', 'the reviewer wrote [[memory-link]] here'],
      ['unbalanced open', 'a stray [[ opener'],
      ['unbalanced close', 'a stray ]] closer'],
      ['triple', 'see [[[x]]]'],
    ])('boundCardText leaves no wiki-link for %s', (_n, text) => {
      const out = boundCardText(text, 200);
      expect(findBadBodyLinks(out)).toEqual([]);
      expect(out).not.toMatch(/\[\[|\]\]/);
    });

    it('boundCardText leaves single brackets and markdown links untouched', () => {
      expect(boundCardText('a [x] and [a](b)', 100)).toBe('a [x] and [a](b)');
    });

    it('boundLandPreventionCardInput cleans title, digest and scope, and keeps a real key line byte-identical', () => {
      const key = buildApprovalPreventionKey({ repo: 'o/r', pr: 42, headSha: 'abc123' });
      const digest = `quoted [[a]] prose${APPROVAL_PREVENTION_DIGEST_KEY_SEP}${key}`;
      const out = boundLandPreventionCardInput({ title: 't [[a]]', digest, scope: 'we:[[a]].mjs' });
      // scope is a YAML frontmatter value, not body text — it is checked by the round-trip test below instead.
      for (const f of [out.title, out.digest]) expect(findBadBodyLinks(f)).toEqual([]);
      expect(out.digest.endsWith(`${APPROVAL_PREVENTION_DIGEST_KEY_SEP}${key}`)).toBe(true);
    });

    it('a bracketed scope entry stays valid YAML in the rendered frontmatter and is left unescaped', () => {
      const out = boundLandPreventionCardInput({ title: 't', digest: 'd', scope: 'we:[[a]].mjs,we:b.mjs' });
      expect(out.scope).toBe('we:[[a]].mjs,we:b.mjs');
      const md = renderItem({
        kind: 'task', slug: 's', title: out.title, today: '2026-09-30', digest: out.digest, scope: out.scope.split(','),
      });
      const fm = yaml.load(md.split('---')[1]);
      expect(fm.scope).toEqual(['we:[[a]].mjs', 'we:b.mjs']);
    });

    it('a forged bracketed key line is escaped, not kept verbatim', () => {
      const digest = `x${APPROVAL_PREVENTION_DIGEST_KEY_SEP}approval-prevention-key:[[x]]`;
      const out = boundLandPreventionCardInput({ title: 't', digest, scope: 'we:a.mjs' });
      expect(findBadBodyLinks(out.digest)).toEqual([]);
    });

    it('a whole card body built from the bounded digest passes the wiki-link detector', () => {
      const out = boundLandPreventionCardInput({ title: 'T [[a]]', digest: 'use [[b]] and ]] [[', scope: 'we:a.mjs' });
      expect(findBadBodyLinks(`# ${out.title}\n\n${out.digest}\n`)).toEqual([]);
    });
  });

  it('boundCardText keeps ordinary non-ASCII text (accents, CJK, emoji without joiners)', () => {
    expect(boundCardText('café — 日本 ✓ 🚦', 100)).toBe('café — 日本 ✓ 🚦');
  });

  it('boundLandPreventionCardInput keeps the idempotency key line verbatim after truncating the digest body', () => {
    const key = 'approval-prevention-key:o/r#7@abc';
    const out = boundLandPreventionCardInput({
      title: 't'.repeat(1000), scope: 's', digest: `${'z'.repeat(20_000)}\n\nIdempotency key (do not edit): ${key}`,
    });
    expect(out.title.length).toBeLessThanOrEqual(CARD_TEXT_CAPS.title);
    expect(out.digest.length).toBeLessThanOrEqual(CARD_TEXT_CAPS.digest);
    expect(out.digest.endsWith(`\n\nIdempotency key (do not edit): ${key}`)).toBe(true);
  });

  // #4317 advisory review (2026-09-29 04:47, simplicity): the key line's separator is the builder's own exported
  // constant, not a copy — so a real builder-produced digest always round-trips through the bound.
  it('keeps the key of a REAL builder-produced digest, via the shared separator constant', () => {
    const key = buildApprovalPreventionKey({ repo: 'o/r', pr: 7, headSha: 'ABC123' });
    const digest = `${'z'.repeat(20_000)}${APPROVAL_PREVENTION_DIGEST_KEY_SEP}${key}`;
    const out = boundLandPreventionCardInput({ title: 't', scope: 's', digest });
    expect(out.digest.endsWith(`${APPROVAL_PREVENTION_DIGEST_KEY_SEP}${key}`)).toBe(true);
    expect(out.digest.length).toBeLessThanOrEqual(CARD_TEXT_CAPS.digest);
  });

  it('a key-shaped line carrying an invisible char is NOT kept verbatim — it is bounded like ordinary text', () => {
    const rlo = String.fromCodePoint(0x202e);
    const digest = `body${APPROVAL_PREVENTION_DIGEST_KEY_SEP}approval-prevention-key:o/r#7@ab${rlo}cd`;
    const out = boundLandPreventionCardInput({ title: 't', scope: 's', digest });
    expect(out.digest.includes(rlo)).toBe(false);
  });

  it('a fake key line is bounded like ordinary text, and scope is capped by whole entries', () => {
    const fake = boundLandPreventionCardInput({
      title: 't', scope: 's', digest: `body\n\nIdempotency key (do not edit): ${'q '.repeat(9000)}`,
    });
    expect(fake.digest.length).toBeLessThanOrEqual(CARD_TEXT_CAPS.digest);
    const entries = Array.from({ length: 200 }, (_, i) => `we:scripts/dir/file-${i}.mjs`);
    const { scope } = boundLandPreventionCardInput({ title: 't', digest: 'd', scope: entries.join(',') });
    expect(scope.length).toBeLessThanOrEqual(CARD_TEXT_CAPS.scope);
    expect(scope.split(',').every((e) => entries.includes(e))).toBe(true);
  });

  it('short, ordinary card text passes through unchanged', () => {
    const input = { title: 'File the guard', scope: 'we:a.mjs,we:b.mjs', digest: 'line 1\n\n1. `we:a.mjs:3` — add a test' };
    expect(boundLandPreventionCardInput(input)).toEqual(input);
  });
});

describe('postLandingRetraction — a failed job retracts its own marker on the PR', () => {
  const headSha = 'c0ffee'.repeat(6) + 'abcd';

  it('posts the retraction via gh, and the posted body un-files exactly that job\'s marker', () => {
    const gh = [];
    const ok = postLandingRetraction(
      { repo: 'o/r', pr: '7', headSha, session: 'prevention-card-j1', result: { step: 'verify', reason: 'gate red' } },
      { exec: (cmd, args) => { gh.push([cmd, ...args]); return ''; }, write: () => {} },
    );
    expect(ok).toBe(true);
    expect(gh[0].slice(0, 6)).toEqual(['gh', 'pr', 'comment', '7', '--repo', 'o/r']);
    const retraction = gh[0][7];
    const author = { login: 'web-everything' };
    const marker = `${buildApprovalPreventionMarker({ headSha })} ${buildApprovalPreventionJobMarker('prevention-card-j1')}`;
    const other = `${buildApprovalPreventionMarker({ headSha })} ${buildApprovalPreventionJobMarker('prevention-card-j2')}`;
    expect(hasApprovalPreventionMarkerForHead([{ body: marker, author }], headSha)).toBe(true);
    // Order-independent: the retraction may land before the marker comment itself.
    expect(hasApprovalPreventionMarkerForHead([{ body: retraction, author }, { body: marker, author }], headSha)).toBe(false);
    // Another job's marker for the same head still counts.
    expect(hasApprovalPreventionMarkerForHead([{ body: marker, author }, { body: other, author }, { body: retraction, author }], headSha)).toBe(true);
    // An untrusted retraction is ignored.
    expect(hasApprovalPreventionMarkerForHead([{ body: marker, author }, { body: retraction, author: { login: 'rando' } }], headSha)).toBe(true);
  });

  it('never throws: a gh failure or an invalid head is narrated and reported as not posted', () => {
    const lines = [];
    expect(postLandingRetraction({ repo: 'o/r', pr: '7', headSha, session: 's', result: {} },
      { exec: () => { throw new Error('gh down'); }, write: (l) => lines.push(l) })).toBe(false);
    expect(postLandingRetraction({ repo: 'o/r', pr: '7', headSha: 'not-a-sha', session: 's', result: {} },
      { exec: () => { throw new Error('unreachable'); }, write: (l) => lines.push(l) })).toBe(false);
    expect(lines.join('')).toMatch(/gh down/);
    expect(lines.join('')).toMatch(/invalid head/);
    expect(buildLandingRetractionComment({ headSha: 'zz', session: 's' })).toBe('');
  });
});


describe('prevention batch landing', () => {
  const deps = { pendingDir: '/tmp/no-prevention-spool-for-unit-tests', dedupe: () => null, mkTmp: () => '/tmp/x', rmTmp: () => {}, writeFile: () => {},
    loadPreventionBatchSettings: () => resolvePreventionBatchSettings({ standard: loadCardBatchPolicy().prevention }) };
  it.each([null, { repo: 'o/r', pr: '42', headSha: 'abc' }])('hands a new hash card to the batch and releases without publishing (%j)', async (retract) => {
    const rel = 'backlog/x123456-prevention.md';
    const { exec, calls } = scriptedExec([ACQUIRE_OK, JSON.stringify({ verdict: { rel } }), 'released']);
    const batch = vi.fn(async () => ({ batched: true, batchRef: 'lane/card-batch-prevention-1' }));
    const write = vi.fn();
    const result = await realLandPreventionCard({ ...INPUT, title: 'Prevention guard', retract }, { ...deps, exec, batch, write });
    expect(result).toEqual({ ok: true, step: 'batched', num: null, rel, pr: null, url: null, reason: null, batchRef: 'lane/card-batch-prevention-1' });
    expect(batch).toHaveBeenCalledWith({ laneDir: JSON.parse(ACQUIRE_OK).path, cardPath: rel, kind: 'prevention',
      actor: 'mechanical', idemKey: 'prevention:x123456',
      source: { repo: 'web-everything/web-everything', pr: retract?.pr ?? null, head: retract?.headSha ?? null, note: retract ? 'Prevention guard (from o/r#42)' : 'Prevention guard' } }, expect.objectContaining({ retries: 30, pause: expect.any(Function) }));
    expect(calls).toHaveLength(3);
    expect(calls[2].args).toContain('release');
    expect(calls.some(({ args }) => ['commit', 'verify', 'open-pr'].some((op) => args.includes(op)))).toBe(false);
    expect(write).toHaveBeenCalledWith('land-prevention-card: batched ' + rel + ' into lane/card-batch-prevention-1\n');
  });
  it.each([1, 7])('waits through two held leases and batches with a %s minute budget', async (minutes) => {
    const preventionSettings = resolvePreventionBatchSettings({ standard: loadCardBatchPolicy().prevention,
      repo: { batchLeaseWaitMinutes: minutes } });
    const loadPreventionBatchSettings = vi.fn(() => preventionSettings);
    const sleep = vi.fn(async () => {});
    const admit = vi.fn()
      .mockResolvedValueOnce({ action: 'refuse', reason: 'lease-held' })
      .mockResolvedValueOnce({ action: 'refuse', reason: 'lease-held' })
      .mockResolvedValue({ action: 'admit', batchRef: 'lane/card-batch-prevention-1' });
    const batch = vi.fn((input, options) => {
      expect(options).toMatchObject({ pause: expect.any(Function), retries: expect.any(Number) });
      return fileIntoBatch(input, { ...options, admit,
        baseSha: 'a'.repeat(40), stateDir: '/tmp/unused-batch-state', launch: () => {}, log: () => {} });
    });
    const { exec, calls } = scriptedExec([ACQUIRE_OK, FILE_ITEM_OK, 'released']);
    expect(await realLandPreventionCard(INPUT, { ...deps, exec, batch, sleep, loadPreventionBatchSettings, write: () => {} }))
      .toMatchObject({ ok: true, step: 'batched' });
    expect(loadPreventionBatchSettings).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][1]).toMatchObject({ retries: minutes * 2, preventionSettings, pause: expect.any(Function) });
    expect(admit).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[30_000], [30_000]]);
    expect(calls).toHaveLength(3);
  });
  it('prevention results distinguish policy opt-out and include git stderr on admission errors', async () => {
    const options = { preventionSettings: deps.loadPreventionBatchSettings(), baseSha: 'a'.repeat(40),
      stateDir: '/tmp/unused-batch-state', log: () => {}, launch: () => {}, retries: 0 };
    const card = { laneDir: '/unused', cardPath: 'backlog/x123456-prevention.md', kind: 'prevention' };
    expect(await fileIntoBatch({ ...card, batch: false }, options)).toMatchObject({ disabled: true, batched: false });
    const error = Object.assign(new Error('git step failed'), { stderr: Buffer.from('fatal: missing base\nmore details') });
    expect(await fileIntoBatch(card, { ...options, admit: async () => { throw error; } }))
      .toMatchObject({ retryable: true, reason: 'admission failed: git step failed — fatal: missing base' });
  });
  it('exhausted lease wait holds the card after the configured retries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-prevention-test-'));
    const settings = resolvePreventionBatchSettings({ standard: loadCardBatchPolicy().prevention,
      repo: { batchLeaseWaitMinutes: 1 } });
    const admit = vi.fn(async () => ({ action: 'refuse', reason: 'lease-held' }));
    const sleep = vi.fn(async () => {});
    const batch = (input, options) => fileIntoBatch(input, { ...options, admit,
      baseSha: 'a'.repeat(40), stateDir: '/tmp/unused-batch-state', log: () => {} });
    try {
      const { exec, calls } = scriptedExec([ACQUIRE_OK, FILE_ITEM_OK, 'released']);
      expect(await realLandPreventionCard(INPUT, { ...deps, exec, batch, sleep, pendingDir: dir,
        readFile: () => 'card bytes', loadPreventionBatchSettings: () => settings, write: () => {} }))
        .toMatchObject({ step: 'held', reason: 'coordinator refused: lease-held' });
      expect(admit).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls).toEqual([[30_000], [30_000]]);
      expect(calls).toHaveLength(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('CLI recovery modes need no filing flags and print the fold JSON summary', async () => {
    const land = vi.fn(async () => ({ ok: true, step: 'folded', folded: [1], notFolded: [{ pr: 2, reason: 'multiple files' }] }));
    const lines = [];
    expect(parseLandPreventionCardArgv(['--drain-pending'])).toMatchObject({ drainPending: true });
    expect((await runLandPreventionCardCli(['--fold-open-singles', '--json'], { land, write: line => lines.push(line) })).code).toBe(0);
    expect(land.mock.calls[0][0]).toMatchObject({ foldOpenSingles: true });
    expect(JSON.parse(lines.at(-1))).toEqual({ folded: [1], notFolded: [{ pr: 2, reason: 'multiple files' }] });
  });
  it.each([
    ['--drain-pending', '--dry-run'],
    ['--dry-run', '--fold-open-singles'],
    ['--drain-pending', '--fold-open-singles', '--dry-run=true'],
  ])('CLI refuses recovery dry-run before dispatch: %j', async (...argv) => {
    const exec = vi.fn(() => { throw new Error('unexpected subprocess'); });
    const writeErr = vi.fn();
    const result = await runLandPreventionCardCli(argv, { exec, write: () => {}, writeErr });
    expect(exec).not.toHaveBeenCalled();
    expect(result.code).not.toBe(0);
    expect(writeErr.mock.calls.flat().join('')).toMatch(/dry-run.*recovery|recovery.*dry-run/i);
  });
  it.each([{ drainPending: true }, { foldOpenSingles: true }])('API refuses recovery dry-run before acquiring a lane: %j', async mode => {
    const exec = vi.fn(() => { throw new Error('unexpected subprocess'); });
    const dedupe = vi.fn(() => { throw new Error('unexpected dedupe'); });
    const result = await realLandPreventionCard({ ...mode, dryRun: true }, { exec, dedupe, write: () => {} });
    expect(exec).not.toHaveBeenCalled();
    expect(dedupe).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toMatch(/dry-run.*recovery|recovery.*dry-run/i);
  });
  it.each(['coordinator refused: lease-held', 'admission failed: git unavailable', 'throw'])('holds and spools on %s without publishing', async (reason) => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-prevention-test-'));
    try {
      const { exec, calls } = scriptedExec([ACQUIRE_OK, FILE_ITEM_OK, 'released']);
      const batch = vi.fn(async () => {
        if (reason === 'throw') throw new Error('git unavailable');
        return { batched: false, retryable: true, reason };
      });
      const result = await realLandPreventionCard(INPUT, { ...deps, exec, batch, pendingDir: dir,
        readFile: () => 'card bytes', write: () => {} });
      expect(result).toMatchObject({ ok: true, step: 'held', pr: null });
      expect(JSON.parse(readFileSync(join(dir, '9001.json'), 'utf8'))).toMatchObject({
        cardId: '9001', rel: 'backlog/9001-file-the-prevention.md', content: 'card bytes', idemKey: 'prevention:9001',
      });
      expect(calls.some(({ args }) => ['commit', 'verify', 'open-pr'].some(op => args.includes(op)))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('policy disable opens a labelled single PR', async () => {
    const { exec, calls } = scriptedExec([ACQUIRE_OK, FILE_ITEM_OK, 'added', 'committed', VERIFY_GREEN, OPEN_PR_OPENED, 'labelled', 'released']);
    const result = await realLandPreventionCard(INPUT, { ...deps, exec,
      batch: async () => ({ batched: false, disabled: true, reason: 'policy off' }), write: () => {} });
    expect(result.step).toBe('done');
    expect(calls[6]).toMatchObject({ cmd: 'gh', args: ['pr', 'edit', '5555', '--repo', 'web-everything/web-everything', '--add-label', 'review:pending'] });
  });
  it('drains a pending entry before its own filing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-prevention-test-'));
    const lane = join(dir, 'lane');
    mkdirSync(join(lane, 'backlog'), { recursive: true });
    const rel = 'backlog/x123456-pending.md';
    writeFileSync(join(dir, 'x123456.json'), JSON.stringify({ cardId: 'x123456', rel, content: 'pending bytes', idemKey: 'prevention:x123456', source: { repo: 'web-everything/web-everything' } }));
    try {
      const { exec } = scriptedExec([JSON.stringify({ lane: 7, path: lane }), () => '', FILE_ITEM_OK, 'released']);
      const batch = vi.fn(async () => ({ batched: true, batchRef: 'lane/card-batch-prevention-1' }));
      const write = vi.fn();
      const result = await realLandPreventionCard(INPUT, { ...deps, exec, batch, write, pendingDir: dir, writeFile: writeFileSync });
      expect(result.step).toBe('batched');
      expect(batch.mock.calls[0][0]).toMatchObject({ cardPath: rel, idemKey: 'prevention:x123456' });
      expect(existsSync(join(dir, 'x123456.json'))).toBe(false);
      expect(write.mock.calls.flat().join('')).toContain('from the pending spool');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['refused', 'landed', 'lookup-error'])('drain-only mode releases its lane and handles a %s entry safely', async (state) => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-prevention-test-'));
    const lane = join(dir, 'lane');
    mkdirSync(join(lane, 'backlog'), { recursive: true });
    const rel = 'backlog/x123456-pending.md';
    const spool = join(dir, 'x123456.json');
    writeFileSync(spool, JSON.stringify({ cardId: 'x123456', rel, content: 'pending bytes', idemKey: 'prevention:x123456', source: {} }));
    const batch = vi.fn(async () => ({ batched: false, retryable: true, reason: 'lease-held' }));
    const probe = state === 'lookup-error' ? new Error('missing origin/main') : () => state === 'landed' ? '100644 blob abc card' : '';
    const { exec, calls } = scriptedExec([JSON.stringify({ lane: 7, path: lane }), probe, 'released']);
    try {
      const result = await runLandPreventionCardCli(['--drain-pending'], {
        exec, pendingDir: dir, batch, write: () => {}, writeErr: () => {},
      });
      expect(result).toMatchObject({ code: 0, result: { step: 'drained' } });
      expect(existsSync(spool)).toBe(state !== 'landed');
      expect(existsSync(join(lane, rel))).toBe(false);
      expect(batch).toHaveBeenCalledTimes(state === 'refused' ? 1 : 0);
      expect(calls.at(-1).args).toContain('release');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('fold mode admits only a single added card and never mutates the old PR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fold-prevention-test-'));
    mkdirSync(join(dir, 'backlog'));
    const rel = 'backlog/x123456-prevention.md';
    const calls = [];
    const exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes('list')) return JSON.stringify([
        { number: 1, headRefName: 'lane/x123456-prevention-card', headRefOid: 'a'.repeat(40), files: [{ path: rel }] },
        { number: 2, headRefName: 'lane/x654321-prevention-card', headRefOid: 'b'.repeat(40), files: [{ path: rel }, { path: 'other.md' }] },
      ]);
      if (args.includes('diff')) return `A\t${rel}\n`;
      if (args.includes('show')) return 'card bytes';
      return '';
    };
    const batch = vi.fn(async () => ({ batched: true, batchRef: 'lane/card-batch-prevention-1' }));
    try {
      const result = await foldOpenSingles({ lane: dir }, { exec, batch, write: () => {} });
      expect(result.folded).toEqual([1]);
      expect(result.notFolded).toEqual([{ pr: 2, reason: 'not exactly one added backlog card' }]);
      expect(batch.mock.calls[0][0]).toMatchObject({ idemKey: 'prevention:x123456',
        source: { pr: 1, head: 'a'.repeat(40), note: 'folded from #1' } });
      expect(existsSync(join(dir, rel))).toBe(false);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(calls.some(call => call.includes('close') || call.includes('edit'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('fold mode also takes a card the drain already renumbered (lane/x… head, backlog/<NNN>-… file)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fold-prevention-test-'));
    mkdirSync(join(dir, 'backlog'));
    const rel = 'backlog/6055-prevention-renumbered.md';
    const exec = (cmd, args) => {
      if (args.includes('list')) return JSON.stringify([
        { number: 5208, headRefName: 'lane/x2kaa36-prevention-card', headRefOid: 'c'.repeat(40), files: [{ path: rel }] }]);
      if (args.includes('diff')) return `A\t${rel}\n`;
      if (args.includes('show')) return 'card bytes';
      return '';
    };
    const batch = vi.fn(async () => ({ batched: true, batchRef: 'lane/card-batch-prevention-4' }));
    try {
      const result = await foldOpenSingles({ lane: dir }, { exec, batch, write: () => {} });
      expect(result.folded).toEqual([5208]);
      expect(batch.mock.calls[0][0]).toMatchObject({ cardPath: rel, idemKey: 'prevention:6055' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['batched', 'held'])('CLI treats %s as success without retracting the filing marker', async (step) => {
    const retract = vi.fn();
    const { code } = await runLandPreventionCardCli(
      ['--title=t', '--kind=story', '--size=3', '--digest=d', '--scope=we:a.mjs', '--queue=true', '--session=s',
        '--retract-repo=o/r', '--retract-pr=7', '--retract-head=abc'],
      { land: async () => ({ ok: true, step, pr: null, batchRef: 'lane/card-batch-prevention-1' }),
        retract, write: () => {}, writeErr: () => {} });
    expect(code).toBe(0);
    expect(retract).not.toHaveBeenCalled();
  });
});
