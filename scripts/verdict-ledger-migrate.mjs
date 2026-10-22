#!/usr/bin/env node
/**
 * @file scripts/verdict-ledger-migrate.mjs
 * @description THE ONE-TIME, IDEMPOTENT MIGRATION of the verdict ledger from `ops/review-requests` (a full repo tree
 *   plus `verdict-ledger/`) to the ledger-only orphan ref `ops/verdict-ledger` (see `we:scripts/lib/verdict-ledger-ref.mjs`
 *   for the cutover settings, the read plan and the kill switch).
 *
 * WHAT IT BUILDS. One ROOT commit (no parent) whose tree holds exactly one entry: the old tip's `verdict-ledger/` TREE,
 *   reused by id — so every ledger blob is byte-for-byte the old one, by construction, not by copy. The commit is
 *   DETERMINISTIC (fixed identity, the old tip's own commit time, a message naming the old tip): the same old tip
 *   always yields the same commit id. That is what makes a re-run a no-op instead of a second, diverging root.
 *
 * DRY RUN BY DEFAULT. Without `--apply` it fetches, builds the commit LOCALLY (kept at
 *   `refs/verdict-ledger-migration/candidate`, a local-only ref so gc cannot drop it), and reports the old tree vs the
 *   new one, the per-write cost of each, and where the target ref stands. It pushes nothing.
 *
 * `--apply` pushes the candidate to the target ONLY WHEN THE TARGET IS ABSENT, non-forced (git refuses a push over an
 *   existing ref with other history). A present target is never touched: the report says whether it is identical to
 *   the candidate or how many rows exist on one ref only. The OLD ref is only ever read: no command here writes it.
 *
 * Usage: node scripts/verdict-ledger-migrate.mjs [--board=<checkout>] [--apply] [--json] [--deep]
 *   --deep also measures the objects a fresh fetch of each ref must download (`rev-list --disk-usage`; slow on the old ref).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackingRefspec, assertPushRef } from './lib/git-transport-branch.mjs';
import { retryTransientGit } from './lib/git-fetch-retry.mjs';
import { readSettings } from './lib/settings-files.mjs';
import {
  LEGACY_LEDGER_BRANCH, resolveLedgerRefSettings, formatLedgerRefSettings, ledgerPushRefFor, compareLedgerTexts, unionLedgerTexts,
} from './lib/verdict-ledger-ref.mjs';
import { ledgerEventId } from './lib/verdict-ledger.mjs';
import { LEDGER_DIR } from './lib/verdict-ledger-path.mjs';

export const CANDIDATE_REF = 'refs/verdict-ledger-migration/candidate';
export const MIGRATION_IDENTITY = Object.freeze({ name: 'verdict-ledger-migration', email: 'verdict-ledger-migration@users.noreply.github.com' });
const SHA_RE = /^[0-9a-f]{40,64}$/;

function defaultGit(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...opts,
  });
}

/** The deterministic commit message: names the source so the root says where it came from. */
export function migrationMessage(from, tip) {
  return `verdict-ledger: ledger-only root migrated from refs/heads/${from}@${tip}\n\nTree = ${LEDGER_DIR}/ of that commit, reused by id. Built by scripts/verdict-ledger-migrate.mjs.\n`;
}

function sha(out, what) {
  const s = String(out).trim();
  if (!SHA_RE.test(s)) throw new Error(`verdict-ledger-migrate: ${what} did not resolve to an object id (${JSON.stringify(s.slice(0, 80))})`);
  return s;
}

/** Ledger files under one commit: [{path, oid, size}]. */
function ledgerFiles(run, board, commit) {
  return String(run(['ls-tree', '-r', '-l', commit, '--', `${LEDGER_DIR}/`], { cwd: board })).split('\n').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t');
    const [, type, oid, size] = meta.trim().split(/\s+/);
    return { path, type, oid, size: Number(size) };
  });
}

