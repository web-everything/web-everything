/** Bounded, injected IO for mechanical send-backs and orphaned stand-down attention. */
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { daemonConveyorStateRoot } from '../lib/daemon-last-good.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';
import { STAND_DOWN_LABEL } from './stand-down.mjs';
import { bindAgents, assessLiveness } from './reconcile-core.mjs';
import { planSendBacks, pendingOnly, headKey, validHead } from './review-sendback.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function resolveSendBackPolicy({ env = process.env, log = () => {}, tool } = {}) {
  if (tool === undefined) {
    try { tool = JSON.parse(readFileSync(join(ROOT, 'scripts/settings/review-sendback.json'), 'utf8'))?.review; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const r = cascadePolicy('review', tool, { env, standard: { sendBackBlockRuled: true },
    envValues: { sendBackBlockRuled: env.WE_REVIEW_SEND_BACK_BLOCK_RULED === '0' ? false : env.WE_REVIEW_SEND_BACK_BLOCK_RULED === '1' ? true : undefined },
    valid: { sendBackBlockRuled: v => typeof v === 'boolean' } });
  log(`review.sendBackBlockRuled=${r.value.sendBackBlockRuled} (source: ${r.sources.sendBackBlockRuled})`);
  return r.value.sendBackBlockRuled;
}

export function runSendBackTick({ repo, plan, prs, agents, log = () => {},
  enabled = resolveSendBackPolicy({ log }),
  ledgerPath = join(daemonConveyorStateRoot(), 'review-sendback.json'),
  readLive = (repo, pr) => createGhProvider().readPrState(repo, pr),
  execute = execFileSync, publish = publishAttention,
  readLedger = () => {
    try { return JSON.parse(readFileSync(ledgerPath, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return { sent: {}, escalated: {} }; throw e; }
  },
  saveLedger = ledger => { mkdirSync(dirname(ledgerPath), { recursive: true }); writeJsonAtomic(ledgerPath, ledger); },
} = {}) {
  const report = e => log(`review-sendback: ${String(e?.message ?? e).replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 500)}; retry next tick or inspect manually`);
  try {
    const ledger = readLedger();
    if (!ledger || !['sent', 'escalated'].every(k => ledger[k] && typeof ledger[k] === 'object' && !Array.isArray(ledger[k]))) throw new Error('idempotency ledger unreadable');
    if (!Array.isArray(prs) || !Array.isArray(agents) || agents.incomplete || prs.incomplete) throw new Error('PR/agent evidence incomplete');
    // Old ledgers have receipts only. Keep a separate per-repo cursor so failed actions
    // consume this tick's budget without monopolizing every later tick as well.
    if (ledger.cursors === undefined) ledger.cursors = {};
    if (!ledger.cursors || typeof ledger.cursors !== 'object' || Array.isArray(ledger.cursors)
      || Object.values(ledger.cursors).some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error('traversal cursor unreadable');
    const ordered = [...prs].sort((a, b) => Number(a.number) - Number(b.number));
    const next = ordered.findIndex(pr => Number(pr.number) > (ledger.cursors[repo] ?? 0));
    const start = next < 0 ? 0 : next;
    const traversal = [...ordered.slice(start), ...ordered.slice(0, start)];
    // One shared bound across reads, sends and attention publication. Resume after the last attempt.
    let budget = 16;
    for (const pr of traversal) {
      if (!budget) { log('review-sendback: tick budget exhausted; remaining PRs retry next tick'); break; }
      if (pr.state && String(pr.state).toUpperCase() !== 'OPEN') continue;
      if (!validHead(pr)) continue;
      try {
        const row = enabled ? planSendBacks({ plan: { ...plan, repo, dispatch: (plan?.dispatch ?? []).filter(d => Number(d.prNumber) === Number(pr.number)) }, prs: [pr], sentLedger: ledger.sent })[0] : null;
        const stood = pr.labels?.some(l => (typeof l === 'string' ? l : l.name) === STAND_DOWN_LABEL)
          && !ledger.escalated[headKey(repo, pr)] && !assessLiveness(bindAgents(pr, agents, repoKeyForSlug(repo) ?? repo));
        if (!row && !stood) continue;
        budget--;
        ledger.cursors[repo] = Number(pr.number);
        saveLedger(ledger); // Persist progress BEFORE IO: read/send failures must advance the cursor too.
        const live = readLive(repo, pr.number);
        if (!validHead(live) || live.headRefOid !== pr.headRefOid || String(live.state).toUpperCase() !== 'OPEN' || !Array.isArray(live.labels)) continue;
        if (row && pendingOnly(live)) {
          const dir = mkdtempSync(join(tmpdir(), 'review-sendback-'));
          try {
            const body = join(dir, 'findings.md');
            writeFileSync(body, row.body, 'utf8');
            execute(process.execPath, ['scripts/operations/run.mjs', 'review-set-label', String(row.prNumber), '--to=changes', `--repo=${repo}`, `--body-file=${body}`, `--expect-head=${row.headSha}`],
              { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120_000 });
            ledger.sent[row.key] = true;
            saveLedger(ledger);
          } finally { rmSync(dir, { recursive: true, force: true }); }
        }
        if (stood && live.labels.some(l => (typeof l === 'string' ? l : l.name) === STAND_DOWN_LABEL)) {
          publish({ kind: 'stood-down', repo, pr: pr.number, head: pr.headRefOid,
            title: 'Fix agent stood down; human judgment needed', reason: 'stood-down',
            pick: 'Inspect the stand-down comment and choose the next action.' });
          ledger.escalated[headKey(repo, pr)] = true;
          saveLedger(ledger);
        }
      } catch (e) { report(e); }
    }
  } catch (e) { report(e); }
}
