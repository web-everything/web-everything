/**
 * @file verdict-ledger-ref.test.mjs - the cutover of the verdict ledger from `ops/review-requests` (a full repo tree)
 *   to the ledger-only orphan ref `ops/verdict-ledger`: settings cascade, dual read (automatic once the new ref
 *   exists), writer switch (with cross-ref dedupe and absorb), the migration's idempotence, and CI reader parity.
 *   Never weakened: no row lost or duplicated; a read fails closed when it cannot be formed; the old ref is never written
 *   by the migration or by a switched writer.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveLedgerRefSettings, formatLedgerRefSettings, ledgerReadPlan, ledgerWritePlan, unionLedgerTexts, compareLedgerTexts,
  ledgerPushRefFor, ledgerFetchRefspec, LEGACY_LEDGER_BRANCH, DEFAULT_LEDGER_ONLY_BRANCH, LEDGER_REF_ENV, LEDGER_CUTOVER_ENV,
  LEDGER_RETIRED_OLD_TREE_ENV,
} from '../verdict-ledger-ref.mjs';
import { appendLedgerRows, readLedgerFromGit, ledgerGitPath } from '../verdict-ledger-io.mjs';
import { buildVerdictRecord } from '../verdict-ledger.mjs';
import { planMigration, applyMigration, CANDIDATE_REF } from '../../verdict-ledger-migrate.mjs';
import { withBareOrigin, git } from '../../operations/__tests__/helpers/real-repo.mjs';

const REPO = 'web-everything/web-everything';
const PATH = ledgerGitPath(REPO);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OLD = LEGACY_LEDGER_BRANCH;
const NEW = DEFAULT_LEDGER_ONLY_BRANCH;
const row = (pr, verdict = 'accepted') => buildVerdictRecord({ repo: REPO, pr, verdict, at: `2026-10-21T12:00:${String(pr % 60).padStart(2, '0')}.000Z`, source: 'test' });
const quiet = () => {};
const realGit = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...opts });
const cfg = (verdictLedger = {}) => ({ verdictLedger });
const prsOf = (text) => String(text).split('\n').filter(Boolean).map((l) => JSON.parse(l).pr);
const originTip = (ctx, b) => git(['rev-parse', `refs/heads/${b}`], { cwd: ctx.origin }).trim();
const originHas = (ctx, b) => ctx.originBranches().includes(b);
const onOrigin = (ctx, b) => prsOf(ctx.showOnOrigin(b, PATH));

/** Append through the real io-shell, direct path (no outbox), with the given ledger-ref settings. */
const append = (ctx, records, settings = cfg(), extra = {}) => appendLedgerRows({
  board: ctx.clone, repo: REPO, records: records.map((r) => (typeof r === 'number' ? row(r) : r)), outbox: false, gitRun: realGit,
  settings, env: {}, log: quiet, sleep: () => {}, ...extra,
});
const read = (ctx, settings = cfg(), extra = {}) => readLedgerFromGit({ board: ctx.clone, repo: REPO, settings, env: {}, log: quiet, ...extra });
const migrate = (ctx) => applyMigration({ board: ctx.clone, to: NEW, run: realGit, measure: false });

/** The old ref as it is live: a full repo tree beside the ledger. */
function seedLegacy(ctx) {
  ctx.seedOriginBranch(OLD, {
    'README.md': '# repo\n', 'scripts/a.mjs': 'export {};\n', '.github/workflows/apply-review-request.yml': 'on: push\n',
    'ops/review-requests/1-accepted.json': '{}\n',
  });
}

