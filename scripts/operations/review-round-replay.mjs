#!/usr/bin/env node
/**
 * @file scripts/operations/review-round-replay.mjs
 * @description Card 5469 [A5] — REPLAY recorded review rounds through the scoped re-review + binding-prior-round rules
 *   (we:scripts/lib/review-round-rules.mjs#replayPrRounds) and report which round-2+ blocks would have become cards
 *   and how many later rounds would not have happened. Read-only: it reads `review-pr` run records and local git, and
 *   writes nothing except the fixtures it is asked to emit.
 *
 * Usage:
 *   node scripts/operations/review-round-replay.mjs [--day=2026-10-08] [--repo=we|<owner/name>]
 *     [--runs-dir=<dir>] [--cwd=<git checkout>] [--prs=4441,4433] [--emit-fixtures=<dir>] [--json]
 *   node scripts/operations/review-round-replay.mjs --round-budget=3 [--day=…] [--prs=…] [--json]
 *     Card 5471 [A1/A4]: replay every recorded round 2+ through the round budget at K and report which `changes`
 *     rounds it would have accepted with cards, and why the others still block.
 *   node scripts/operations/review-round-replay.mjs --round-cards [--cwd=<checkout>] [--json]
 *     Card 5471 [A3]: the card debt the round budget / binding prior round created — round cards filed, findings they
 *     carry, and the share since resolved, per rule (we:scripts/lib/review-loop-policy.mjs#roundCardsReport).
 *
 * WHAT A ROUND IS. One `review-pr` run that reduced a verdict, per distinct reviewed head (a same-head re-run keeps the
 * latest). A PR counts when at least one of its rounds ran on `--day` (America/New_York); its earlier recorded rounds
 * are replayed too, so prior statuses exist, but only `--day`'s later rounds are counted.
 *
 * THE FACTS PER ROUND. Findings = the admitted findings plus the ones set aside as card suggestions; "held the live
 * verdict" = the same test the live sink uses (`findingHeldVerdict`); the live verdict = the verdict after referrals;
 * the delta = the record's own latest-fix range when it starts at the previous round's head, else `git diff` between
 * the two heads in `--cwd`; each finding's symbol = the enclosing declaration at the head (`git show`). A head git
 * cannot read gives no symbol and an unknown delta, which the rules treat as a full review (fail closed).
 */
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeFinding, MANDATORY_LENSES } from '../lib/jury-core.mjs';
import { enclosingSymbol, findingHeldVerdict, replayPrRounds } from '../lib/review-round-rules.mjs';
import { roundBudgetDecision, roundCardsReport } from '../lib/review-loop-policy.mjs';
import { readFixRange } from './review-pr-io.mjs';
import { sharedRunsDir } from './run-store.mjs';
import { DEFAULT_REPO_KEY, ghRepoSlug } from '../lib/constellation-repos.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The ET calendar day of an ISO instant. PURE. */
export function etDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const pick = (f) => {
  const n = normalizeFinding(f);
  return n ? { file: n.file, line: n.line, category: n.category, summary: n.summary.slice(0, 300), verdict: n.verdict,
    impactIfUnfixed: n.impactIfUnfixed, disposition: n.disposition, outcome: n.outcome } : null;
};

/**
 * One run record → the round facts the rules read (no symbols or delta yet). PURE. `null` for a record that reduced
 * no verdict (a failed or unfinished run) or names no pinned head.
 */