/** Time `read-tree <commit>` + `write-tree` into a throwaway index: what every plumbing ledger write pays on that ref. */
function indexCost(run, board, commit, rounds = 3) {
  const tmp = mkdtempSync(join(tmpdir(), 'we-ledger-migrate-'));
  try {
    const times = [];
    let bytes = 0;
    for (let i = 0; i < rounds; i += 1) {
      const env = { ...process.env, GIT_INDEX_FILE: join(tmp, `index-${i}`) };
      const t0 = process.hrtime.bigint();
      run(['read-tree', commit], { cwd: board, env });
      run(['write-tree'], { cwd: board, env });
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      bytes = statSync(join(tmp, `index-${i}`)).size;
    }
    times.sort((a, b) => a - b);
    return { medianMs: Math.round(times[Math.floor(times.length / 2)] * 10) / 10, indexBytes: bytes };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

function treeFacts(run, board, commit) {
  const entries = String(run(['ls-tree', '-r', '--name-only', commit], { cwd: board })).split('\n').filter(Boolean).length;
  const rootTreeBytes = Number(String(run(['cat-file', '-s', `${commit}^{tree}`], { cwd: board })).trim());
  const rootEntries = String(run(['ls-tree', commit], { cwd: board })).split('\n').filter(Boolean).length;
  return { files: entries, rootEntries, rootTreeBytes };
}

function diskUsage(run, board, commit) {
  try { return Number(String(run(['rev-list', '--objects', '--disk-usage', commit], { cwd: board })).trim()); } catch { return null; }
}

/**
 * Build (or re-build: same tip -> same id) the orphan candidate locally and report. Pushes nothing.
 * @returns {object} the report; `state` is 'absent' | 'identical' | 'diverged' for the target ref.
 */
export function planMigration({ board = process.cwd(), from = LEGACY_LEDGER_BRANCH, to, run = defaultGit, deep = false, measure = true } = {}) {
  if (from !== LEGACY_LEDGER_BRANCH) throw new Error(`verdict-ledger-migrate: the source must be ${LEGACY_LEDGER_BRANCH}`);
  ledgerPushRefFor(to); // allow-listed target
  assertPushRef(to, `refs/heads/${to}`);
  if (to === from) throw new Error('verdict-ledger-migrate: source and target are the same ref');

  retryTransientGit(() => run(['fetch', '--quiet', 'origin', trackingRefspec(from)], { cwd: board }));
  const tip = sha(run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${from}^{commit}`], { cwd: board }), `origin/${from}`);
  const ledgerTree = sha(run(['rev-parse', '--verify', '--quiet', `${tip}:${LEDGER_DIR}`], { cwd: board }), `${from}:${LEDGER_DIR}`);
  const kind = String(run(['cat-file', '-t', ledgerTree], { cwd: board })).trim();
  if (kind !== 'tree') throw new Error(`verdict-ledger-migrate: ${from}:${LEDGER_DIR} is a ${kind}, not a tree`);

  const root = sha(run(['mktree'], { cwd: board, input: `040000 tree ${ledgerTree}\t${LEDGER_DIR}\n` }), 'mktree');
  const when = `${String(run(['log', '-1', '--format=%ct', tip], { cwd: board })).trim()} +0000`;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: MIGRATION_IDENTITY.name, GIT_AUTHOR_EMAIL: MIGRATION_IDENTITY.email, GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: MIGRATION_IDENTITY.name, GIT_COMMITTER_EMAIL: MIGRATION_IDENTITY.email, GIT_COMMITTER_DATE: when,
  };
  const candidate = sha(run(['commit-tree', root, '-m', migrationMessage(from, tip)], { cwd: board, env }), 'commit-tree');
  run(['update-ref', CANDIDATE_REF, candidate], { cwd: board }); // LOCAL only: never pushed under this name

  // Byte parity by construction, checked anyway: every ledger blob on the candidate is the old tip's blob.
  const oldFiles = ledgerFiles(run, board, tip);
  const newFiles = ledgerFiles(run, board, candidate);
  const parity = JSON.stringify(oldFiles) === JSON.stringify(newFiles);
  if (!parity) throw new Error('verdict-ledger-migrate: the candidate ledger tree differs from the source (refusing)');

  const report = {
    from, to, sourceTip: tip, candidate, ledgerTree, parity,
    ledgerFiles: oldFiles.map(({ path, size }) => ({ path, bytes: size })),
    old: treeFacts(run, board, tip),
    new: treeFacts(run, board, candidate),
  };
  if (measure) {
    report.old.perWrite = indexCost(run, board, tip);
    report.new.perWrite = indexCost(run, board, candidate);
  }
  if (deep) {
    report.old.fetchDiskBytes = diskUsage(run, board, tip);
    report.new.fetchDiskBytes = diskUsage(run, board, candidate);
  }

  // Where the TARGET stands. A definitive empty ls-remote is the only "absent".
  const listed = String(run(['ls-remote', '--heads', 'origin', `refs/heads/${to}`], { cwd: board })).trim();
  if (!listed) { report.state = 'absent'; return report; }
  retryTransientGit(() => run(['fetch', '--quiet', 'origin', trackingRefspec(to)], { cwd: board }));
  const target = sha(run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${to}^{commit}`], { cwd: board }), `origin/${to}`);
  report.target = target;
  // RETIRABLE: every row of the old ref's ledger is on the target. Pinning `verdictLedger.retiredOldTree` to this tree
  // id is then what lets readers stop reading the old ref (fenced: a later write to the old ref holds every read).
  if (target === candidate) { report.state = 'identical'; report.retirableOldTree = ledgerTree; return report; }
  report.state = 'diverged';
  // Rows on one ref only, per ledger file — what the kill-switch rule waits on before dualRead may go off.
  const targetFiles = ledgerFiles(run, board, target);
  const paths = [...new Set([...oldFiles, ...targetFiles].map((f) => f.path))];
  const blob = (commit, p) => {
    const f = (commit === tip ? oldFiles : targetFiles).find((x) => x.path === p);
    return f ? String(run(['cat-file', 'blob', f.oid], { cwd: board })) : '';
  };
  report.rowDelta = paths.map((p) => {
    const o = blob(tip, p);
    const n = blob(target, p);
    const u = unionLedgerTexts(o, n, { idOf: ledgerEventId });
    return { path: p, ...compareLedgerTexts(o, n, { idOf: ledgerEventId }), union: u.ok ? 'ok' : u.reason };
  });
  // Retirable only when EVERY file's union forms cleanly (content, ownership and order all agree) and the old ref adds
  // no row to it (audit 2026-10-21 finding 5: id membership alone is not enough).
  if (report.rowDelta.every((d) => d.oldOnly === 0 && d.union === 'ok')) report.retirableOldTree = ledgerTree;
  const extra = String(run(['ls-tree', '--name-only', target], { cwd: board })).split('\n').filter((n) => n && n !== LEDGER_DIR);
  if (extra.length) report.targetExtraEntries = extra;
  return report;
}