describe('ledger-ref settings: a cascade, defaults = today, logged with sources', () => {
  it('defaults: writes the old ref; reads the old ref plus the new one only if it exists; no pin', () => {
    const s = resolveLedgerRefSettings({ repo: {}, env: {} });
    expect(s).toMatchObject({ ref: NEW, cutover: 'off', retiredOldTree: null, writeBranch: OLD });
    expect(s.sources).toEqual({ ref: 'standard', cutover: 'standard', retiredOldTree: 'standard' });
    expect(ledgerReadPlan(s)).toEqual({ newRef: NEW, requireNew: false, fence: null });
    expect(ledgerWritePlan(s)).toEqual({ branch: OLD, dedupeAlso: NEW });
    expect(formatLedgerRefSettings(s)).toMatch(/cutover=off \(standard\).*writes -> ops\/review-requests; reads -> ops\/review-requests, plus ops\/verdict-ledger whenever it exists$/);
  });

  it('repo then env layers; env wins; invalid values ignored and named; a pin is ignored unless cutover is on', () => {
    const PIN = 'a'.repeat(40);
    const s = resolveLedgerRefSettings({ repo: cfg({ cutover: 'off', retiredOldTree: PIN }), env: { [LEDGER_CUTOVER_ENV]: 'on' } });
    expect(s).toMatchObject({ cutover: 'on', retiredOldTree: PIN, writeBranch: NEW, sources: { cutover: 'env', retiredOldTree: 'repo' } });
    expect(ledgerReadPlan(s)).toEqual({ newRef: NEW, requireNew: true, fence: { branch: OLD, tree: PIN } });
    expect(ledgerWritePlan(s)).toEqual({ branch: NEW, dedupeAlso: null });
    const offPin = resolveLedgerRefSettings({ repo: cfg({ retiredOldTree: PIN }), env: {} });
    expect(offPin.retiredOldTree).toBe(null);
    expect(offPin.overridden).toEqual([expect.stringMatching(/retiredOldTree ignored/)]);
    const bad = resolveLedgerRefSettings({ repo: cfg({ cutover: 'maybe', ref: 'main', retiredOldTree: 'x' }), env: { [LEDGER_REF_ENV]: 'refs/heads/main', [LEDGER_CUTOVER_ENV]: 'sideways', [LEDGER_RETIRED_OLD_TREE_ENV]: 'zz' } });
    expect(bad).toMatchObject({ ref: NEW, cutover: 'off', writeBranch: OLD });
    expect(bad.invalid).toEqual(['repo.verdictLedger.ref', 'repo.verdictLedger.cutover', 'repo.verdictLedger.retiredOldTree', `env.${LEDGER_REF_ENV}`, `env.${LEDGER_CUTOVER_ENV}`, `env.${LEDGER_RETIRED_OLD_TREE_ENV}`]);
  });

  it('cutover on without a pin reads the union and dedupes against the old ref', () => {
    const s = resolveLedgerRefSettings({ repo: cfg({ cutover: 'on' }), env: {} });
    expect(ledgerReadPlan(s)).toEqual({ newRef: NEW, requireNew: true, fence: null });
    expect(ledgerWritePlan(s)).toEqual({ branch: NEW, dedupeAlso: OLD });
  });

  it('a setting can never aim a ledger push outside the allow-list; the new ref is fetched by a glob, the old exactly', () => {
    expect(() => ledgerPushRefFor('main')).toThrow(/not a ledger ref/);
    expect(resolveLedgerRefSettings({ repo: cfg({ ref: OLD }), env: {} }).invalid).toEqual(['repo.verdictLedger.ref']);
    expect(ledgerPushRefFor(NEW)).toBe(`refs/heads/${NEW}`);
    expect(ledgerFetchRefspec(OLD)).toBe(`+refs/heads/${OLD}:refs/remotes/origin/${OLD}`);
    expect(ledgerFetchRefspec(NEW)).toBe(`+refs/heads/${NEW}*:refs/remotes/origin/${NEW}*`);
  });
});