export function roundFactsFromRecord(record) {
  const F = record?.findings;
  const reduce = F?.reduce;
  const head = F?.read?.netBasis?.rev;
  if (!reduce || typeof head !== 'string' || !/^[0-9a-f]{40}$/i.test(head)) return null;
  const basisLenses = Array.isArray(reduce.basisLenses) ? reduce.basisLenses : MANDATORY_LENSES;
  const verdictOf = (v) => (typeof v === 'string' ? v : typeof v?.verdict === 'string' ? v.verdict : '');
  const admitted = (Array.isArray(reduce.admittedFindings) ? reduce.admittedFindings : []).map(pick).filter(Boolean);
  const deferred = (Array.isArray(reduce.deferredAdvisory) ? reduce.deferredAdvisory : []).map(pick).filter(Boolean);
  const at = record.stepTimings?.[0]?.startedAt ?? null;
  return {
    runId: record.id,
    at,
    head: head.toLowerCase(),
    liveVerdict: verdictOf(F.referralVerdict?.verdict) || verdictOf(reduce.verdict),
    humanRequired: F.read?.humanRequired === true,
    latestFix: F.read?.latestFix ?? null,
    // Card 5471 — the run's final verdict (after referrals), for the round-budget replay (`--round-budget=K`).
    verdict: record.verdict ?? null,
    findings: [
      ...admitted.map((finding) => ({ finding, heldVerdict: findingHeldVerdict(finding, { basisLenses }), deferred: false })),
      ...deferred.map((finding) => ({ finding, heldVerdict: false, deferred: true })),
    ],
  };
}

/** Load every `review-pr` record for `repo`, grouped per PR, one round per distinct head, in time order. */
export function loadRounds({ runsDir, repo }) {
  const byPr = new Map();
  for (const name of readdirSync(runsDir)) {
    if (!name.startsWith('review-pr-') || !name.endsWith('.json')) continue;
    let record;
    try { record = JSON.parse(readFileSync(join(runsDir, name), 'utf8')); } catch { continue; }
    if (record?.op !== 'review-pr' || record.input?.repo !== repo) continue;
    const facts = roundFactsFromRecord(record);
    if (!facts) continue;
    facts.at ??= statSync(join(runsDir, name)).mtime.toISOString();
    const pr = Number(record.input.pr);
    if (!byPr.has(pr)) byPr.set(pr, []);
    byPr.get(pr).push(facts);
  }
  for (const [pr, list] of byPr) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    // One round per head: a same-head re-run replaces the earlier run (it is not a new fix round).
    const perHead = [];
    for (const r of list) {
      const i = perHead.findIndex((x) => x.head === r.head);
      if (i >= 0 && i === perHead.length - 1) perHead[i] = r; else if (i < 0) perHead.push(r);
    }
    byPr.set(pr, perHead);
  }
  return byPr;
}

/** Add symbols and deltas from git. A file or range git cannot read is left unknown (the fail-closed direction). */
export function enrichRounds(rounds, { exec }) {
  const cache = new Map();
  const show = (head, path) => {
    const key = `${head}:${path}`;
    if (!cache.has(key)) {
      try { cache.set(key, String(exec('git', ['show', '--end-of-options', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }))); }
      catch { cache.set(key, null); }
    }
    return cache.get(key);
  };
  return rounds.map((r, i) => {
    const prevHead = i > 0 ? rounds[i - 1].head : null;
    let delta = null;
    if (prevHead) {
      delta = r.latestFix?.priorHead?.toLowerCase() === prevHead && r.latestFix.files ? r.latestFix
        : readFixRange({ exec, priorHead: prevHead, head: r.head });
    }
    const findings = r.findings.map((item) => {
      const file = typeof item.finding.file === 'string' ? item.finding.file.trim().replace(/^\.\//, '').replace(/:\d+(?::\d+)?$/, '') : '';
      const text = file && Number.isInteger(item.finding.line) && !file.split('/').includes('..') && !file.startsWith('-') ? show(r.head, file) : null;
      return { ...item, symbol: text == null ? '' : enclosingSymbol(text, item.finding.line, file) };
    });
    return { ...r, delta, findings };
  });
}

/** A fixture keeps only what the rules read: the delta trimmed to the files any round's findings cite. PURE. */
export function toFixture({ repo, pr, rounds, result }) {
  const cited = new Set(rounds.flatMap((r) => r.findings.map((f) => String(f.finding.file ?? '').replace(/:\d+(?::\d+)?$/, '')).filter(Boolean)));
  const trim = (delta) => {
    if (!delta || delta.error || !delta.files) return delta;
    return { priorHead: delta.priorHead, head: delta.head, files: Object.fromEntries(Object.entries(delta.files).filter(([p]) => cited.has(p))) };
  };
  return {
    v: 1, kind: 'we.review-round-replay-fixture', repo, pr,
    rounds: rounds.map((r) => ({ runId: r.runId, at: r.at, head: r.head, liveVerdict: r.liveVerdict, humanRequired: r.humanRequired,
      delta: trim(r.delta), findings: r.findings.map(({ finding, symbol, heldVerdict, deferred }) => ({ finding, symbol, heldVerdict, deferred })) })),
    expected: {
      summaries: result.rounds.map((x) => ({ round: x.summary.round, liveBlocked: x.summary.liveBlocked, shadowBlocked: x.summary.shadowBlocked,
        blocked: x.summary.blocked, carded: x.summary.carded, roundAvoided: x.summary.roundAvoided })),
      projection: result.projection,
    },
  };
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) { const m = a.match(/^--([\w-]+)(?:=(.*))?$/); if (m) out[m[1]] = m[2] ?? true; }
  return out;
}

