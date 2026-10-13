#!/usr/bin/env node
/**
 * @file scripts/conveyor/pr-label-mirror.mjs
 * @description THE LABEL MIRROR (ledger plan slices G1 + K). For every open PR it diffs
 *   `derivePrState().labels` against the live labels and lists the exact add and remove set per mirrored family.
 *   REPORT MODE (the default, G1) WRITES NOTHING: no label, no comment, no ledger row, no run record.
 *   `--apply` (slice K, #5649) is the only write path: it records hand-moved hold labels as `label-input` rows
 *   (only an `added` row can hold; a hand removal is audit-only) and re-adds a derived-but-missing `review:human`.
 *   It adds that one label only and never removes any label, so it can only tighten. The write mode for the
 *   other families is a later slice.
 *
 * The compare is slice F's (`review-ledger-check.mjs#buildDerivedRows`), reused as is, so the checker and the
 * mirror can never disagree about what drift is. `missing` there is an ADD here; `extra` is a REMOVE.
 * A PR whose ledger or GitHub facts cannot be read is `unreadable`: nothing is planned for it (unknown is not drift).
 *
 * Usage: node scripts/conveyor/pr-label-mirror.mjs [--repo=<owner/name>] [--limit=<n>] [--store=<name>] [--apply] [--json]
 */
import { pathToFileURL } from 'node:url';
import { DEFAULT_REPO, readOpenPrs, buildDerivedRows } from '../review-ledger-check.mjs';
import { readLedgerEventsFromStore, appendVerdictAsync, buildLedgerEvent, EVENT_TYPES, verdictClears } from '../lib/verdict-ledger.mjs';
import { HOLD_LABELS } from '../lib/pr-state/holds/label-input.mjs';
import { approvalValid, acceptanceCovers } from '../lib/pr-state/holds/verdict.mjs';
import { readPrFacts } from '../lib/pr-state-io.mjs';
import { readGh } from '../lib/proc-read.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
/** The ONE label `--apply` may add (slice K). `advisory:ruling-needed` is slice G2's family, never this one's. */
export const APPLY_ADD_LABEL = 'review:human';

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
  const lines = [`LABEL MIRROR (${plan.mode === 'apply' ? `APPLY: ${plan.writes} write(s)` : 'report only; zero writes'}) ${repo}`,
    `  ${plan.total} open PR(s): ${plan.inSync} in sync, ${plan.changes.length} would change, ${plan.unreadable} unreadable (planned nothing)`,
    `  would add ${plan.counts.add} label(s), would remove ${plan.counts.remove} label(s)`];
  if (plan.store) lines.splice(1, 0, `ledger store: ${plan.store.name} (${plan.store.shared ? 'shared' : 'NOT shared - rows written on other machines are invisible here'})`);
  if (plan.ledgerUnreadable) lines.push(`  ledger unreadable (${plan.ledgerUnreadable.reason}): ${plan.ledgerUnreadable.error}`);
  for (const c of plan.changes) {
    lines.push(`  #${c.pr} (${c.lifecycleState}): add [${c.add.join(', ')}] remove [${c.remove.join(', ')}]`);
  }
  for (const r of plan.rowsAppended ?? []) lines.push(`  appended label-input #${r.pr} ${r.label} ${r.change} by ${r.sender}`);
  for (const a of plan.labelsAdded ?? []) lines.push(`  added ${a.label} to #${a.pr}`);
  for (const f of plan.failures ?? []) lines.push(`  FAILED ${f.pr == null ? '' : `#${f.pr} `}${f.reason} (nothing written for it)`);
  return lines.join('\n');
}

/** One place for the derive call, so the report, the apply pass and its re-derive can never differ on the non-default-repo facts rule. */
const deriveRowsFor = (buildRows, { repo, prs, events }) =>
  buildRows({ repo, prs, events, ...(repo === DEFAULT_REPO ? {} : { readFacts: () => null }) });

/** Read-only run: list PRs, read the ledger, derive, plan. Every input is injectable; none of them writes. */
export async function runMirrorReport({ repo = DEFAULT_REPO, store, limit = 200, listPrs = readOpenPrs, readEvents = readLedgerEventsFromStore, buildRows = buildDerivedRows } = {}) {
  const prs = await listPrs({ repo, limit });
  const ledger = await readEvents(repo, { store });
  const events = ledger.status === 'ok' ? ledger.rows : null;
  const rows = deriveRowsFor(buildRows, { repo, prs, events });
  return { ...planMirror(rows), store: ledger.store, ...(ledger.status === 'ok' ? {} : { ledgerUnreadable: { reason: ledger.reason, error: ledger.error } }) };
}

