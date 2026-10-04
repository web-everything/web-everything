/**
 * @file review-runner.test.mjs — proof of the IMPURE CLI half of the #2830 scheduled SHADOW review runner
 * (`we:scripts/review-runner.mjs`). The pure core is covered in `lib/__tests__/review-runner-core.test.mjs`; this
 * file covers the CLI-level orchestration the core cannot reach:
 *   • `runShadowPass` — the injected-`loadLedger` pass: a clean ledger records a WOULD-CLEAR (never applied), an
 *     empty ledger keeps parked (fail-closed), and a THROWING loader is caught per-PR (fail-closed record, the
 *     batch never aborts). Every record carries `mutated:false` — a shadow pass mutates nothing.
 *   • the singleton LEASE protocol — `acquireLease` / `releaseLease` round-trip on an OWNER MATCH (against an
 *     injected temp lock root, never the machine-global `~/.claude` home). This is the branch the review flagged:
 *     `releaseLease` releases ONLY when `readLockEntry(...).owner === runnerOwner()`, so a drift in the owner
 *     format or the lock-entry shape would make release a silent no-op (a stuck lease that quietly stops the
 *     runner). The test pins the owner-match both ways: same owner releases, a different owner does NOT.
 *   • `repoKeyForSlug` — the #2830 M3 slug↔key mapper the runner derives its ledger key from (fail-closed on an
 *     unknown slug, so `--repo` can never silently key an unrelated repo).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShadowPass, appendShadowRecords, acquireLease, releaseLease, runnerOwner } from '../review-runner.mjs';
import { readVerdictLedger, foldVerdictLedger } from '../lib/verdict-ledger.mjs';
import { readLockEntry } from '../readiness/file-locks.mjs';
import { resolveDispositionConfig } from '../lib/review-policy.mjs';
import { VERDICTS, MANDATORY_LENSES } from '../lib/jury-core.mjs';
import { repoKeyForSlug, CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

const CONFIG = resolveDispositionConfig();

describe('#3217 durable shadow observations', () => {
  let root;
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function isolate() {
    root = mkdtempSync(join(tmpdir(), 'review-runner-ledger-'));
    vi.stubEnv('WE_VERDICT_LEDGER_DIR', join(root, 'ledger'));
    vi.stubEnv('CONVEYOR_JURY_DIR', join(root, 'jury'));
  }

  it('round-trips both pass outcomes through the single writer without granting clearance', () => {
    isolate();
    const records = runShadowPass([
      { pr: 1, repo: 'we', labels: ['review:pending'] },
      { pr: 2, repo: 'we', labels: ['review:pending'] },
    ], CONFIG, (subject) => subject === 'we#1' ? cleanDiverseLedger() : []);
    appendShadowRecords(records, 'web-everything/web-everything');
    const rows = readVerdictLedger('web-everything/web-everything');
    expect(rows.map((r) => r.wouldClear)).toEqual([true, false]);
    for (const r of rows) {
      expect(r).toMatchObject({ verdict: 'observed', mode: 'shadow', applied: false, mutated: false, clears: false });
      expect(foldVerdictLedger(rows).get(r.pr)).toMatchObject({ current: null, clears: false, outstandingHolds: [] });
    }
    expect(records.every((r) => !r.applied && !r.mutated)).toBe(true);
  });

  it.each(['throws', 'refuses'])('continues appending after a writer %s, even if stderr throws', (failure) => {
    const records = runShadowPass([1, 2].map((pr) => ({ pr, repo: 'we', labels: ['review:pending'] })), CONFIG, () => []);
    const append = vi.fn().mockImplementationOnce(() => {
      if (failure === 'throws') throw new Error('disk full');
      return { ok: false, errors: ['refused'] };
    }).mockReturnValue({ ok: true });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('closed'); });
    expect(() => appendShadowRecords(records, 'web-everything/web-everything', append)).not.toThrow();
    expect(append).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('CLI reports normally with ledger failure=%s and makes only GitHub reads', (fail) => {
    isolate();
    mkdirSync(join(root, 'bin'));
    // Any unexpected command, including a label/comment/merge writer, fails the child probe.
    writeFileSync(join(root, 'bin', 'gh'), `#!/bin/sh
echo "$1 $2" >> "$WE_TEST_GH_CALLS"
if [ "$1 $2" = "pr list" ]; then
  [ "$3" = "--repo" ] && [ "$4" = "${CONSTELLATION_REPOS.we.slug}" ] || exit 98
  echo '[{"number":42,"labels":[{"name":"review:pending"}]}]'
else
  exit 99
fi
`, { mode: 0o755 });
    if (fail) writeFileSync(join(root, 'ledger'), 'not a directory');
    const child = spawnSync(process.execPath, ['scripts/review-runner.mjs', '--no-lock', '--json'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        WE_TEST_GH_CALLS: join(root, 'gh-calls') },
    });
    expect(child.status, child.stderr).toBe(0);
    expect(readFileSync(join(root, 'gh-calls'), 'utf8')).toBe('pr list\n');
    expect(JSON.parse(child.stdout)).toMatchObject({ ranPass: true, mode: 'shadow', mutations: 0 });
    if (fail) expect(child.stderr).toContain('verdict-ledger append failed');
    else expect(readVerdictLedger('web-everything/web-everything')).toEqual([
      expect.objectContaining({ pr: 42, mode: 'shadow', wouldClear: false, applied: false, mutated: false }),
    ]);
  });
});
// the fixed sentinel the runner keys its singleton lock by (mirrors RUNNER_LEASE_PATH in review-runner.mjs).
const LEASE_PATH = '<review-runner:singleton>';

// ── ledger builders (mirror review-runner-core.test.mjs) ───────────────────────────────────────────────────────
const CHARTER = 'judge';
const rosterEvent = (jurors, round = 0) => ({ type: 'roster-picked', round, jurors });
const verdictEvent = (jurorId, verdict, round = 0) => ({ type: 'verdict', round, jurorId, verdict });
function cleanDiverseLedger() {
  const jurors = [];
  const verdicts = [];
  for (const lens of MANDATORY_LENSES) {
    for (const slot of [1, 2]) {
      const id = `${lens}#${slot}`;
      jurors.push({ id, lens, charter: CHARTER });
      verdicts.push(verdictEvent(id, VERDICTS.ACCEPT));
    }
  }
  return [rosterEvent(jurors), ...verdicts];
}

describe('runShadowPass — the injected-ledger shadow pass (mutates nothing, fail-closed)', () => {
  it('records a WOULD-CLEAR (never applied) for a clean auto-dispose ledger', () => {
    const clearable = [{ pr: 974, repo: 'we', labels: ['review:pending'] }];
    const records = runShadowPass(clearable, CONFIG, () => cleanDiverseLedger());
    expect(records).toHaveLength(1);
    expect(records[0].subject).toBe('we#974');
    expect(records[0].wouldClear).toBe(true);
    expect(records[0].mutated).toBe(false);
    expect(records[0].applied).toBe(false);
    expect(records[0].mode).toBe('shadow');
  });

  it('keeps parked (fail-closed) for a PR whose ledger is empty', () => {
    const clearable = [{ pr: 975, repo: 'we', labels: ['review:pending'] }];
    const records = runShadowPass(clearable, CONFIG, () => []);
    expect(records[0].wouldClear).toBe(false);
    expect(records[0].ledgerFound).toBe(false);
    expect(records[0].mutated).toBe(false);
  });

  it('a THROWING loader is caught per-PR (fail-closed record, batch never aborts)', () => {
    const clearable = [
      { pr: 1, repo: 'we', labels: ['review:pending'] },
      { pr: 2, repo: 'we', labels: ['review:pending'] },
    ];
    const records = runShadowPass(clearable, CONFIG, (subject) => {
      if (subject === 'we#1') throw new Error('ledger read blew up');
      return cleanDiverseLedger();
    });
    expect(records).toHaveLength(2);              // the throwing PR did not abort the batch
    expect(records[0].wouldClear).toBe(false);    // fail-closed keep-parked
    expect(records[0].mutated).toBe(false);
    expect(records[1].wouldClear).toBe(true);     // the healthy PR still processed
  });
});

describe('the singleton LEASE protocol — owner-match release (the flagged branch)', () => {
  let root;
  afterEach(() => { if (root) { try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ } root = null; } });

  it('acquires free, then releases on an OWNER MATCH (and the lock is gone after)', () => {
    root = mkdtempSync(join(tmpdir(), 'review-runner-lease-'));
    const owner = runnerOwner();
    const acq = acquireLease(owner, Date.now(), root);
    expect(acq.ok).toBe(true);
    expect(readLockEntry(root, LEASE_PATH)).not.toBeNull();
    expect(releaseLease(owner, root)).toBe(true);
    expect(readLockEntry(root, LEASE_PATH)).toBeNull();
  });

  it('a DIFFERENT owner does NOT release the lease (never stomp a reclaimer)', () => {
    root = mkdtempSync(join(tmpdir(), 'review-runner-lease-'));
    const owner = runnerOwner();
    expect(acquireLease(owner, Date.now(), root).ok).toBe(true);
    expect(releaseLease('someone-else:0:review-runner', root)).toBe(false);
    expect(readLockEntry(root, LEASE_PATH)).not.toBeNull(); // still held by the real owner
    expect(releaseLease(owner, root)).toBe(true);           // the true owner can still release
  });

  it('a second acquire while the lease is LIVE is refused (singleton — benign no-op upstream)', () => {
    root = mkdtempSync(join(tmpdir(), 'review-runner-lease-'));
    const owner = runnerOwner();
    expect(acquireLease(owner, Date.now(), root).ok).toBe(true);
    const second = acquireLease('another-runner:1:review-runner', Date.now(), root);
    expect(second.ok).toBe(false);
  });
});

describe('repoKeyForSlug — the #2830 M3 slug↔key mapper (fail-closed)', () => {
  it('maps the WE slug and key to the we key', () => {
    expect(repoKeyForSlug('web-everything/web-everything')).toBe('we');
    expect(repoKeyForSlug('we')).toBe('we');
  });
  it('maps the impl repos', () => {
    expect(repoKeyForSlug('frontierui')).toBe('frontierui');
    expect(repoKeyForSlug('plateau-app')).toBe('plateau-app');
  });
  it('returns null for an unknown slug (the runner then refuses rather than keying it we)', () => {
    expect(repoKeyForSlug('chalbert/some-other-repo')).toBeNull();
    expect(repoKeyForSlug('')).toBeNull();
    expect(repoKeyForSlug(undefined)).toBeNull();
  });
});

it('recognizes owner-qualified sibling slugs', () => {
  expect(repoKeyForSlug('frontier-ui/frontierui')).toBe('frontierui');
  expect(repoKeyForSlug('plateauapp/plateau-app')).toBe('plateau-app');
});