export function main(argv = process.argv.slice(2), { log = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const args = parseArgs(argv);
  const repo = args.repo ? ghRepoSlug(String(args.repo)) : ghRepoSlug(DEFAULT_REPO_KEY);
  const day = args.day || etDay(new Date().toISOString());
  const runsDir = resolve(args['runs-dir'] || sharedRunsDir());
  const cwd = resolve(args.cwd || REPO_ROOT);
  const only = args.prs ? new Set(String(args.prs).split(',').map(Number)) : null;
  if (args['round-cards']) {
    const dir = join(cwd, 'backlog');
    const texts = readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => { try { return readFileSync(join(dir, n), 'utf8'); } catch { return ''; } });
    const report = roundCardsReport(texts);
    const pct = (r) => (r === null ? 'n/a' : `${Math.round(r * 100)}%`);
    if (args.json) log(JSON.stringify(report, null, 1));
    else {
      log(`round cards: ${report.cards} card(s), ${report.findings} finding(s) carded, ${report.resolvedCards} card(s) resolved (fix rate ${pct(report.fixRate)})`);
      for (const [rule, b] of Object.entries(report.byRule)) log(`  ${rule}: ${b.cards} card(s), ${b.findings} finding(s), fix rate ${pct(b.fixRate)}`);
    }
    return report;
  }
  const exec = (cmd, a, opts) => execFileSync(cmd, a, { ...opts, cwd });
  const byPr = loadRounds({ runsDir, repo });
  if (args['round-budget'] !== undefined) {
    const k = Number(args['round-budget']);
    const out = [];
    for (const [pr, all] of [...byPr].sort((a, b) => a[0] - b[0])) {
      if (only && !only.has(pr)) continue;
      all.forEach((r, i) => {
        if (i === 0 || etDay(r.at) !== day) return;
        const d = roundBudgetDecision({ verdict: r.verdict, round: i + 1, budget: k });
        out.push({ pr, round: i + 1, runId: r.runId, liveVerdict: r.liveVerdict, apply: d.apply, reason: d.reason, cards: d.cards.length });
      });
    }
    const accepted = out.filter((x) => x.apply);
    const changesPastK = out.filter((x) => x.round > k && x.liveVerdict === 'changes');
    const total = { day, repo, k, laterRounds: out.length, changesRoundsPastK: changesPastK.length, acceptedWithCards: accepted.length,
      stillBlocking: Object.entries(changesPastK.filter((x) => !x.apply).reduce((m, x) => ({ ...m, [x.reason]: (m[x.reason] ?? 0) + 1 }), {})) };
    if (args.json) log(JSON.stringify({ total, rows: out }, null, 1));
    else {
      for (const x of out.filter((y) => y.round > k)) log(`#${x.pr} r${x.round} live ${x.liveVerdict || '-'} → ${x.apply ? `ACCEPT with ${x.cards} card(s)` : `as today (${x.reason})`}`);
      log(`\n${day} ${repo} K=${k}: ${changesPastK.length} \`changes\` round(s) past K; ${accepted.length} would accept with cards; `
        + `still blocking: ${total.stillBlocking.map(([r, n]) => `${r} ${n}`).join(', ') || 'none'}.`);
    }
    return { total, rows: out };
  }
  const rows = [];
  let laterRounds = 0; let laterBlocked = 0; let wouldCard = 0; let avoided = 0; let whatIf = 0;
  for (const [pr, all] of [...byPr].sort((a, b) => a[0] - b[0])) {
    if (only && !only.has(pr)) continue;
    if (!all.some((r) => etDay(r.at) === day)) continue;
    const rounds = enrichRounds(all, { exec });
    const result = replayPrRounds(rounds, { repo, pr });
    const today = result.rounds.map((x, i) => ({ ...x, at: rounds[i].at })).filter((x) => etDay(x.at) === day);
    const later = today.filter((x) => x.summary.round > 1);
    const blockedLater = later.filter((x) => x.summary.liveBlocked);
    const turned = blockedLater.filter((x) => x.summary.roundAvoided);
    // Rounds avoided = every recorded round after the first later round the shadow would have accepted, counted on `day`.
    const stopIdx = result.rounds.findIndex((x) => x.summary.roundAvoided);
    const avoidedHere = stopIdx < 0 ? 0 : result.rounds.slice(stopIdx + 1).filter((x, i) => etDay(rounds[stopIdx + 1 + i].at) === day).length;
    laterRounds += later.length; laterBlocked += blockedLater.length; wouldCard += turned.length; avoided += avoidedHere;
    // WHAT-IF (diagnostic only, never a rule): the same, if a confirmed-broken finding on UNCHANGED code also became a
    // card. Shows how much of the gap to the proposal's estimate the confirmed-broken floor accounts for.
    const whatIfIdx = result.rounds.findIndex((x) => x.summary.roundAvoided || (x.summary.round > 1 && x.summary.liveBlocked
      && x.entries.length > 0 && x.entries.filter((e) => e.decision === 'block').every((e) => e.reason === 'confirmed-broken' && ['far', 'untouched'].includes(e.change))));
    const whatIfHere = whatIfIdx < 0 ? 0 : result.rounds.slice(whatIfIdx + 1).filter((x, i) => etDay(rounds[whatIfIdx + 1 + i].at) === day).length;
    whatIf += whatIfHere;
    rows.push({ pr, rounds: result.rounds.length, todayLater: later.length, liveBlockedLater: blockedLater.length,
      turnedToCards: turned.map((x) => x.summary.round), avoidedRounds: avoidedHere,
      perRound: result.rounds.map((x) => `r${x.summary.round}:${x.summary.liveVerdict}/${x.summary.round < 2 ? 'full' : x.summary.shadowBlocked ? `block(${x.summary.blocked}b,${x.summary.carded}c)` : x.summary.liveBlocked ? `CARDS(${x.summary.carded})` : 'accept'}`).join(' ') });
    if (args['emit-fixtures'] && only) {
      const dir = resolve(String(args['emit-fixtures']));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `pr-${pr}.json`), `${JSON.stringify(toFixture({ repo, pr, rounds, result }), null, 1)}\n`);
    }
  }
  const total = { day, repo, prs: rows.length, laterRounds, liveBlockedLaterRounds: laterBlocked, laterBlocksTurnedToCards: wouldCard, roundsAvoided: avoided,
    whatIfConfirmedBrokenOnUnchangedCodeCarded: whatIf };
  if (args.json) { log(JSON.stringify({ total, rows }, null, 1)); return { total, rows }; }
  for (const r of rows) log(`#${r.pr}: ${r.perRound}${r.avoidedRounds ? `  → ${r.avoidedRounds} later round(s) avoided` : ''}`);
  log(`\n${day} ${repo}: ${rows.length} PRs; ${laterRounds} round-2+ reviews (${laterBlocked} blocked live); `
    + `${wouldCard} of those blocks would have turned into cards; ${avoided} of ${laterRounds} later rounds would not have happened `
    + `(what-if confirmed-broken on unchanged code were carded too: ${whatIf}).`);
  return { total, rows };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