// ---- APPLY MODE (slice K, #5649) -------------------------------------------------------------------------

const GRAPHQL_PAGE = 100;
/** First line of an error, capped: a hostile or huge message cannot flood a failure entry. */
const firstLine = (e, max = 200) => String(e?.message ?? e).split('\n')[0].slice(0, max);
/** At most this many pages (newest first) per PR; past it the PR is `unreadable`, never partially applied. */
const TIMELINE_MAX_PAGES = 5;

/**
 * Read one PR's label add/remove timeline. Fails closed: a read error, a missing PR, or earlier pages left unread
 * is `unreadable`, never "no changes". Injected in tests; this is the production reader.
 * @returns {Promise<{status:'ok', items:Array<{label:string, change:'added'|'removed', actor:string|null, actorType:string|null, createdAt:string}>}
 *   | {status:'unreadable', reason:string}>}
 */
export async function readLabelTimeline({ repo, pr, read = readGh, maxPages = TIMELINE_MAX_PAGES } = {}) {
  try {
    if (!REPO_RE.test(String(repo)) || !Number.isInteger(Number(pr))) return { status: 'unreadable', reason: 'bad-target' };
    const [owner, name] = repo.split('/');
    const actor = 'createdAt actor { __typename login } label { name }';
    const items = [];
    let before = null;
    for (let page = 0; page < maxPages; page += 1) {
      const query = `query { repository(owner:"${owner}",name:"${name}") { pullRequest(number:${Number(pr)}) {
      timelineItems(last:${GRAPHQL_PAGE},${before ? `before:${JSON.stringify(before)},` : ''}itemTypes:[LABELED_EVENT,UNLABELED_EVENT]) { pageInfo { hasPreviousPage startCursor }
        nodes { __typename ... on LabeledEvent { ${actor} } ... on UnlabeledEvent { ${actor} } } } } } }`;
      const tl = JSON.parse(String(read(['api', 'graphql', '-f', `query=${query}`]))).data?.repository?.pullRequest?.timelineItems;
      if (!tl || !Array.isArray(tl.nodes)) return { status: 'unreadable', reason: 'no-timeline' };
      // `last` pages arrive newest first; prepend each older page without reversing its connection order.
      // Equal createdAt values must retain that order across page boundaries as well as within a page.
      items.unshift(...tl.nodes.filter((n) => n?.label?.name && n.createdAt && (n.__typename === 'LabeledEvent' || n.__typename === 'UnlabeledEvent'))
        .map((n) => ({ label: String(n.label.name), change: n.__typename === 'LabeledEvent' ? 'added' : 'removed',
          actor: n.actor?.login ? String(n.actor.login) : null, actorType: n.actor?.__typename ? String(n.actor.__typename) : null, createdAt: String(n.createdAt) })));
      if (tl.pageInfo?.hasPreviousPage === false) return { status: 'ok', items };
      if (tl.pageInfo?.hasPreviousPage !== true || !tl.pageInfo.startCursor) return { status: 'unreadable', reason: 'bad-page-info' };
      before = String(tl.pageInfo.startCursor);
    }
    return { status: 'unreadable', reason: 'truncated-timeline' }; // earlier pages remain unread: never "no changes"
  } catch (e) {
    return { status: 'unreadable', reason: `timeline-read-failed: ${firstLine(e)}` };
  }
}

/** The login `gh api user` reports for this run: the identity whose own label writes are never re-ledgered. */
export function readSelfLogin({ read = readGh } = {}) {
  const login = String(read(['api', 'user', '--jq', '.login'])).trim();
  if (!login) throw new Error('gh api user returned no login');
  return login;
}

