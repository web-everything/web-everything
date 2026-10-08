#!/usr/bin/env node
/**
 * @file scripts/conveyor/pr-label-mirror.mjs
 * @description THE LABEL MIRROR, REPORT MODE (ledger plan slice G1). For every open PR it diffs
 *   `derivePrState().labels` against the live labels and lists the exact add and remove set per mirrored family.
 *   It WRITES NOTHING: no label, no comment, no run record. The write mode is slice G2, one family at a time.
 *
 * The compare is slice F's (`review-ledger-check.mjs#buildDerivedRows`), reused as is, so the checker and the
 * mirror can never disagree about what drift is. `missing` there is an ADD here; `extra` is a REMOVE.
 * A PR whose ledger or GitHub facts cannot be read is `unreadable`: nothing is planned for it (unknown is not drift).
 *
 * Usage: node scripts/conveyor/pr-label-mirror.mjs [--repo=<owner/name>] [--limit=<n>] [--json]
 */
import { pathToFileURL } from 'node:url';
import { readOpenPrs, readRepoEvents, buildDerivedRows } from '../review-ledger-check.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';

const DEFAULT_REPO = 'web-everything/web-everything';
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * PURE. Turn derived rows into the plan. `changes` lists only PRs with something to add or remove.
 * @returns {{mode:'report', writes:0, total:number, inSync:number, unreadable:number,
 *   changes:Array<{pr:number, lifecycleState:string|null, add:string[], remove:string[]}>, counts:{add:number, remove:number}}}
 */
export function planMirror(rows = []) {
  const changes = [];
  let inSync = 0;
  let unreadable = 0;
  for (const r of rows) {
    if (r.status === 'unreadable') { unreadable += 1; continue; }
    const add = r.families.flatMap((f) => f.missing).sort();
    const remove = r.families.flatMap((f) => f.extra).sort();
    if (!add.length && !remove.length) { inSync += 1; continue; }
    changes.push({ pr: r.pr, lifecycleState: r.lifecycleState, add, remove });
  }
  return { mode: 'report', writes: 0, total: rows.length, inSync, unreadable, changes,
    counts: { add: changes.reduce((n, c) => n + c.add.length, 0), remove: changes.reduce((n, c) => n + c.remove.length, 0) } };
}

/** The human lines. Pure. */
export function renderPlan(plan, { repo = DEFAULT_REPO } = {}) {
  const lines = [`LABEL MIRROR (report only; zero writes) ${repo}`,
    `  ${plan.total} open PR(s): ${plan.inSync} in sync, ${plan.changes.length} would change, ${plan.unreadable} unreadable (planned nothing)`,
    `  would add ${plan.counts.add} label(s), would remove ${plan.counts.remove} label(s)`];
  for (const c of plan.changes) {
    lines.push(`  #${c.pr} (${c.lifecycleState}): add [${c.add.join(', ')}] remove [${c.remove.join(', ')}]`);
  }
  return lines.join('\n');
}

/** Read-only run: list PRs, read the ledger, derive, plan. Every input is injectable; none of them writes. */
export function runMirrorReport({ repo = DEFAULT_REPO, limit = 200, listPrs = readOpenPrs, readEvents = readRepoEvents, buildRows = buildDerivedRows } = {}) {
  const prs = listPrs({ repo, limit });
  const events = readEvents(repo);
  const rows = buildRows({ repo, prs, events, ...(repo === DEFAULT_REPO ? {} : { readFacts: () => null }) });
  return planMirror(rows);
}

function main(argv) {
  const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
  const repo = typeof flags.repo === 'string' && flags.repo ? flags.repo : DEFAULT_REPO;
  if (!REPO_RE.test(repo)) { process.stderr.write('pr-label-mirror: --repo must be <owner/name>\n'); process.exit(2); }
  const limit = Number.isInteger(Number(flags.limit)) && Number(flags.limit) > 0 ? Number(flags.limit) : 200;
  let plan;
  try { plan = runMirrorReport({ repo, limit }); } catch (e) {
    process.stderr.write(`pr-label-mirror: ${String(e?.message ?? e).split('\n')[0]}\n`);
    process.exit(2);
  }
  writeAllSync(1, flags.json ? `${JSON.stringify({ repo, ...plan }, null, 2)}\n` : `${renderPlan(plan, { repo })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2));
