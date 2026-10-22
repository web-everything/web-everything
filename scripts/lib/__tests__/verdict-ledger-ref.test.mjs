/**
 * @file verdict-ledger-ref.test.mjs - the cutover of the verdict ledger from `ops/review-requests` (a full repo tree)
 *   to the ledger-only orphan ref `ops/verdict-ledger`: settings cascade, dual read, writer switch, the migration's
 *   idempotence, and CI reader parity. Never weakened: no row lost or duplicated; a read fails closed when no ref can be
 *   read (or an existing one cannot); the old ref is never written by the migration or by a switched writer.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveLedgerRefSettings, formatLedgerRefSettings, ledgerReadPlan, ledgerWritePlan, unionLedgerTexts, compareLedgerTexts,
  ledgerPushRefFor, LEGACY_LEDGER_BRANCH, DEFAULT_LEDGER_ONLY_BRANCH, LEDGER_REF_ENV, LEDGER_CUTOVER_ENV, LEDGER_DUAL_READ_ENV,
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

/** Append through the real io-shell, direct path (no outbox), with the given ledger-ref settings. */
const append = (ctx, prs, settings = cfg()) => appendLedgerRows({
  board: ctx.clone, repo: REPO, records: prs.map((p) => row(p)), outbox: false, gitRun: realGit, settings, env: {}, log: quiet,
  sleep: () => {},
});
const read = (ctx, settings = cfg(), extra = {}) => readLedgerFromGit({ board: ctx.clone, repo: REPO, settings, env: {}, log: quiet, ...extra });

/** The old ref as it is live: a full repo tree beside the ledger. */
function seedLegacy(ctx) {
  ctx.seedOriginBranch(OLD, {
    'README.md': '# repo\n', 'scripts/a.mjs': 'export {};\n', '.github/workflows/apply-review-request.yml': 'on: push\n',
    'ops/review-requests/1-accepted.json': '{}\n',
  });
}