/**
 * `--apply`: push the candidate ONLY onto an absent target, non-forced. Idempotent: a present target (identical or
 * not) is reported and left alone. Never writes the source ref.
 */
export function applyMigration(o = {}) {
  const run = o.run ?? defaultGit;
  const board = o.board ?? process.cwd();
  const report = planMigration({ ...o, run, board });
  if (report.state !== 'absent') return { ...report, applied: false, why: `target ${report.state}: nothing pushed` };
  const ref = ledgerPushRefFor(report.to);
  run(['push', '--porcelain', '--no-follow-tags', 'origin', `${report.candidate}:${ref}`], { cwd: board });
  return { ...report, applied: true, state: 'created' };
}

const kb = (n) => (n == null ? 'n/a' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1024).toFixed(1)} KiB`);

export function formatReport(r) {
  const lines = [
    `verdict-ledger-migrate: ${r.from}@${r.sourceTip.slice(0, 12)} -> ${r.to} candidate ${r.candidate.slice(0, 12)} (root, no parent); ledger blobs identical: ${r.parity}`,
    `  ledger files: ${r.ledgerFiles.map((f) => `${f.path} ${kb(f.bytes)}`).join(', ')}`,
    `  tree: old ${r.old.files} files, root ${r.old.rootEntries} entries / ${r.old.rootTreeBytes} B  ->  new ${r.new.files} files, root ${r.new.rootEntries} entry / ${r.new.rootTreeBytes} B`,
  ];
  if (r.old.perWrite) lines.push(`  per write (temp-index read-tree + write-tree): old ${r.old.perWrite.medianMs} ms, index ${kb(r.old.perWrite.indexBytes)}  ->  new ${r.new.perWrite.medianMs} ms, index ${kb(r.new.perWrite.indexBytes)}`);
  if (r.old.fetchDiskBytes != null) lines.push(`  fresh fetch of the ref (reachable objects on disk): old ${kb(r.old.fetchDiskBytes)} -> new ${kb(r.new.fetchDiskBytes)}`);
  lines.push(`  target ${r.to}: ${r.state}${r.target ? ` @${r.target.slice(0, 12)}` : ''}${r.applied ? ' (pushed)' : r.applied === false ? ` (${r.why})` : ' (dry run: nothing pushed)'}`);
  for (const d of r.rowDelta ?? []) lines.push(`    ${d.path}: ${d.both} on both, ${d.oldOnly} only on ${r.from}, ${d.newOnly} only on ${r.to}; union ${d.union}`);
  if (r.retirableOldTree) lines.push(`  old ref retirable: every old row is on ${r.to}; pin verdictLedger.retiredOldTree=${r.retirableOldTree} to stop reading it`);
  if (r.targetExtraEntries) lines.push(`    WARNING: ${r.to} carries non-ledger entries: ${r.targetExtraEntries.join(', ')}`);
  return lines.join('\n');
}

async function main(argv) {
  const flag = (n) => argv.includes(`--${n}`);
  const val = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const board = resolve(val('board') ?? process.cwd());
  const settings = resolveLedgerRefSettings({ repo: readSettings(), env: process.env });
  process.stderr.write(`${formatLedgerRefSettings(settings)}\n`);
  const o = { board, to: settings.ref, deep: flag('deep') };
  const r = flag('apply') ? applyMigration(o) : planMigration(o);
  process.stdout.write(flag('json') ? `${JSON.stringify(r, null, 2)}\n` : `${formatReport(r)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`verdict-ledger-migrate: ${e?.message ?? e}\n`); process.exit(1); });
}
