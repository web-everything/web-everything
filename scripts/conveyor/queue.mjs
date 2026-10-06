#!/usr/bin/env node
/**
 * @file scripts/conveyor/queue.mjs
 * @description The operator's CLEAR-FOR-BUILD CLI for the conveyor (WE #2613, epic #2612). Adds / removes /
 *   lists item ids in the SESSION-LOCAL conveyor queue sidecar (`.conveyor/queue.json`, gitignored). This is
 *   the command the /conveyor skill tells the operator to run from the MAIN session to clear (or un-clear)
 *   work for the conveyor to pull.
 *
 *   It is NOT a card mutation — it never touches backlog frontmatter and never calls `writeBacklogMd`, so it
 *   is NOT policed by the no-override lane guard (backlog.mjs, #2302/#104/#2219/#2339) and runs fine from the
 *   primary/main checkout. That is the entire point: clearing work is session-local operator intent, so it
 *   goes through a sidecar the guard does not police, never through `build-queue add` (which the guard blocks
 *   from primary). See {@link ./queue-store.mjs} for the store + the pure core.
 *
 * USAGE:
 *   node scripts/conveyor/queue.mjs add <NNN> [--json]     # clear an item for the conveyor to pull (idempotent)
 *   node scripts/conveyor/queue.mjs remove <NNN> [--json]  # un-clear it (no-op if it was not cleared)
 *   node scripts/conveyor/queue.mjs list [--json]          # print the current session queue
 *   node scripts/conveyor/queue.mjs migrate [--dry-run] [--json]  # one-time move of the OLD in-checkout sidecar
 *                                                          # into the automation's state home (decouple-primary-checkout)
 *   node scripts/conveyor/queue.mjs prune [--dry-run] [--json]  # drop resolved / missing-card / duplicate-alias rows
 *                                                          # (never an open-PR or actively-claimed one)
 *   node scripts/conveyor/queue.mjs remove --ids-file=F [--drop-class=L] --dry-run   # operator bulk removal: dry-run
 *   node scripts/conveyor/queue.mjs remove --ids-file=F [--drop-class=L]             # first, then apply the same list
 *   node scripts/conveyor/queue.mjs migrate-bornas [--dry-run] [--json]  # rewrite stale JIT-hash rows to their
 *                                                          # landed NNN (the drain's `bornAs:` stamp, #2288/#2392)
 *
 * The id may be typed with or without a leading `#` (`add 2613` ≡ `add '#2613'`). A sidecar entry CAN go stale
 * across JIT-numbering — an item cleared as a `xHASH` won't match once it lands as `#NNN` — but this now
 * SELF-HEALS: every reader (`dispatch-plan.mjs`, `conveyor-state.mjs`) resolves a stale hash through the
 * landed card's `bornAs:` record at read time, and `migrate-bornas` above rewrites the on-disk sidecar the
 * same way on demand. `remove` + re-`add` under the current id remains a fallback for a hash the resolution
 * genuinely can't place (a typo, or an item that never landed).
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  readQueueFile, writeQueueFile, addToQueue, removeFromQueue, queueHas, resolveQueuePath, normNum,
  resolveQueueSource, migrateLegacyQueue, legacyQueueDivergence, bornAsIndexFromItems, resolveBornAsRefs,
} from './queue-store.mjs';
import {
  planPrune, applyPlan, protectedFrom, parseIdsFile, bulkRemovePlan, planDigest, writeReceipt, receiptMatches,
} from './queue-prune.mjs';
import { readField } from '../backlog/frontmatter.mjs';
import { idFromName, normalizeId } from '../backlog/id.mjs';
import { fetchOpenPrsRest } from './open-pr-fetch.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { prDeliveredNum } from './build-dispatch-policy.mjs';
import { listBuildDispatchClaims } from './build-dispatch-claim.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';

const GRN = '\x1b[32m';
const DIM = '\x1b[2m';
const YEL = '\x1b[33m';
const RED = '\x1b[31m';
const RST = '\x1b[0m';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKLOG_CLI = join(HERE, '..', 'backlog.mjs');
const BACKLOG_DIR = process.env.CONVEYOR_BACKLOG_DIR || join(HERE, '..', '..', 'backlog');

// A cleared id whose card is a `kind:epic` (needs `/slice`) or `kind:decision` (needs `/prepare` + a ratify)
// can NEVER be dispatched — the conveyor only builds ready stories/tasks. Flag it at add-time so the operator
// isn't surprised by a silent non-dispatch (#2646). WARNINGS keyed off `kind` for a non-dispatchable card.
const NON_DISPATCHABLE = {
  epic: 'is a `kind:epic`; the conveyor can\'t build an epic — `/slice` it into stories first',
  decision: 'is a `kind:decision`; the conveyor can\'t build a decision — `/prepare` then `/decision` (ratify) it first',
};

/** Keys of the warning map used by the CLI, exposed for the file-item agreement test. */
export const NON_DISPATCHABLE_KINDS = Object.freeze(Object.keys(NON_DISPATCHABLE));