describe('ledger-ref settings: a cascade, defaults = today, logged with sources', () => {
  it('defaults: old ref for reads and writes, ledger-only ref named, nothing dual', () => {
    const s = resolveLedgerRefSettings({ repo: {}, env: {} });
    expect(s).toMatchObject({ ref: NEW, cutover: 'off', dualRead: false, writeBranch: OLD });
    expect(s.sources).toEqual({ ref: 'standard', cutover: 'standard', dualRead: 'standard', retiredOldTree: 'standard' });
    expect(ledgerReadPlan(s)).toEqual({ branches: [OLD], union: false, required: [], fence: null });
    expect(ledgerWritePlan(s)).toEqual({ branch: OLD, dedupeAlso: null });
    expect(formatLedgerRefSettings(s)).toMatch(/cutover=off \(standard\).*writes -> ops\/review-requests; reads -> ops\/review-requests$/);
  });

  it('repo then env layers; env wins; invalid values ignored and named', () => {
    const s = resolveLedgerRefSettings({ repo: cfg({ cutover: 'on', dualRead: false }), env: { [LEDGER_DUAL_READ_ENV]: 'true' } });
    expect(s).toMatchObject({ cutover: 'on', dualRead: true, writeBranch: NEW, sources: { cutover: 'repo', dualRead: 'env' } });
    const bad = resolveLedgerRefSettings({ repo: cfg({ cutover: 'maybe', ref: 'main' }), env: { [LEDGER_REF_ENV]: 'refs/heads/main', [LEDGER_CUTOVER_ENV]: 'sideways' } });
    expect(bad).toMatchObject({ ref: NEW, cutover: 'off', writeBranch: OLD });
    expect(bad.invalid).toEqual(['repo.verdictLedger.ref', 'repo.verdictLedger.cutover', `env.${LEDGER_REF_ENV}`, `env.${LEDGER_CUTOVER_ENV}`]);
  });

  it('a setting can never aim a ledger push outside the allow-list (not main, not the old ref as "new")', () => {
    expect(() => ledgerPushRefFor('main')).toThrow(/not a ledger ref/);
    expect(resolveLedgerRefSettings({ repo: cfg({ ref: OLD }), env: {} }).invalid).toEqual(['repo.verdictLedger.ref']);
    expect(ledgerPushRefFor(NEW)).toBe(`refs/heads/${NEW}`);
  });

  it('read/write plan matrix: no combination hides a ref that can hold rows (audit finding 1)', () => {
    const r = (v) => resolveLedgerRefSettings({ repo: cfg(v), env: {} });
    const PIN = 'a'.repeat(40);
    expect(ledgerReadPlan(r({ cutover: 'off', dualRead: true }))).toEqual({ branches: [NEW, OLD], union: true, required: [], fence: null });
    // cutover on with dualRead=false but NO pin: overridden to the union, and the override is named
    const onNoPin = r({ cutover: 'on', dualRead: false });
    expect(onNoPin.overridden).toEqual([expect.stringMatching(/dualRead=true/)]);
    expect(ledgerReadPlan(onNoPin)).toEqual({ branches: [NEW, OLD], union: true, required: [NEW], fence: null });
    expect(ledgerWritePlan(onNoPin)).toEqual({ branch: NEW, dedupeAlso: OLD });
    // cutover on + pin: the new ref only, fenced by the pinned old tree
    const fin = r({ cutover: 'on', dualRead: false, retiredOldTree: PIN });
    expect(ledgerReadPlan(fin)).toEqual({ branches: [NEW], union: false, required: [NEW], fence: { branch: OLD, tree: PIN } });
    expect(ledgerWritePlan(fin)).toEqual({ branch: NEW, dedupeAlso: null });
    // rollback: old ref written, both read, both required, deduped against the new ref
    const rb = r({ cutover: 'rollback', dualRead: false });
    expect(rb.dualRead).toBe(true);
    expect(ledgerReadPlan(rb)).toEqual({ branches: [NEW, OLD], union: true, required: [NEW, OLD], fence: null });
    expect(ledgerWritePlan(rb)).toEqual({ branch: OLD, dedupeAlso: NEW });
    expect(r({ retiredOldTree: 'nothex' }).invalid).toEqual(['repo.verdictLedger.retiredOldTree']);
  });
});