describe('unionLedgerTexts: per-PR ownership, never a guessed order', () => {
  const r = (id, pr, verdict = 'accepted', sec = 0) => JSON.stringify({ id, pr, verdict, at: `2026-10-21T12:00:${String(sec).padStart(2, '0')}.000Z` });
  it('shared rows once; each PR reads exactly its owning ref\'s own sequence; malformed lines pass through', () => {
    const oldT = [r('a', 1), r('b', 2), 'not json', r('s', 9)].join('\n');
    const newT = [r('a', 1), r('b', 2), 'not json', r('c', 3), r('d', 1, 'changes')].join('\n');
    const u = unionLedgerTexts(oldT, newT);
    expect(u.ok).toBe(true);
    // PR 2, 9 and the malformed group are old-owned (old order); PR 1 and 3 are new-owned (new order).
    expect(u.text.split('\n').filter(Boolean)).toEqual([r('b', 2), 'not json', r('s', 9), r('a', 1), r('c', 3), r('d', 1, 'changes')]);
    expect(u).toMatchObject({ oldOnly: 1, newOnly: 2, newOwned: 2 });
    expect(compareLedgerTexts(oldT, newT)).toEqual({ oldOnly: 1, newOnly: 2, both: 3 });
  });
  it('AUDIT REPRO 1: a hold appended AFTER a shared accept stays after it, whatever its timestamp', () => {
    const accept = r('A', 7, 'accepted', 13);
    const hold = r('H', 7, 'changes', 12);
    const u = unionLedgerTexts(`${accept}\n`, `${accept}\n${hold}\n`);
    expect(u.ok).toBe(true);
    expect(u.text.split('\n').filter(Boolean)).toEqual([accept, hold]);
  });
  it('AUDIT REPRO 2: rows for one PR written on BOTH refs since they diverged are refused, not time-merged', () => {
    const u = unionLedgerTexts([r('o', 3, 'accepted', 30), r('acc', 7, 'accepted', 10)].join('\n'), r('hold', 7, 'changes', 20));
    expect(u).toMatchObject({ ok: false, reason: 'ambiguous-order' });
  });
  it('AUDIT REPRO 3: a repeated id with other bytes, on either ref, is refused; a different shared order is refused', () => {
    expect(unionLedgerTexts(r('X', 7), [r('X', 7), r('X', 7, 'changes')].join('\n'))).toMatchObject({ ok: false, reason: 'conflicting-row' });
    expect(unionLedgerTexts([r('X', 7), r('X', 7, 'changes')].join('\n'), '')).toMatchObject({ ok: false, reason: 'conflicting-row' });
    expect(unionLedgerTexts(r('a', 1), JSON.stringify({ id: 'a', pr: 1, verdict: 'nonsense' }))).toMatchObject({ ok: false, reason: 'conflicting-row' });
    expect(unionLedgerTexts([r('a', 1), r('b', 1)].join('\n'), [r('b', 1), r('a', 1)].join('\n'))).toMatchObject({ ok: false, reason: 'order-conflict' });
  });
  it('empty sides', () => {
    expect(unionLedgerTexts('', '').text).toBe('');
    expect(unionLedgerTexts('', `${r('x', 1)}\n`).text).toBe(`${r('x', 1)}\n`);
  });
});

