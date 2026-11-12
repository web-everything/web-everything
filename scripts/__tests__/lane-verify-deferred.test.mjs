/**
 * @file scripts/__tests__/lane-verify-deferred.test.mjs
 * @description R893 "verify deferred to CI": an infra-failed/unsettled verify records a distinct `deferred-to-ci`
 *   marker bound to the exact HEAD sha, in its OWN file so every existing marker reader sees it as not-green.
 *   Only pr-land's OPEN path (never `land`) accepts it, and ready-to-merge still needs a green CI `test` run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync as rf } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVerifyMarker, verifyGateDecision, VERIFY_FILENAME } from '../lib/lane-verify.mjs';
import {
  DEFERRED_FILENAME, buildDeferredRecord, recordTerminalVerifyOutcome, readDeferredMarker,
  deferredToCiDecision, appendDeferredDisclosure, ciTestGreenOnSha, readDeferredForSha,
  oneLine, DISCLOSURE_DETAIL_MAX, syncDeferredBody, deferredLabelRefusal, disclosureFor,
} from '../lib/lane-verify-deferred.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const infra = { reason: 'verify-unsettled', detail: 'verification unsettled: shard INVENTORY-INCOMPLETE' };
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'deferred-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const infraFinished = (sha = SHA) => ({ sha, status: 'infrastructure-failure', infrastructure: infra, exitCode: 75 });
const infraGate = { ok: false, status: 'infrastructure-failure', reason: 'verify-unsettled', detail: infra.detail };

describe('recording', () => {
  it('an infra-failed verify writes deferred-to-ci bound to the head sha with reason and evidence', () => {
    recordTerminalVerifyOutcome(dir, infraFinished());
    const rec = readDeferredMarker(dir);
    expect(rec).toMatchObject({ status: 'deferred-to-ci', sha: SHA, reason: 'verify-unsettled', infrastructure: infra });
    expect(rec.detail).toContain('INVENTORY-INCOMPLETE');
  });
  it('a red verify never writes deferred, and clears a stale one', () => {
    recordTerminalVerifyOutcome(dir, infraFinished());
    recordTerminalVerifyOutcome(dir, { sha: SHA, status: 'red', exitCode: 1 });
    expect(existsSync(join(dir, DEFERRED_FILENAME))).toBe(false);
  });
  it('a green verify clears a stale deferred marker', () => {
    recordTerminalVerifyOutcome(dir, infraFinished());
    recordTerminalVerifyOutcome(dir, { sha: SHA, status: 'green', exitCode: 0 });
    expect(readDeferredMarker(dir)).toBeNull();
  });
  it('refuses to build a record without a sha or infra evidence', () => {
    expect(buildDeferredRecord({ sha: null, infrastructure: infra })).toBeNull();
    expect(buildDeferredRecord({ sha: SHA, infrastructure: null })).toBeNull();
  });
});

describe('every existing marker reader treats deferred as not green', () => {
  it('readVerifyMarker does not see it; the finish-guard stays unverified', () => {
    recordTerminalVerifyOutcome(dir, infraFinished());
    expect(existsSync(join(dir, VERIFY_FILENAME))).toBe(false);
    expect(readVerifyMarker(dir)).toBeNull();
    expect(verifyGateDecision({ record: readVerifyMarker(dir), headSha: SHA }).ok).toBe(false);
  });
  it('a deferred-status record placed in the main marker file is never green', () => {
    expect(verifyGateDecision({ record: { sha: SHA, status: 'deferred-to-ci' }, headSha: SHA }).ok).toBe(false);
  });
  it('a torn deferred file reads as corrupt', () => {
    writeFileSync(join(dir, DEFERRED_FILENAME), '{nope');
    expect(readDeferredMarker(dir)).toEqual({ corrupt: true });
  });
});

describe('deferredToCiDecision (the open path only)', () => {
  const ok = (over = {}) => deferredToCiDecision({ gate: infraGate, deferred: buildDeferredRecord({ sha: SHA, infrastructure: infra, exitCode: 75 }), headSha: SHA, mode: 'park', ...over });
  it('accepts park, label-on-green and open-only, with a disclosure line', () => {
    for (const mode of ['park', 'label-on-green', 'open-only']) {
      const d = ok({ mode });
      expect(d.ok).toBe(true);
      expect(d.disclosure).toMatch(/^lane verify deferred to CI: verify-unsettled/);
    }
  });
  it('accepts an absent/unverified gate too', () => {
    expect(ok({ gate: { ok: false, status: 'unverified', reason: 'unverified' } }).ok).toBe(true);
  });
  it('refuses the land mode', () => { expect(ok({ mode: 'land' }).ok).toBe(false); });
  it('refuses red, corrupt and running gates', () => {
    for (const status of ['red', 'corrupt', 'running']) expect(ok({ gate: { ok: false, status } }).ok).toBe(false);
  });
  it('refuses a deferred marker for another sha, missing or corrupt', () => {
    expect(ok({ headSha: OTHER }).ok).toBe(false);
    expect(ok({ deferred: null }).ok).toBe(false);
    expect(ok({ deferred: { corrupt: true } }).ok).toBe(false);
    expect(ok({ deferred: { status: 'green', sha: SHA, reason: 'x', infrastructure: infra } }).ok).toBe(false);
  });
  it('rejects malformed or unknown infra evidence', () => {
    expect(buildDeferredRecord({ sha: SHA, infrastructure: true })).toBeNull();
    expect(buildDeferredRecord({ sha: SHA, infrastructure: { reason: 'anything', detail: 'x' } })).toBeNull();
    expect(ok({ deferred: { status: 'deferred-to-ci', sha: SHA, reason: 'x', infrastructure: true } }).ok).toBe(false);
    expect(ok({ deferred: { status: 'deferred-to-ci', sha: SHA, reason: 'verify-timeout', infrastructure: infra } }).ok).toBe(false);
  });
  it('is a no-op for an already-ok gate', () => { expect(ok({ gate: { ok: true, status: 'green' } }).ok).toBe(false); });
  it('disclosure is idempotent', () => {
    const once = appendDeferredDisclosure('Body', 'lane verify deferred to CI: r');
    expect(appendDeferredDisclosure(once, 'lane verify deferred to CI: r')).toBe(once);
  });
  it('appends the disclosure to a PR body', () => {
    expect(appendDeferredDisclosure('Body', 'lane verify deferred to CI: r')).toContain('lane verify deferred to CI: r');
  });
});

describe('ready-to-merge needs a green CI test check on the exact sha', () => {
  const view = (oid, rollup) => ({ headRefOid: oid, statusCheckRollup: rollup });
  it('green test on the exact sha passes', () => {
    expect(ciTestGreenOnSha(view(SHA, [{ name: 'test', conclusion: 'SUCCESS' }]), SHA)).toBe(true);
  });
  it.each([
    [view(SHA, [])],
    [view(SHA, [{ name: 'test', conclusion: 'FAILURE' }])],
    [view(SHA, [{ name: 'test', status: 'IN_PROGRESS', conclusion: '' }])],
    [view(SHA, [{ name: 'lint', conclusion: 'SUCCESS' }])],
    [view(SHA, [{ name: 'test', conclusion: 'SUCCESS' }, { name: 'test', status: 'IN_PROGRESS', conclusion: '' }])],
    [view(OTHER, [{ name: 'test', conclusion: 'SUCCESS' }])],
    [null],
  ])('refuses %j', (v) => { expect(ciTestGreenOnSha(v, SHA)).toBe(false); });
});

describe('a dispatcher-killed verify still defers (PR #6674 red team)', () => {
  // The dispatcher kills verify-lane on a queue/gate ceiling and settles `.lane-verify` itself
  // (recordKilledVerification); the killed child never runs its terminal hook, so no deferred file exists.
  let lane; let gitDir;
  beforeEach(async () => {
    const { execFileSync } = await import('node:child_process');
    lane = mkdtempSync(join(tmpdir(), 'deferred-lane-'));
    execFileSync('git', ['init', '-q', lane]);
    gitDir = join(lane, '.git');
  });
  afterEach(() => { rmSync(lane, { recursive: true, force: true }); });
  const writeMain = (rec) => writeFileSync(join(gitDir, VERIFY_FILENAME), JSON.stringify(rec));
  const killed = async (timedOutPhase = 'queue') => {
    const { recordKilledVerification } = await import('../conveyor/verify-dispatch.mjs');
    writeMain({ sha: SHA, status: 'running', startedAt: null, finishedAt: null, suites: null, exitCode: null, treeHash: null, runId: 'run-1' });
    recordKilledVerification(lane, { sha: SHA, runId: 'run-1' }, { status: null, signal: 'SIGKILL', timedOutPhase }, 1000);
  };
  // The exact pr-land open path: the finish-guard (require-verified) then the deferred decision.
  const openDecision = (headSha = SHA, mode = 'park') => {
    const gate = verifyGateDecision({ record: readVerifyMarker(gitDir), headSha, requireVerified: true });
    return deferredToCiDecision({ gate, deferred: readDeferredForSha(gitDir, headSha), headSha, mode });
  };

  it.each(['queue', 'gate'])('a %s-ceiling kill opens with the timeout disclosure', async (phase) => {
    await killed(phase);
    expect(readVerifyMarker(gitDir).status).toBe('infrastructure-failure');
    expect(existsSync(join(gitDir, DEFERRED_FILENAME))).toBe(false);
    const d = openDecision();
    expect(d).toMatchObject({ ok: true, reason: 'deferred-to-ci' });
    expect(d.disclosure).toMatch(/verify-timeout/);
  });
  it('still refuses the land mode', async () => {
    await killed();
    expect(openDecision(SHA, 'land')).toMatchObject({ ok: false, reason: 'mode-land' });
  });
  it('never carries a main-marker infra failure to another sha', async () => {
    await killed();
    expect(readDeferredForSha(gitDir, OTHER)).toBeNull();
    expect(openDecision(OTHER).ok).toBe(false);
  });
  it.each([
    ['red', { sha: SHA, status: 'red', exitCode: 1 }],
    ['green', { sha: SHA, status: 'green', exitCode: 0 }],
    ['running', { sha: SHA, status: 'running' }],
    ['legacy red with a signal', { sha: SHA, status: 'red', exitCode: 137, signal: 'SIGKILL' }],
    ['infra with an unknown reason', { sha: SHA, status: 'infrastructure-failure', infrastructure: { reason: 'disk-full', detail: 'x' } }],
    ['infra with no evidence', { sha: SHA, status: 'infrastructure-failure' }],
  ])('a %s main marker yields no deferred record', (_, rec) => {
    writeMain(rec);
    expect(readDeferredForSha(gitDir, SHA)).toBeNull();
  });
  it('a corrupt main marker yields no deferred record', () => {
    writeFileSync(join(gitDir, VERIFY_FILENAME), '{torn');
    expect(readDeferredForSha(gitDir, SHA)).toBeNull();
  });
  it('the record always comes from the main marker, never from a stale or older deferred file', async () => {
    recordTerminalVerifyOutcome(gitDir, infraFinished(OTHER));
    expect(readDeferredForSha(gitDir, SHA)).toBeNull();
    await killed();
    expect(readDeferredForSha(gitDir, SHA)).toMatchObject({ status: 'deferred-to-ci', sha: SHA, reason: 'verify-timeout' });
    // An older same-sha deferred file with different evidence (a later kill does not rewrite it) is not used.
    recordTerminalVerifyOutcome(gitDir, infraFinished(SHA));
    expect(readDeferredForSha(gitDir, SHA)).toMatchObject({ sha: SHA, reason: 'verify-timeout' });
  });
  it('an exact-sha deferred file is ignored once the main marker holds a red verdict for that sha', () => {
    recordTerminalVerifyOutcome(gitDir, infraFinished(SHA));
    writeMain({ sha: SHA, status: 'red', exitCode: 1 });
    expect(readDeferredForSha(gitDir, SHA)).toBeNull();
  });
  // PR #6674 round 2 — a stale deferred file alone (main marker removed by `reset` / a manual rm, or re-requested)
  // can never authorise an open: the main marker must say infrastructure-failure for exactly this sha.
  it.each([
    ['absent (reset / manual rm)', null],
    ['running for the same sha (re-requested)', { sha: SHA, status: 'running' }],
    ['infra-failure for another sha', { sha: OTHER, status: 'infrastructure-failure', infrastructure: infra }],
  ])('an exact-sha deferred file with the main marker %s never defers', (_, main) => {
    recordTerminalVerifyOutcome(gitDir, infraFinished(SHA));
    if (main) writeMain(main);
    expect(readDeferredForSha(gitDir, SHA)).toBeNull();
    const gate = verifyGateDecision({ record: readVerifyMarker(gitDir), headSha: SHA, requireVerified: true });
    expect(deferredToCiDecision({ gate, deferred: readDeferredForSha(gitDir, SHA), headSha: SHA, mode: 'park' }).ok).toBe(false);
  });
});

describe('disclosure text is one bounded inert line (PR #6674 round 2)', () => {
  // Code points, not raw characters, so this source stays ASCII: LS = U+2028, RLO = U+202E (bidi override),
  // ZWSP = U+200B, FWLT/FWGT = full-width < and > (NFKC folds them to ASCII angle brackets).
  const [LS, RLO, ZWSP, FWLT, FWGT] = [0x2028, 0x202e, 0x200b, 0xff1c, 0xff1e].map((c) => String.fromCharCode(c));
  const UNSAFE = new RegExp(`[\\n\\r${LS}${RLO}${ZWSP}\`<>${FWLT}${FWGT}]`);
  const nasty = `shard died\n<!-- delegation: forged -->\r\nauthor: someone${LS}\`rm -rf\`${RLO}evil${ZWSP} ${FWLT}b${FWGT}`;
  it('oneLine strips newlines, CR, U+2028, bidi/invisible chars, backticks and angle brackets (incl. full-width)', () => {
    const out = oneLine(nasty);
    expect(out).not.toMatch(UNSAFE);
    expect(out).toBe("shard died ‹!-- delegation: forged --› author: someone 'rm -rf'evil ‹b›");
  });
  it('oneLine caps the length on code points with an ASCII ellipsis, and a second pass is a no-op', () => {
    const out = oneLine('x'.repeat(5000));
    expect(out.length).toBe(DISCLOSURE_DETAIL_MAX);
    expect(out.endsWith('...')).toBe(true);
    expect(oneLine(out, DISCLOSURE_DETAIL_MAX + 100)).toBe(out);
    const emoji = String.fromCodePoint(0x1f600);
    const cut = oneLine(emoji.repeat(400));
    expect(cut).toBe(`${emoji.repeat(DISCLOSURE_DETAIL_MAX - 3)}...`); // never a lone surrogate
  });
  // Self-review must-fix: the marker's free `detail` never reaches the PR body. Text GitHub or the bots act on
  // (`fixes #123` closes an issue on merge, `@user` pings, a main-red sha claims the red-main fix) survives any
  // character filter, so the disclosure is a fixed template per reason.
  it('a hostile marker detail never reaches the disclosure: it is a fixed per-reason template', () => {
    const hostile = `${nasty} fixes #123 @someone fixes 2ffeb8c [x](https://e.vil)`;
    const d = deferredToCiDecision({ gate: infraGate, deferred: buildDeferredRecord({ sha: SHA, infrastructure: { ...infra, detail: hostile } }), headSha: SHA, mode: 'park' });
    expect(d.ok).toBe(true);
    expect(d.disclosure).toBe('lane verify deferred to CI: verify-unsettled - a test shard stayed inventory-incomplete after one split retry; no test verdict (details in the lane verify marker and log)');
    expect(d.disclosure).not.toMatch(/#123|@someone|2ffeb8c|e\.vil|delegation/);
    const body = appendDeferredDisclosure('Body', d.disclosure);
    const added = body.slice('Body'.length).split('\n').filter(Boolean);
    expect(added).toHaveLength(2);
    for (const line of added) expect(line.startsWith('> ')).toBe(true);
  });
  it.each([
    [{ reason: 'verify-timeout', phase: 'queue', ceilingMs: 1000, detail: 'x' }, 'verify-timeout - the verify process tree was killed after the 1000ms queue-phase ceiling;'],
    [{ reason: 'verify-timeout', phase: 'gate @x', ceilingMs: '9 fixes #1', detail: 'x' }, 'verify-timeout - the verify process tree was killed after the ceiling;'],
    [{ reason: 'verify-signal', signal: 'SIGTERM', detail: 'x' }, 'verify-signal - the verify process ended on SIGTERM;'],
    [{ reason: 'verify-signal', signal: 'SIGKILL fixes #9', detail: 'x' }, 'verify-signal - the verify process ended on a signal;'],
    [{ reason: 'remote-termination-unconfirmed', detail: 'x' }, 'remote-termination-unconfirmed - the remote verify run could not be confirmed terminated;'],
  ])('disclosureFor fills in only validated fields: %j', (infrastructure, want) => {
    expect(disclosureFor(infrastructure)).toContain(want);
  });
  it('disclosureFor refuses an unknown reason', () => {
    expect(disclosureFor({ reason: 'disk-full', detail: 'x' })).toBeNull();
    expect(disclosureFor(null)).toBeNull();
  });
  it('appendDeferredDisclosure sanitises a raw multi-line disclosure too, and stays idempotent', () => {
    const once = appendDeferredDisclosure('Body\n', 'lane verify deferred to CI: x - a\nb');
    expect(once.split('\n').filter((l) => l.startsWith('> lane verify'))).toEqual(['> lane verify deferred to CI: x - a b']);
    expect(appendDeferredDisclosure(once, 'lane verify deferred to CI: x - a\nb')).toBe(once);
  });
});

describe('pr-land forge steps for a deferred open (fake forge, PR #6674 round 2)', () => {
  const fakeForge = ({ view, viewThrows = false } = {}) => {
    const calls = [];
    return {
      calls,
      editBody: (pr, body) => calls.push(['editBody', pr, body]),
      viewPr: (pr, fields) => { calls.push(['viewPr', pr, fields]); if (viewThrows) throw new Error('gh down'); return view; },
    };
  };
  const deferred = { ok: true, reason: 'deferred-to-ci', disclosure: 'lane verify deferred to CI: verify-timeout - killed after the gate ceiling' };
  const rollup = (sha, checks) => ({ headRefOid: sha, statusCheckRollup: checks });

  describe('deferredLabelRefusal — ready-to-merge is withheld without a green CI test on the exact sha', () => {
    it('a deferred PR whose test check is pending is refused with deferred-ci-not-green (no label)', () => {
      const forge = fakeForge({ view: rollup(SHA, [{ name: 'test', conclusion: '' }]) });
      expect(deferredLabelRefusal({ forge, prNum: 4060, sha: SHA, deferred })).toMatchObject({ reason: 'deferred-ci-not-green', pr: 4060, sha: SHA });
      expect(forge.calls).toEqual([['viewPr', 4060, 'headRefOid,statusCheckRollup']]);
    });
    it.each([
      ['a failed PR view', { viewThrows: true }],
      ['a null view', { view: null }],
      ['a green test on another sha', { view: rollup(OTHER, [{ name: 'test', conclusion: 'SUCCESS' }]) }],
      ['a green test plus a newer failed one', { view: rollup(SHA, [{ name: 'test', conclusion: 'SUCCESS' }, { name: 'test', conclusion: 'FAILURE' }]) }],
      ['no test check at all', { view: rollup(SHA, [{ name: 'lint', conclusion: 'SUCCESS' }]) }],
    ])('refuses on %s (fail closed)', (_, opts) => {
      expect(deferredLabelRefusal({ forge: fakeForge(opts), prNum: 1, sha: SHA, deferred })?.reason).toBe('deferred-ci-not-green');
    });
    it('allows the label once every test check-run on the exact sha is green', () => {
      expect(deferredLabelRefusal({ forge: fakeForge({ view: rollup(SHA, [{ name: 'test', conclusion: 'SUCCESS' }]) }), prNum: 1, sha: SHA, deferred })).toBeNull();
    });
    it('a PR that was not deferred never reads CI here', () => {
      const forge = fakeForge();
      expect(deferredLabelRefusal({ forge, prNum: 1, sha: SHA, deferred: null })).toBeNull();
      expect(forge.calls).toEqual([]);
    });
    it('open-pr reports the real emitted refusal as opened with the label step deferred, and HOME_REASONS knows it', async () => {
      const { classifySubmit } = await import('../operations/open-pr.mjs');
      const { HOME_REASONS } = await import('../operations/pr-land-reasons.mjs');
      const refusal = deferredLabelRefusal({ forge: fakeForge({ view: null }), prNum: 4060, sha: SHA, deferred });
      const r = classifySubmit({ status: 3, stdout: JSON.stringify({ repo: 'web-everything/web-everything', merged: false, ...refusal }) });
      expect(r).toMatchObject({ outcome: 'opened', reason: 'deferred-ci-not-green', labelStep: 'deferred', pr: 4060 });
      expect(classifySubmit({ status: 3, stdout: JSON.stringify({ reason: 'deferred-ci-not-green' }) }).outcome).toBe('unrun');
      expect(HOME_REASONS['deferred-ci-not-green']).toBe('unrun');
    });
  });

  describe('syncDeferredBody — an already-open PR gets the disclosure on rerun', () => {
    it('edits a deferred PR once, with the composed body plus the disclosure', () => {
      const forge = fakeForge();
      syncDeferredBody({ forge, prNum: 7, liveBody: 'old', composed: 'old + stamps', deferred });
      expect(forge.calls).toHaveLength(1);
      const [[verb, pr, body]] = forge.calls;
      expect([verb, pr]).toEqual(['editBody', 7]);
      expect(body.startsWith('old + stamps')).toBe(true);
      expect(body).toContain(`> ${deferred.disclosure}`);
    });
    it('a second rerun on a body that already carries the disclosure edits nothing', () => {
      const live = appendDeferredDisclosure('old + stamps', deferred.disclosure);
      const forge = fakeForge();
      syncDeferredBody({ forge, prNum: 7, liveBody: live, composed: live, deferred });
      expect(forge.calls).toEqual([]);
    });
    it('a non-deferred rerun keeps the plain stamp backfill (edit only when the body changed)', () => {
      const changed = fakeForge();
      syncDeferredBody({ forge: changed, prNum: 7, liveBody: 'old', composed: 'old + stamps', deferred: null });
      expect(changed.calls).toEqual([['editBody', 7, 'old + stamps']]);
      const same = fakeForge();
      syncDeferredBody({ forge: same, prNum: 7, liveBody: 'old', composed: 'old', deferred: null });
      expect(same.calls).toEqual([]);
    });
  });
});

describe('wiring (source pins)', () => {
  const readFileSync = (p, e) => rf(p, e);
  it('only pr-land and verify-lane reference the deferred module; the open path refuses land mode', async () => {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('git', ['grep', '-l', 'lane-verify-deferred', '--', 'scripts', ':!scripts/__tests__'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    expect(out).toEqual(['scripts/lib/lane-verify-deferred.mjs', 'scripts/pr-land.mjs', 'scripts/verify-lane.mjs'].sort());
    expect(readFileSync('scripts/pr-land.mjs', 'utf8')).toMatch(/mode: PLAN\.mode/);
    // PR #6674 red team — pr-land reads the deferred record through the main-marker fallback, never the bare file.
    expect(readFileSync('scripts/pr-land.mjs', 'utf8')).toMatch(/deferred: readDeferredForSha\(gitDir, refSha\)/);
  });
  // PR #6674 round 2 — the forge steps above are only as good as their call sites in pr-land and verify-lane.
  it('pr-land checks the deferred CI gate BEFORE applyLabel, exits 3 on refusal, and is the only applyLabel call', () => {
    const src = readFileSync('scripts/pr-land.mjs', 'utf8');
    expect(src).toMatch(/if \(PLAN\.labelWhenGreen\) \{\s*const deferredRefusal = deferredLabelRefusal\(\{ forge, prNum, sha: refSha, deferred: DEFERRED_TO_CI \}\);\s*if \(deferredRefusal\) emit\(\{ repo: REPO, merged: false, \.\.\.deferredRefusal \}, 3\);\s*applyLabel\(\);\s*\}/);
    expect(src.match(/^\s*(?:if \([^)]*\) )?applyLabel\(\);/gm)).toHaveLength(1);
  });
  it('pr-land adds the disclosure on create and on a rerun against an open PR', () => {
    const src = readFileSync('scripts/pr-land.mjs', 'utf8');
    expect(src).toMatch(/DEFERRED_TO_CI = deferredOpen;\s*CREATE_BODY = appendDeferredDisclosure\(CREATE_BODY, deferredOpen\.disclosure\);/);
    expect(src).toMatch(/const updated = composePrBody\(liveBody\);[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*syncDeferredBody\(\{ forge, prNum, liveBody, composed: updated, deferred: DEFERRED_TO_CI \}\);/);
  });
  it('verify-lane records the terminal outcome right after the marker write, and reset clears the deferred file on both paths', () => {
    const src = readFileSync('scripts/verify-lane.mjs', 'utf8');
    expect(src).toMatch(/writeMarker\(\{ \.\.\.finished,[^\n]*\n\s*maybeRecordGreen\([^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*try \{ recordTerminalVerifyOutcome\(GIT_DIR, finished\); \}/);
    const reset = src.slice(src.indexOf("if (MODE === 'reset') {"), src.indexOf("emit({ sha: headSha, status: 'reset'"));
    expect(reset.match(/clearDeferredMarker\(GIT_DIR\)/g)).toHaveLength(2);
  });
});