describe('unionLedgerTexts: no row lost, none duplicated', () => {
  const l = (id, pr, sec = 0) => JSON.stringify({ id, pr, at: `2026-10-21T12:00:${String(sec).padStart(2, '0')}.000Z` });
  it('shared rows once (anchors), new-only rows merged in by time, malformed lines pass through', () => {
    const oldT = [l('a', 1, 1), l('b', 2, 2), 'not json', l('s', 9, 5)].join('\n');
    const newT = [l('a', 1, 1), l('b', 2, 2), 'not json', l('c', 3, 4)].join('\n');
    const u = unionLedgerTexts(oldT, newT);
    expect(u.ok).toBe(true);
    expect(u.text.split('\n').filter(Boolean)).toEqual([l('a', 1, 1), l('b', 2, 2), 'not json', l('c', 3, 4), l('s', 9, 5)]);
    expect(u).toMatchObject({ oldRows: 4, newOnly: 1, duplicates: 3 });
    expect(compareLedgerTexts(oldT, newT)).toEqual({ oldOnly: 1, newOnly: 1, both: 3 });
  });
  it('ROLLBACK ORDER: a newer hold on the old ref is never superseded by an older accept that only the new ref holds', () => {
    const accept = JSON.stringify({ id: 'n1', pr: 7, verdict: 'accepted', at: '2026-10-21T12:00:00.000Z' });
    const hold = JSON.stringify({ id: 'o1', pr: 7, verdict: 'changes', at: '2026-10-21T13:00:00.000Z' });
    const u = unionLedgerTexts(`${hold}\n`, `${accept}\n`).text.split('\n').filter(Boolean);
    expect(u.at(-1)).toBe(hold);
    // and each side's own order is never changed, even when its times are out of order
    const x1 = JSON.stringify({ id: 'x1', at: '2026-10-21T12:00:09.000Z' });
    const x2 = JSON.stringify({ id: 'x2', at: '2026-10-21T12:00:01.000Z' });
    expect(unionLedgerTexts(`${x1}\n${x2}\n`, '').text).toBe(`${x1}\n${x2}\n`);
  });
  it('AUDIT REPRO: a hold appended AFTER a shared accept stays after it, whatever its timestamp (finding 2)', () => {
    const accept = JSON.stringify({ id: 'A', pr: 7, verdict: 'accepted', at: '2026-10-21T13:00:00.000Z' });
    const hold = JSON.stringify({ id: 'H', pr: 7, verdict: 'changes', at: '2026-10-21T12:00:00.000Z' });
    const u = unionLedgerTexts(`${accept}\n`, `${accept}\n${hold}\n`);
    expect(u.ok).toBe(true);
    expect(u.text.split('\n').filter(Boolean)).toEqual([accept, hold]);
  });
  it('refuses rather than guesses: different order of shared rows, a same-id row with other bytes, a same-time same-PR pair', () => {
    const a = JSON.stringify({ id: 'a', pr: 1, at: '2026-10-21T12:00:01.000Z' });
    const b = JSON.stringify({ id: 'b', pr: 2, at: '2026-10-21T12:00:02.000Z' });
    expect(unionLedgerTexts(`${a}\n${b}\n`, `${b}\n${a}\n`)).toMatchObject({ ok: false, reason: 'order-conflict' });
    const corrupt = JSON.stringify({ id: 'a', pr: 1, verdict: 'nonsense' });
    expect(unionLedgerTexts(`${a}\n`, `${corrupt}\n`)).toMatchObject({ ok: false, reason: 'conflicting-row' });
    const x = JSON.stringify({ id: 'x', pr: 5, verdict: 'accepted', at: '2026-10-21T12:00:09.000Z' });
    const y = JSON.stringify({ id: 'y', pr: 5, verdict: 'changes', at: '2026-10-21T12:00:09.000Z' });
    expect(unionLedgerTexts(`${x}\n`, `${y}\n`)).toMatchObject({ ok: false, reason: 'ambiguous-order' });
  });
  it('empty sides', () => {
    expect(unionLedgerTexts('', '').text).toBe('');
    expect(unionLedgerTexts('', `${l('x', 1)}\n`).text).toBe(`${l('x', 1)}\n`);
  });
});