/** Fold a login for the row: no whitespace runs, no backticks (the schema's `oneLine` folds the rest). */
const foldSender = (v) => String(v ?? '').replace(/`/g, "'").replace(/\s+/g, ' ').trim() || 'unknown';
const isBot = (item) => item.actorType === 'Bot' || /\[bot\]$/i.test(item.actor ?? '');
const sameTime = (a, b) => Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);

/**
 * PURE. Which timeline changes become `label-input` rows for ONE PR. Per hold label only the LATEST change counts,
 * and only while it still matches the live labels (an `added` row for a label that is no longer there would re-hold a
 * PR that was cleared since). A change by the mirror's own login is never recorded; a bot or missing actor is
 * hand-made for `added` (tighten) and NOT for `removed`. Rows already in `events` (repo + pr + label + change + time)
 * are dropped.
 */
export function planLabelInputRows({ repo, pr, items = [], liveLabels = [], selfLogin, events = [], now = Date.now(), headSha } = {}) {
  const self = String(selfLogin ?? '').toLowerCase();
  const live = new Set(liveLabels);
  const latest = new Map();
  items.map((it, i) => ({ it, i })).sort((a, b) => Date.parse(a.it.createdAt) - Date.parse(b.it.createdAt) || a.i - b.i)
    .forEach(({ it }) => { if (HOLD_LABELS.includes(it.label)) latest.set(it.label, it); });
  const rows = [];
  for (const it of latest.values()) {
    if ((it.change === 'added') !== live.has(it.label)) continue; // the PR has moved on since this change
    if (it.actor && it.actor.toLowerCase() === self) continue;     // the mirror's own (or its account's) write
    if (it.change === 'removed' && (!it.actor || isBot(it))) continue;
    // A delayed observation must not move an old addition after its clearing ceremony in append order.
    // This also covers the interval between clear-human's approval append and its live label swap.
    if (it.change === 'added' && events.some((e) => e.pr === pr && String(e.repo).toLowerCase() === String(repo).toLowerCase()
      && Date.parse(e.at) >= Date.parse(it.createdAt)
      && (approvalValid(e, now) || ((e.type === EVENT_TYPES.VERDICT || e.type === undefined)
        && verdictClears(e.verdict) && acceptanceCovers(e, headSha))))) continue;
    const dup = events.some((e) => e?.type === EVENT_TYPES.LABEL_INPUT && e.pr === pr && String(e.repo).toLowerCase() === String(repo).toLowerCase()
      && e.label === it.label && e.change === it.change && sameTime(e.at, it.createdAt));
    if (dup) continue;
    rows.push(buildLedgerEvent({ type: EVENT_TYPES.LABEL_INPUT, repo, pr, at: it.createdAt, source: 'pr-label-mirror',
      label: it.label, sender: foldSender(it.actor), change: it.change }));
  }
  return rows;
}

const liveNames = (pr) => (pr?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);

/** The production label add: ONE label, `review:human` only, with an empty remove list. Exported so a test can pin the exact `setLabels` call. */
export async function addApplyLabel(repo, pr, label, { provider } = {}) {
  if (label !== APPLY_ADD_LABEL) throw new Error(`pr-label-mirror: --apply may add only ${APPLY_ADD_LABEL}, refused ${JSON.stringify(label)}`);
  const gh = provider ?? (await import('../lib/review-label-provider.mjs')).createGhProvider();
  gh.setLabels(repo, pr, { add: label, remove: [] });
}

/**
 * THE WRITE MODE. Per candidate PR (the derive wants `review:human` and the PR lacks it, or the PR carries a hold label):
 * read the label timeline, append the not-yet-ledgered `label-input` rows, THEN add `review:human` if it is derived and
 * missing. Row-then-add, so a crash between the two leaves a row and the next pass restores. Adds one label, removes
 * none. Fails closed: an unreadable ledger, timeline or append means no row and no add for that PR, and a failure entry
 * the CLI turns into a non-zero exit.
 */
export async function runMirrorApply({
  repo = DEFAULT_REPO, store, limit = 200, listPrs = readOpenPrs, readEvents = readLedgerEventsFromStore, buildRows = buildDerivedRows,
  readFacts = readPrFacts,
  readTimeline = readLabelTimeline, selfLogin = readSelfLogin, appendRow = (row) => appendVerdictAsync(row, store ? { store } : {}),
  addLabel = addApplyLabel,
} = {}) {
  const prs = await listPrs({ repo, limit });
  // A full page may be a truncated list: an apply pass over part of the open PRs would call the rest "no change".
  if (prs.length >= limit) throw new Error(`pr-label-mirror: the open-PR list hit --limit=${limit}; raise it, refusing to apply on a possibly truncated list`);
  const ledger = await readEvents(repo, { store });
  const events = ledger.status === 'ok' ? ledger.rows : null;
  const rows = deriveRowsFor(buildRows, { repo, prs, events });
  const plan = planMirror(rows);
  const out = { ...plan, mode: 'apply', writes: 0, store: ledger.store, rowsAppended: [], labelsAdded: [], failures: [],
    ...(ledger.status === 'ok' ? {} : { ledgerUnreadable: { reason: ledger.reason, error: ledger.error } }) };
  if (ledger.status !== 'ok') { out.failures.push({ pr: null, reason: `ledger-unreadable: ${ledger.reason}` }); return out; }
  const wantsAdd = new Map(plan.changes.map((c) => [c.pr, c.add.includes(APPLY_ADD_LABEL)]));
  const candidates = prs.filter((p) => Number.isInteger(p?.number) && rows.find((r) => r.pr === p.number)?.status !== 'unreadable'
    && ((wantsAdd.get(p.number) && !liveNames(p).includes(APPLY_ADD_LABEL)) || liveNames(p).some((n) => HOLD_LABELS.includes(n))));
  if (!candidates.length) return out;
  const self = typeof selfLogin === 'function' ? await selfLogin() : selfLogin;
  if (!self) throw new Error('pr-label-mirror: the mirror\'s own login is unknown; refusing to write');
  for (const p of candidates) {
    const fail = (reason) => out.failures.push({ pr: p.number, reason });
    const tl = await readTimeline({ repo, pr: p.number });
    if (tl?.status !== 'ok') { fail(`timeline-unreadable: ${tl?.reason ?? 'unknown'}`); continue; }
    let current, facts;
    try {
      const live = await listPrs({ repo, limit });
      if (!Array.isArray(live) || live.length >= limit) throw new Error('possibly truncated open-PR list');
      current = live.find((entry) => entry.number === p.number);
      if (!current || !Array.isArray(current.labels)) throw new Error('PR or labels missing');
    } catch (e) { fail(`labels-unreadable: ${firstLine(e)}`); continue; }
    try { facts = await readFacts(p.number, { repo }); } catch (e) { fail(`facts-unreadable: ${firstLine(e)}`); continue; }
    if (!facts || !facts.head?.sha || (facts.probeErrors ?? []).length) { fail('facts-unreadable: missing head or failed probe'); continue; }
    const fresh = await readEvents(repo, { store }); // best-effort idempotency: a fresh read just before the append (not atomic)
    if (fresh.status !== 'ok') { fail(`ledger-unreadable: ${fresh.reason}`); continue; }
    let toAppend;
    try { toAppend = planLabelInputRows({ repo, pr: p.number, items: tl.items, liveLabels: liveNames(current), selfLogin: self, events: fresh.rows, headSha: facts.head.sha, now: facts.now ?? Date.now() }); } catch (e) {
      fail(`bad-label-input-row: ${firstLine(e)}`); continue;
    }
    let ok = true;
    for (const row of toAppend) {
      let res;
      try { res = await appendRow(row); } catch (e) { res = { ok: false, errors: [firstLine(e)] }; }
      if (!res?.ok) { fail(`append-refused: ${(res?.errors ?? []).join('; ') || 'unknown'}`); ok = false; break; }
      out.writes += 1;
      out.rowsAppended.push({ pr: p.number, label: row.label, change: row.change, sender: row.sender, at: row.at });
    }
    if (!ok || !wantsAdd.get(p.number) || liveNames(current).includes(APPLY_ADD_LABEL)) continue;
    // The add was planned from the snapshot taken at the start of the pass: a `clear-human` that landed since must win.
    // Re-derive this one PR from a fresh ledger read and add only if `review:human` is still wanted.
    const latest = await readEvents(repo, { store });
    const again = latest.status === 'ok' ? deriveRowsFor(buildRows, { repo, prs: [current], events: latest.rows })[0] : null;
    if (!again || again.status === 'unreadable') { fail(`rederive-unreadable: ${latest.status === 'ok' ? 'facts' : latest.reason}`); continue; }
    if (!again.families.some((f) => f.missing.includes(APPLY_ADD_LABEL))) continue;
    try { await addLabel(repo, p.number, APPLY_ADD_LABEL); out.writes += 1; out.labelsAdded.push({ pr: p.number, label: APPLY_ADD_LABEL }); } catch (e) {
      fail(`label-add-failed: ${firstLine(e)}`);
    }
  }
  return out;
}

export async function main(argv, { report = runMirrorReport, apply = runMirrorApply, write = (text) => writeAllSync(1, text) } = {}) {
  const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
  // Write mode is exactly `--apply`: a value (`--apply=false`, `--apply=0`) is refused, never read as "on".
  if (flags.apply !== undefined && flags.apply !== true) { process.stderr.write('pr-label-mirror: --apply takes no value\n'); return 2; }
  const repo = typeof flags.repo === 'string' && flags.repo ? flags.repo : DEFAULT_REPO;
  if (!REPO_RE.test(repo)) { process.stderr.write('pr-label-mirror: --repo must be <owner/name>\n'); return 2; }
  const limit = Number.isInteger(Number(flags.limit)) && Number(flags.limit) > 0 ? Number(flags.limit) : 200;
  let plan;
  try { plan = await (flags.apply ? apply : report)({ repo, store: flags.store, limit }); } catch (e) {
    process.stderr.write(`pr-label-mirror: ${firstLine(e)}\n`);
    return 2;
  }
  write(flags.json ? `${JSON.stringify({ repo, ...plan }, null, 2)}\n` : `${renderPlan(plan, { repo })}\n`);
  return plan.failures?.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = await main(process.argv.slice(2));