/**
 * Best-effort backlog items load (the SAME loader `dispatch-plan.mjs`/`conveyor-state.mjs` enrich from), for
 * `migrate-bornas`'s hash→NNN index. Never throws — a load failure returns `[]`, so a bad/absent loader makes
 * `migrate-bornas` a safe no-op (nothing resolves) rather than a crash.
 */
function loadBacklogItemsBestEffort() {
  try {
    const require = createRequire(import.meta.url);
    const loadBacklog = require(join(HERE, '..', '..', 'src', '_data', 'backlog.js'));
    return typeof loadBacklog === 'function' ? loadBacklog() : [];
  } catch {
    return [];
  }
}

/**
 * Best-effort `kind` of the item behind `num` — reads the backlog card's frontmatter directly (fast, no
 * subprocess). Returns `{ checked, kind }`: `checked:false` when the card can't be resolved/read (never blocks
 * the add). Skipped entirely when `CONVEYOR_NO_KIND_CHECK` is set (tests / offline use). Resolves by the
 * on-disk id (`normalizeId`) and falls back to a `bornAs:` match so a card cleared as its `xHASH` still
 * resolves after it JIT-lands as `#NNN` (and vice-versa).
 */
function kindOf(num) {
  if (process.env.CONVEYOR_NO_KIND_CHECK) return { checked: false, kind: null };
  try {
    // `normalizeId` matches `idFromName` (the on-disk filename token): it pads a number to NNN and leaves a
    // hash as-is. Both the filename id and the queried `num` run through it, so the two sides are consistent.
    const key = normalizeId(num);
    const mdFiles = readdirSync(BACKLOG_DIR).filter((f) => f.endsWith('.md'));
    // Fast path: match by the filename id (no file read). Fall back to a `bornAs:` match so a card cleared as
    // its `xHASH` still resolves after it JIT-lands as `#NNN` (and vice-versa) — reading each card's content
    // once and reusing it for the `kind` lookup on the winner.
    const byName = mdFiles.find((f) => normalizeId(idFromName(f) || '') === key);
    if (byName) return { checked: true, kind: readField(readFileSync(join(BACKLOG_DIR, byName), 'utf8'), 'kind') || null };
    for (const f of mdFiles) {
      let content;
      try { content = readFileSync(join(BACKLOG_DIR, f), 'utf8'); } catch { continue; }
      if (normalizeId(readField(content, 'bornAs') || '') === key) {
        return { checked: true, kind: readField(content, 'kind') || null };
      }
    }
    return { checked: false, kind: null };
  } catch {
    return { checked: false, kind: null };
  }
}

/**
 * Is `num` CURRENTLY a ready build-queue row? Best-effort — shells `backlog.mjs build-queue --json` (the same
 * ready set the dispatcher pulls from). Returns `{ checked, ready }`: `checked:false` when the lookup could not
 * run (never blocks the add). Skipped entirely when `CONVEYOR_NO_READY_CHECK` is set (tests / offline use).
 */