describe('real git: dual read + writer switch + migration', () => {
  it('DEFAULT (cutover off, dualRead off) is today: writes and reads the old ref only, never probes the new one', async () => {
    await withBareOrigin(async (ctx) => {
      seedLegacy(ctx);
      append(ctx, [1, 2]);
      const calls = [];
      const r = read(ctx, cfg(), { run: (a, o) => { calls.push(a); return realGit(a, o); } });
      expect(r.status).toBe('ok');
      expect(prsOf(r.text)).toEqual([1, 2]);
      expect(calls.some((a) => a.join(' ').includes(NEW))).toBe(false);
      expect(originHas(ctx, NEW)).toBe(false);
    });
  });

  it('dual read with the new ref ABSENT falls back to the old ref; both absent is unreadable (fail closed)', async () => {
    await withBareOrigin(async (ctx) => {
      const none = read(ctx, cfg({ dualRead: true }));
      expect(none).toMatchObject({ status: 'unreadable', reason: 'no-ledger-ref' });
      seedLegacy(ctx);
      append(ctx, [1]);
      const r = read(ctx, cfg({ dualRead: true }));
      expect(r.status).toBe('ok');
      expect(prsOf(r.text)).toEqual([1]);
      expect(r.refs).toEqual([{ branch: NEW, status: 'absent' }, { branch: OLD, status: 'read' }]);
    });
  });

  it('cutover on before the migration: the write FAILS LOUDLY and never creates the new ref; reads are unreadable', async () => {
    await withBareOrigin(async (ctx) => {
      seedLegacy(ctx);
      append(ctx, [1]);
      expect(() => append(ctx, [2], cfg({ cutover: 'on' }))).toThrow();
      expect(originHas(ctx, NEW)).toBe(false);
      expect(read(ctx, cfg({ cutover: 'on' })).status).toBe('unreadable');
      // Dual read does NOT fall back to the old ref here: with cutover on, a missing write ref holds the read.
      expect(read(ctx, cfg({ cutover: 'on', dualRead: true }))).toMatchObject({ status: 'unreadable', reason: 'required-ledger-ref-absent' });
    });
  });

  it('FULL CUTOVER: migrate, switch writers, straggler on the old ref, union holds every row exactly once, old ref only ever read', async () => {
    await withBareOrigin(async (ctx) => {
      seedLegacy(ctx);
      append(ctx, [1, 2, 3]);
      const before = read(ctx);
      // Migrate (create-only push of the orphan root).
      const m = applyMigration({ board: ctx.clone, to: NEW, run: realGit, measure: false });
      expect(m).toMatchObject({ applied: true, state: 'created', parity: true });
      const oldTipAfterMigration = originTip(ctx, OLD);
      // The new ref is a ROOT commit whose tree is ONLY verdict-ledger/, with the old blob byte for byte.
      expect(git(['rev-list', '--parents', '-n1', NEW], { cwd: ctx.origin }).trim().split(' ')).toHaveLength(1);
      expect(git(['ls-tree', '--name-only', NEW], { cwd: ctx.origin }).trim()).toBe('verdict-ledger');
      expect(ctx.showOnOrigin(NEW, PATH)).toBe(ctx.showOnOrigin(OLD, PATH));
      // CI-parity: a dual read right after the migration equals the legacy read exactly.
      const dual0 = read(ctx, cfg({ dualRead: true }));
      expect(dual0.text).toBe(before.text);
      // A not-yet-switched writer appends to the OLD ref (straggler); switched writers append to the NEW ref.
      append(ctx, [4]);
      const oldTipWithStraggler = originTip(ctx, OLD);
      append(ctx, [5, 6], cfg({ cutover: 'on', dualRead: true }));
      append(ctx, [3], cfg({ cutover: 'on', dualRead: true })); // a replay of a row already on both: no duplicate
      append(ctx, [4], cfg({ cutover: 'on', dualRead: true })); // a replay of the straggler: deduped against the OLD ref
      expect(originTip(ctx, OLD)).toBe(oldTipWithStraggler); // the switched writer never touched the old ref
      expect(prsOf(ctx.showOnOrigin(NEW, PATH))).toEqual([1, 2, 3, 5, 6]);
      const u = read(ctx, cfg({ cutover: 'on', dualRead: true }));
      expect(u.status).toBe('ok');
      expect(prsOf(u.text)).toEqual([1, 2, 3, 4, 5, 6]);
      // cutover on WITHOUT a pin still reads both (dualRead=false is overridden): the straggler is never hidden.
      expect(prsOf(read(ctx, cfg({ cutover: 'on', dualRead: false })).text)).toEqual([1, 2, 3, 4, 5, 6]);
      // A pin taken BEFORE the straggler wrote: the fence sees the old ref moved and holds the read.
      const fenced = read(ctx, cfg({ cutover: 'on', dualRead: false, retiredOldTree: m.ledgerTree }));
      expect(fenced).toMatchObject({ status: 'unreadable', reason: 'retired-ref-moved' });
      // The migration report names that delta and pushes nothing over a present target.
      const again = applyMigration({ board: ctx.clone, to: NEW, run: realGit, measure: false });
      expect(again).toMatchObject({ applied: false, state: 'diverged' });
      expect(again.rowDelta.find((d) => d.path === PATH)).toMatchObject({ oldOnly: 1, newOnly: 2, both: 3 });
      expect(prsOf(ctx.showOnOrigin(NEW, PATH))).toEqual([1, 2, 3, 5, 6]);
      // Kill switch: cutover rollback. Writers return to the old ref; nothing written to the new ref vanishes; and a
      // replay of a row that already landed on the NEW ref is not appended to the old one (audit finding 3).
      const oldBeforeRollback = prsOf(ctx.showOnOrigin(OLD, PATH));
      append(ctx, [5], cfg({ cutover: 'rollback' }));
      expect(prsOf(ctx.showOnOrigin(OLD, PATH))).toEqual(oldBeforeRollback);
      append(ctx, [7], cfg({ cutover: 'rollback' }));
      const k = read(ctx, cfg({ cutover: 'rollback' }));
      expect(k.status).toBe('ok');
      expect(prsOf(k.text)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      // The old ref was only ever appended to by the old-ref writers: its history is a fast-forward of the start.
      git(['merge-base', '--is-ancestor', oldTipAfterMigration, OLD], { cwd: ctx.origin });
    });
  });

  it('dual read FAILS CLOSED when the new ref exists but cannot be read (no partial answer)', async () => {
    await withBareOrigin(async (ctx) => {
      seedLegacy(ctx);
      append(ctx, [1]);
      applyMigration({ board: ctx.clone, to: NEW, run: realGit, measure: false });
      const run = (a, o) => {
        if (a[0] === 'fetch' && a.join(' ').includes(NEW)) { const e = new Error('fatal: unable to access'); e.stderr = 'fatal: unable to access'; throw e; }
        return realGit(a, o);
      };
      const r = read(ctx, cfg({ dualRead: true }), { run });
      expect(r.status).toBe('unreadable');
      const lsFail = (a, o) => { if (a[0] === 'ls-remote') throw new Error('network down'); return realGit(a, o); };
      expect(read(ctx, cfg({ dualRead: true }), { run: lsFail }).status).toBe('unreadable');
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
      const c = applyMigration({ board: ctx.clone, to: NEW, run: realGit, measure: false });
      expect(c).toMatchObject({ applied: true, candidate: a.candidate });
      const d = applyMigration({ board: ctx.clone, to: NEW, run: realGit, measure: false });
      expect(d).toMatchObject({ applied: false, state: 'identical' });
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
    it(`${wf} passes the three ledger-ref variables into the step that reads/writes the ledger`, () => {
      const text = readFileSync(join(ROOT, '.github', 'workflows', wf), 'utf8');
      for (const [envName, varName] of [[LEDGER_REF_ENV, 'VERDICT_LEDGER_REF'], [LEDGER_CUTOVER_ENV, 'VERDICT_LEDGER_CUTOVER'], [LEDGER_DUAL_READ_ENV, 'VERDICT_LEDGER_DUAL_READ']]) {
        expect(text).toContain(`${envName}: \${{ vars.${varName} }}`);
      }
    });
  }

  it('an unset repo variable (empty string) changes nothing', () => {
    const s = resolveLedgerRefSettings({ repo: {}, env: { [LEDGER_REF_ENV]: '', [LEDGER_CUTOVER_ENV]: '', [LEDGER_DUAL_READ_ENV]: '' } });
    expect(s).toMatchObject({ cutover: 'off', dualRead: false, writeBranch: OLD, invalid: [] });
  });

  it('the merge-gate read shape (exec seam, strict byte-count check) reads the union exactly like the legacy read', async () => {
    await withBareOrigin(async (ctx) => {
      seedLegacy(ctx);
      append(ctx, [1, 2]);
      applyMigration({ board: ctx.clone, to: NEW, run: realGit, measure: false });
      append(ctx, [3], cfg({ cutover: 'on' }));
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
      const dual = gateRead(cfg({ cutover: 'on', dualRead: true }));
      expect(prsOf(legacy.text)).toEqual([1, 2]);
      expect(prsOf(dual.text)).toEqual([1, 2, 3]);
      expect(dual.text.startsWith(legacy.text)).toBe(true);
    });
  });
});