describe('real git: dual read + writer switch + migration', () => {
  it('DEFAULT before the migration is today: writes and reads the old ref only, never creates the new one', async () => {
    await withBareOrigin(async (ctx) => {
      seedLegacy(ctx);
      append(ctx, [1, 2]);
      const r = read(ctx);
      expect(r.status).toBe('ok');
      expect(prsOf(r.text)).toEqual([1, 2]);
      expect(r.text).toBe(read(ctx, cfg(), { branch: OLD }).text);
      expect(originHas(ctx, NEW)).toBe(false);
    });
  });

  it('no old ref and no new ref: unreadable (fail closed), as today', async () => {
    await withBareOrigin(async (ctx) => {
      expect(read(ctx).status).toBe('unreadable');
    });
  });

  it('cutover on before the migration: the write FAILS LOUDLY and never creates the new ref; reads hold', async () => {
    await withBareOrigin(async (ctx) => {
      seedLegacy(ctx);
      append(ctx, [1]);
      expect(() => append(ctx, [2], cfg({ cutover: 'on' }))).toThrow();
      expect(originHas(ctx, NEW)).toBe(false);
      expect(read(ctx, cfg({ cutover: 'on' }))).toMatchObject({ status: 'unreadable', reason: 'required-ledger-ref-absent' });
      expect(read(ctx).status).toBe('ok'); // writers still on the old ref: today's read
    });
  });

  it('FULL CUTOVER: migrate, straggler, switch, absorb, dedupe, retire, fence, roll back — every row exactly once', async () => {
    await withBareOrigin(async (ctx) => {
      seedLegacy(ctx);
      append(ctx, [1, 2, 3]);
      const before = read(ctx);
      const m = migrate(ctx);
      expect(m).toMatchObject({ applied: true, state: 'created', parity: true });
      // The new ref is a ROOT commit whose tree is ONLY verdict-ledger/, with the old blob byte for byte.
      expect(git(['rev-list', '--parents', '-n1', NEW], { cwd: ctx.origin }).trim().split(' ')).toHaveLength(1);
      expect(git(['ls-tree', '--name-only', NEW], { cwd: ctx.origin }).trim()).toBe('verdict-ledger');
      expect(ctx.showOnOrigin(NEW, PATH)).toBe(ctx.showOnOrigin(OLD, PATH));
      // With DEFAULT settings the read is now the union, automatically, and equals the legacy read.
      expect(read(ctx)).toMatchObject({ status: 'ok', text: before.text });
      // A not-yet-switched writer appends to the OLD ref (a straggler).
      append(ctx, [4]);
      const oldWithStraggler = originTip(ctx, OLD);
      // Switched writers: the first one ABSORBS the straggler into the new ref, then appends its own rows.
      append(ctx, [5, 6], cfg({ cutover: 'on' }));
      append(ctx, [3, 4], cfg({ cutover: 'on' })); // replays of rows already on a ref: no duplicate anywhere
      expect(originTip(ctx, OLD)).toBe(oldWithStraggler); // a switched writer never touches the old ref
      expect(onOrigin(ctx, NEW)).toEqual([1, 2, 3, 4, 5, 6]);
      const u = read(ctx, cfg({ cutover: 'on' }));
      expect(u.status).toBe('ok');
      expect(prsOf(u.text).sort()).toEqual([1, 2, 3, 4, 5, 6]);
      // The migration report: the old ref adds nothing and the union forms cleanly -> retirable; nothing pushed.
      const rep = migrate(ctx);
      expect(rep).toMatchObject({ applied: false, state: 'diverged' });
      expect(rep.rowDelta.find((d) => d.path === PATH)).toMatchObject({ oldOnly: 0, newOnly: 2, both: 4, union: 'ok' });
      expect(rep.retirableOldTree).toBe(git(['rev-parse', `${OLD}:verdict-ledger`], { cwd: ctx.origin }).trim());
      const retired = cfg({ cutover: 'on', retiredOldTree: rep.retirableOldTree });
      expect(read(ctx, retired)).toMatchObject({ status: 'ok' });
      expect(prsOf(read(ctx, retired).text)).toEqual([1, 2, 3, 4, 5, 6]);
      // A straggler AFTER the pin moves the old ref's ledger tree: the fenced read holds instead of hiding it.
      append(ctx, [8]); // off-mode writer: also absorbs the new-only rows 5, 6 into the old ref first
      expect(onOrigin(ctx, OLD)).toEqual([1, 2, 3, 4, 5, 6, 8]);
      expect(read(ctx, retired)).toMatchObject({ status: 'unreadable', reason: 'retired-ref-moved' });
      // Kill switch = cutover off: readers keep the union, nothing written to the new ref vanishes; a replay of a
      // row that already landed on the new ref is not appended to the old one again.
      append(ctx, [5]);
      expect(onOrigin(ctx, OLD)).toEqual([1, 2, 3, 4, 5, 6, 8]);
      const k = read(ctx);
      expect(k.status).toBe('ok');
      expect(prsOf(k.text).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 8]);
      expect(new Set(prsOf(k.text)).size).toBe(7);
    });
  });

  it('a PR written on both refs since they diverged holds every read, and the next write absorbs it back to readable', async () => {
    await withBareOrigin(async (ctx) => {
      seedLegacy(ctx);
      append(ctx, [1]);
      migrate(ctx);
      const accept = row(9, 'accepted');
      const hold = buildVerdictRecord({ repo: REPO, pr: 9, verdict: 'changes', at: '2026-10-21T12:00:30.000Z', source: 'test' });
      append(ctx, [accept], cfg({ cutover: 'on' }));
      // A writer that bypasses the plan (explicit branch: an older build) writes the same PR to the old ref.
      append(ctx, [hold], cfg(), { branch: OLD });
      expect(read(ctx, cfg({ cutover: 'on' }))).toMatchObject({ status: 'unreadable', reason: 'union-ambiguous-order' });
      append(ctx, [10], cfg({ cutover: 'on' })); // absorbs the old-only hold, in the order the push saw it
      const r = read(ctx, cfg({ cutover: 'on' }));
      expect(r.status).toBe('ok');
      const nine = r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.pr === 9);
      expect(nine.map((x) => x.verdict)).toEqual(['accepted', 'changes']);
    });
  });

  it('the union FAILS CLOSED when the new ref exists but the fetch or a read cannot complete', async () => {
    await withBareOrigin(async (ctx) => {
      seedLegacy(ctx);
      append(ctx, [1]);
      migrate(ctx);
      const run = (a, o) => {
        if (a[0] === 'fetch') { const e = new Error('fatal: unable to access'); e.stderr = 'fatal: unable to access'; throw e; }
        return realGit(a, o);
      };
      expect(read(ctx, cfg(), { run }).status).toBe('unreadable');
      const showFails = (a, o) => { if (a[0] === 'show' && a[1].includes(NEW)) throw new Error('read failed'); return realGit(a, o); };
      expect(read(ctx, cfg(), { run: showFails }).status).toBe('unreadable');
    });
  });

  it('MIGRATION IDEMPOTENCE: same source tip -> same candidate id; dry run pushes nothing; re-apply is a no-op', async () => {
    await withBareOrigin(async (ctx) => {
      seedLegacy(ctx);
      append(ctx, [1, 2]);
      const oldTip = originTip(ctx, OLD);
      const a = planMigration({ board: ctx.clone, to: NEW, run: realGit, measure: false });
      const b = planMigration({ board: ctx.clone, to: NEW, run: realGit, measure: false });
      expect(a.candidate).toBe(b.candidate);
      expect(a).toMatchObject({ state: 'absent', parity: true, sourceTip: oldTip });
      expect(a.old.files).toBe(5); // README, a script, a workflow, a request file, the ledger
      expect(a.new.files).toBe(1);
      expect(git(['rev-parse', CANDIDATE_REF], { cwd: ctx.clone }).trim()).toBe(a.candidate);
      expect(originHas(ctx, NEW)).toBe(false); // dry run: nothing pushed
      expect(migrate(ctx)).toMatchObject({ applied: true, candidate: a.candidate });
      const d = migrate(ctx);
      expect(d).toMatchObject({ applied: false, state: 'identical', retirableOldTree: a.ledgerTree });
      expect(originTip(ctx, NEW)).toBe(a.candidate);
      expect(originTip(ctx, OLD)).toBe(oldTip); // the migration never writes the old ref
    });
  });

  it('the migration refuses a target outside the allow-list and a source other than the old ref', () => {
    expect(() => planMigration({ board: '/nonexistent', to: 'main', run: () => '' })).toThrow(/not a ledger ref/);
    expect(() => planMigration({ board: '/nonexistent', from: 'ops/other', to: NEW, run: () => '' })).toThrow(/source must be/);
  });
});