function readinessOf(num) {
  if (process.env.CONVEYOR_NO_READY_CHECK) return { checked: false, ready: false };
  try {
    // #x5n4zn3 — was bare (no timeout); best-effort readiness check, so a bound here just means "checked: false"
    // instead of blocking the add.
    const out = execFileSync('node', [BACKLOG_CLI, 'build-queue', '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
      timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    const q = JSON.parse(out);
    const rows = Array.isArray(q?.queue) ? q.queue : [];
    const key = normNum(num);
    return { checked: true, ready: rows.some((r) => normNum(r?.num) === key) };
  } catch {
    return { checked: false, ready: false };
  }
}

/**
 * Ids prune must never touch: open-PR deliveries, active build claims, in-flight runs. THROWS when the open-PR
 * list cannot be read (callers fail closed). `CONVEYOR_PRUNE_PROTECTED` (comma list) replaces the live reads
 * for hermetic tests.
 */
function loadProtectedNums() {
  const fixed = process.env.CONVEYOR_PRUNE_PROTECTED;
  if (fixed != null) return protectedFrom({ prNums: fixed.split(',').map((x) => x.trim()).filter(Boolean) });
  const prNums = [];
  for (const { slug } of Object.values(CONSTELLATION_REPOS)) {
    for (const pr of fetchOpenPrsRest({ repo: slug })) { const n = prDeliveredNum(pr); if (n) prNums.push(n); }
  }
  const claimNums = listBuildDispatchClaims().map((c) => c.meta?.num);
  return protectedFrom({ prNums, claimNums });
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flagArgs = argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2));
  const flags = new Set(flagArgs.map((a) => a.split('=')[0]));
  const flagVal = (name) => { const f = flagArgs.find((a) => a.startsWith(`${name}=`)); return f ? f.slice(name.length + 1) : null; };
  const json = flags.has('json');
  const [action, rawNum] = args;
  // Strip a leading `#` sigil (UI/`list` render ids as `#NNN`) so `add '#2613'` stores `2613` and matches the
  // build-queue row — defense-in-depth with normNum, which also tolerates a stored `#` on the membership side.
  const num = rawNum == null ? rawNum : String(rawNum).trim().replace(/^#+/, '').trim();

  const emit = (payload, human) => {
    writeAllSync(1, json ? JSON.stringify(payload) + '\n' : human + '\n');
    process.exit(0);
  };
  const fail = (msg) => {
    if (json) writeAllSync(1, JSON.stringify({ ok: false, error: msg }) + '\n');
    else process.stderr.write(`${RED}✗${RST} ${msg}\n`);
    process.exit(1);
  };

  const path = resolveQueuePath();

  if (action === 'migrate') {
    const r = migrateLegacyQueue({ dryRun: flags.has('dry-run') });
    const human = r.reason === 'canonical-exists'
      ? `${DIM}already in the state home (${r.count} in queue, ${r.path}) — nothing to migrate${RST}`
      : r.reason === 'no-legacy'
        ? `${DIM}no legacy queue found — nothing to migrate (${r.path})${RST}`
        : `${GRN}${r.migrated ? '✓ migrated' : 'would migrate'}${RST} ${r.count} entr${r.count === 1 ? 'y' : 'ies'} ${DIM}${r.from.join(', ')} → ${r.path}${RST}`;
    return emit({ ok: true, verb: 'queue', action: 'migrate', ...r }, human);
  }

  if (action === 'migrate-bornas') {
    // The sanctioned self-heal: rewrite each sidecar row whose id is a JIT hash that has since landed (its
    // numbered card carries `bornAs: <that hash>`, #2288/#2392) to the landed NNN. Readers already resolve
    // this at read time (#4291 area); this verb makes the on-disk sidecar match, so a subsequent `list` (and
    // any tool that reads the file directly rather than through the resolving readers) shows the current id.
    const items = loadBacklogItemsBestEffort();
    const idx = bornAsIndexFromItems(items);
    const before = readQueueFile(path);
    const resolved = before
      .map((e) => ({ from: e.num, to: idx.get(normNum(e.num)) }))
      .filter((r) => r.to != null && normNum(r.from) !== r.to);
    const after = resolveBornAsRefs(before, idx);
    const changed = resolved.length > 0;
    if (changed && !flags.has('dry-run')) writeQueueFile(after, path);
    const human = !items.length
      ? `${YEL}⚠${RST} could not load the backlog — nothing to resolve against (${path})`
      : !changed
        ? `${DIM}no stale bornAs hashes in the queue — nothing to migrate (${before.length} in queue, ${path})${RST}`
        : `${GRN}${flags.has('dry-run') ? 'would resolve' : '✓ resolved'}${RST} ${resolved.length} stale hash row${resolved.length === 1 ? '' : 's'} ${DIM}${resolved.map((r) => `${r.from}→${r.to}`).join(', ')} → ${path}${RST}`;
    return emit({ ok: true, verb: 'queue', action: 'migrate-bornas', dryRun: flags.has('dry-run'), resolved, queue: after, path }, human);
  }

  if (action === 'prune') {
    const items = loadBacklogItemsBestEffort();
    const queue = readQueueFile(path);
    let prot;
    try { prot = loadProtectedNums(); }
    catch (e) { return fail(`cannot determine open PRs / claims (${String(e.message || e).split('\n')[0]}) — refusing to prune (fail-closed)`); }
    const plan = planPrune({ queue, items, protectedNums: prot });
    if (!plan.ok) return fail(`prune refused: ${plan.reason}`);
    const dry = flags.has('dry-run');
    const after = !dry && (plan.drop.length || plan.rename.length) ? applyPlan(plan, path) : null;
    const lines = [
      ...plan.drop.map((d) => `  - #${d.num}  ${d.reason}${d.detail ? ` (${d.detail})` : ''}`),
      ...plan.rename.map((r) => `  ~ #${r.from} -> #${r.to}  renamed (landed)`),
      ...plan.protectedKept.map((p) => `  = #${p.num}  kept (open PR / active claim)`),
    ];
    const counts = {}; for (const d of plan.drop) counts[d.reason] = (counts[d.reason] || 0) + 1;
    const summary = `${dry ? 'would drop' : 'dropped'} ${plan.drop.length} of ${queue.length} (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}); rename ${plan.rename.length}; protected ${plan.protectedKept.length}; queue after: ${queue.length - plan.drop.length}`;
    return emit({ ok: true, verb: 'queue', action: 'prune', dryRun: dry, counts, ...plan, before: queue.length, after: after ? after.length : queue.length - plan.drop.length, path },
      `${GRN}${dry ? 'dry-run:' : '✓'}${RST} ${summary}${lines.length ? `\n${lines.join('\n')}` : ''}`);
  }

  if (action === 'remove' && flagVal('ids-file') != null) {
    const dropClass = flagVal('drop-class') || 'operator';
    let ids;
    try { ids = parseIdsFile(readFileSync(flagVal('ids-file'), 'utf8')); }
    catch (e) { return fail(`cannot read --ids-file (${String(e.message || e).split('\n')[0]})`); }
    const queue = readQueueFile(path);
    let prot;
    try { prot = loadProtectedNums(); }
    catch (e) { return fail(`cannot determine open PRs / claims (${String(e.message || e).split('\n')[0]}) — refusing (fail-closed)`); }
    const plan = bulkRemovePlan({ queue, ids, protectedNums: prot, dropClass });
    const digest = planDigest(plan, dropClass);
    const dry = flags.has('dry-run');
    if (dry) writeReceipt(path, digest);
    else if (!receiptMatches(path, digest)) return fail('bulk removal needs a matching --dry-run of the SAME list first (none found, or the plan changed) — run with --dry-run, review, then re-run');
    const after = !dry && plan.drop.length ? applyPlan(plan, path) : null;
    const lines = [
      ...plan.drop.map((d) => `  - #${d.num}  ${dropClass}`),
      ...plan.protectedKept.map((p) => `  = #${p.num}  kept (open PR / active claim)`),
    ];
    return emit({ ok: true, verb: 'queue', action: 'remove-bulk', dryRun: dry, dropClass, ...plan, before: queue.length, after: after ? after.length : queue.length - plan.drop.length, path },
      `${GRN}${dry ? 'dry-run:' : '✓'}${RST} ${dry ? 'would remove' : 'removed'} ${plan.drop.length} of ${ids.length} listed (${plan.absent.length} not in queue, ${plan.protectedKept.length} protected); queue after: ${queue.length - plan.drop.length}${lines.length ? `\n${lines.join('\n')}` : ''}`);
  }

  if (action === 'list') {
    const queue = readQueueFile(path);
    const src = resolveQueueSource(path);
    const div = legacyQueueDivergence();
    const notes = [
      src.source === 'legacy' ? `${YEL}⚠${RST} read from the OLD location ${src.legacyPath} — run \`queue.mjs migrate\` to move it to ${path}` : '',
      div.diverged ? `${YEL}⚠${RST} ${div.legacyPath} changed after the state-home queue — an old-code writer is still clearing work there, and nothing reads it any more` : '',
    ].filter(Boolean);
    if (json) return emit({ ok: true, verb: 'queue', action: 'list', queue, path, source: src.source, legacyPath: src.legacyPath, legacyDiverged: div.diverged ? div.legacyPath : null });
    const tail = notes.length ? `\n${notes.join('\n')}` : '';
    if (queue.length === 0) return emit({ ok: true }, `${DIM}conveyor queue is empty${RST}${tail}`);
    const lines = queue
      .map((e) => `  ${GRN}✓${RST} #${e.num}${e.addedAt ? ` ${DIM}(cleared ${e.addedAt})${RST}` : ''}`)
      .join('\n');
    return emit({ ok: true }, `conveyor queue (${queue.length}) ${DIM}— ${src.path}${RST}\n${lines}${tail}`);
  }

  if (action !== 'add' && action !== 'remove') {
    fail('usage: queue.mjs {add|remove|prune|list|migrate|migrate-bornas} <NNN> [--json]');
  }
  if (num == null || !num) fail(`${action} needs an item id — e.g. queue.mjs ${action} 2613`);

  const before = readQueueFile(path);
  if (action === 'add') {
    const already = queueHas(before, num);
    const after = addToQueue(before, num, new Date().toISOString());
    if (!already) writeQueueFile(after, path);
    // Feedback so a clear never silently vanishes: a cleared id is STILL added (a temporarily-blocked item
    // should auto-arm when its blocker lands), but we WARN rather than lie with a bare "✓ cleared". Two WARN
    // reasons, kind-specific first:
    //   1. NON-DISPATCHABLE kind (#2646, required): an epic/decision can NEVER be dispatched — the conveyor
    //      only builds ready stories/tasks. This warning explains the fix (`/slice` or `/prepare`+`/decision`)
    //      precisely, so it TAKES PRECEDENCE over the generic not-ready note below (which would just say
    //      "blocked / resolved / unknown" — true but unhelpful for a card that needs a state transition).
    //   2. NOT-READY row (#2613 review, required 2a): a cleared id that is NOT a ready build-queue row
    //      (blocked / resolved / typo / unknown).
    const { checked: kindChecked, kind } = kindOf(num);
    const nonDispatchable = kindChecked && Object.prototype.hasOwnProperty.call(NON_DISPATCHABLE, kind);
    const { checked, ready } = readinessOf(num);
    const notReady = checked && !ready;
    const warn = nonDispatchable
      ? ` — but #${num} ${NON_DISPATCHABLE[kind]}`
      : notReady
        ? ` — but #${num} is not currently ready (blocked / resolved / unknown); it will dispatch once it becomes ready, or \`remove\` it`
        : '';
    return emit(
      { ok: true, verb: 'queue', action: 'add', num, already, ready: checked ? ready : null, kind: kindChecked ? kind : null, nonDispatchable, queue: after },
      already
        ? `${DIM}#${num} was already cleared — no change (${after.length} in queue)${RST}${warn ? `\n${YEL}⚠${RST}${warn}` : ''}`
        : `${GRN}✓ cleared${RST} #${num} for the conveyor ${DIM}→ ${after.length} in queue (session-local, ${path})${RST}${warn ? `\n${YEL}⚠${RST}${warn}` : ''}`,
    );
  }

  // remove
  const had = queueHas(before, num);
  const after = removeFromQueue(before, num);
  if (had) writeQueueFile(after, path);
  return emit(
    { ok: true, verb: 'queue', action: 'remove', num, removed: had, queue: after },
    had
      ? `${GRN}✓ un-cleared${RST} #${num} ${DIM}→ ${after.length} in queue${RST}`
      : `${DIM}#${num} was not in the queue — no change${RST}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