describe('CI reader parity: the workflows feed the same cascade', () => {
  for (const wf of ['apply-review-request.yml', 'merge-gate.yml']) {
    it(`${wf} passes the ledger-ref variables into the step that reads/writes the ledger`, () => {
      const text = readFileSync(join(ROOT, '.github', 'workflows', wf), 'utf8');
      for (const [envName, varName] of [[LEDGER_REF_ENV, 'VERDICT_LEDGER_REF'], [LEDGER_CUTOVER_ENV, 'VERDICT_LEDGER_CUTOVER'], [LEDGER_RETIRED_OLD_TREE_ENV, 'VERDICT_LEDGER_RETIRED_OLD_TREE']]) {
        expect(text).toContain(`${envName}: \${{ vars.${varName} }}`);
      }
    });
  }

  it('an unset repo variable (empty string) changes nothing', () => {
    const s = resolveLedgerRefSettings({ repo: {}, env: { [LEDGER_REF_ENV]: '', [LEDGER_CUTOVER_ENV]: '', [LEDGER_RETIRED_OLD_TREE_ENV]: '' } });
    expect(s).toMatchObject({ cutover: 'off', retiredOldTree: null, writeBranch: OLD, invalid: [] });
  });

  it('the merge-gate read shape (exec seam, strict byte-count check) reads the same rows before and after the cutover', async () => {
    await withBareOrigin(async (ctx) => {
      seedLegacy(ctx);
      append(ctx, [1, 2]);
      // The same exec wrapper merge-gate-check.mjs passes (blob size declared, byte count verified).
      const gateRead = (settings) => {
        let blobSize;
        return readLedgerFromGit({ board: ctx.clone, repo: REPO, settings, env: {}, log: quiet, exec: (args, opts) => {
          const out = realGit(args, opts);
          if (args[0] === 'cat-file' && args[1] === '-s') blobSize = Number(String(out).trim());
          if (args[0] === 'cat-file' && args[1] === 'blob' && Buffer.byteLength(out) !== blobSize) throw new Error('truncated');
          return out;
        } });
      };
      const legacy = gateRead(cfg());
      migrate(ctx);
      append(ctx, [3], cfg({ cutover: 'on' }));
      const dual = gateRead(cfg({ cutover: 'on' }));
      expect(prsOf(legacy.text)).toEqual([1, 2]);
      expect(prsOf(dual.text)).toEqual([1, 2, 3]);
      expect(dual.text.startsWith(legacy.text)).toBe(true);
    });
  });
});
