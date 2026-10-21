#!/usr/bin/env node
/**
 * @file scripts/operations/round-judge-replay.mjs
 * @description ONE-OFF replay of the shadow round judge (`we:scripts/lib/round-judge.mjs`) over finished PRs. For each
 *   round cap found in a PR's comment thread it computes the verdict from the thread UP TO that cap, finds what the
 *   operator actually did next (a round grant, a card ruling, a send-back), and reports agreement. READ-ONLY: it reads
 *   PR comments through `gh pr view --json` (or `--from-dir` JSON files) and writes nothing but stdout.
 *
 *   node scripts/operations/round-judge-replay.mjs [--prs=5701,5654,...] [--from-dir=<dir of <N>.json>] [--json]
 *
 *   Agreement: STRICT = same verdict (a grant is `grant`, a card ruling is `card-the-rest`, an operator send-back is
 *   `send-back`). LENIENT also counts grant and send-back as the same call, since at a red-team cap an operator grant
 *   IS what makes the gate send the breaks back: both mean "one more fixer round". Events with no recorded operator
 *   action are listed but left out of the percentages.
 *
 *   Limits (stated, not hidden): the per-head diff size is not in a PR thread, so the diff-growth rule cannot fire in a
 *   replay; the PR's FINAL file list stands in for the guard-file check.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeRound, isGuardPath } from '../lib/round-judge.mjs';
import { verifyFinding, makeGitRepo } from '../lib/round-judge-verify.mjs';
import { parseRedTeamGateMarker, GATE_OUTCOMES } from '../lib/red-team-gate.mjs';
import { isTrustedMarkerAuthor, isOperatorAuthored } from '../lib/marker-authorship.mjs';
import { ghRepoSlug, DEFAULT_REPO_KEY } from '../lib/constellation-repos.mjs';
import { GH_ARGV, parseJsonLines } from '../lib/review-label-provider.mjs';
import { ROUND_EXTENSION_MARKER } from '../conveyor/round-extension-mark.mjs';

export const REPLAY_PRS = Object.freeze([5701, 5654, 5690, 5769, 5530, 5784, 5492, 5502, 5729, 5758, 5759, 5485, 5768, 5775]);
const REPO = ghRepoSlug(DEFAULT_REPO_KEY);
const bodyOf = (c) => (typeof c?.body === 'string' ? c.body : '');
const timeOf = (c) => Date.parse(c?.createdAt ?? '') || 0;
const WINDOW_MS = 36 * 3600e3;

/**
 * What the operator recorded in the handoff for PRs whose thread alone does not show the action (facts copied from
 * the 2026-10-20/21 handoff notes: "+1 round" grants, card rulings, holds).
 */
export const HANDOFF_ACTIONS = Object.freeze({
  5701: 'grant', 5654: 'grant', 5690: 'grant', 5492: 'grant', 5530: 'card-the-rest', 5485: 'card-the-rest',
});

/** Cap events in a thread, oldest first. PURE. @returns {Array<{trigger:string, at:number, head:string, key:string}>} */
export function findCapEvents(comments, pr) {
  const out = [];
  const seen = new Set();
  for (const c of comments) {
    const g = isTrustedMarkerAuthor(c) ? parseRedTeamGateMarker(bodyOf(c)) : null;
    if (g && g.pr === pr && g.outcome === GATE_OUTCOMES.ROUND_CAP) {
      const key = `rt:${g.rev}:${g.result ?? ''}`;
      if (!seen.has(key)) { seen.add(key); out.push({ trigger: 'red-team-cap', at: timeOf(c), head: g.rev, key }); }
      continue;
    }
    if (/^review paused:/.test(bodyOf(c).trimStart()) && /Waiting on your ruling/.test(bodyOf(c)) && isTrustedMarkerAuthor(c)) {
      const key = `rh:${/review-referral-hold: ([0-9a-f]+)/.exec(bodyOf(c))?.[1] ?? timeOf(c)}`;
      if (!seen.has(key)) { seen.add(key); out.push({ trigger: 'referral-hold', at: timeOf(c), head: '', key }); }
      continue;
    }
    if (/needs your decision/i.test(bodyOf(c).slice(0, 80)) && /auto-repair rounds exhausted/i.test(bodyOf(c))) {
      const key = `rv:${/conveyor-note-key: ([^\s>]+)/.exec(bodyOf(c))?.[1] ?? timeOf(c)}`;
      if (!seen.has(key)) { seen.add(key); out.push({ trigger: 'review-cap', at: timeOf(c), head: '', key }); }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** What the operator did after a cap, from the thread alone. PURE. @returns {{action:string, at:number, note:string}|null} */
export function actualAfter(comments, from, until) {
  for (const c of [...comments].sort((a, b) => timeOf(a) - timeOf(b))) {
    const t = timeOf(c);
    if (t <= from || t > until) continue;
    const body = bodyOf(c).trimStart();
    if (body.startsWith(ROUND_EXTENSION_MARKER) && isOperatorAuthored(c)) {
      return { action: 'grant', at: t, note: /\bvia (standing-ruling-auto|[\w-]+)/.exec(body)?.[1] ?? 'grant' };
    }
    if (/^\*\*Operator ruling on the post-accept red team: card\*\*/.test(body)) return { action: 'card-the-rest', at: t, note: 'operator card ruling (red team)' };
    if (/^## Operator ruling on mandatory referrals/.test(body) && isOperatorAuthored(c)) {
      const kinds = [...body.matchAll(/^\d+\. \*\*(card|not-real|block)\*\*/gm)].map((m) => m[1]);
      if (kinds.length && kinds.every((k) => k === 'not-real')) return { action: 'not-real-verified', at: t, note: 'operator ruled not-real' };
      if (kinds.includes('block')) return { action: 'send-back', at: t, note: 'operator block ruling' };
      if (kinds.includes('card')) return { action: 'card-the-rest', at: t, note: 'operator card ruling (referrals)' };
    }
    if (/^\*\*Operator ruling on the post-accept red team: (block|send)/i.test(body)) return { action: 'send-back', at: t, note: 'operator block ruling' };
    if (body.startsWith('🔁 review — changes requested') && isOperatorAuthored(c)) return { action: 'send-back', at: t, note: 'operator send-back' };
  }
  return null;
}

const LENIENT_SAME = new Set(['grant', 'send-back']);

/** Replay one PR. PURE given the gh JSON. */
export function replayPr(data, { withoutGuardFiles = false, repoFor = () => null } = {}) {
  const pr = data.number;
  const comments = [...(data.comments ?? [])].sort((a, b) => timeOf(a) - timeOf(b));
  const files = (data.files ?? []).map((f) => f.path).filter((f) => !withoutGuardFiles || !isGuardPath(f));
  const events = findCapEvents(comments, pr);
  return events.map((ev, i) => {
    const until = Math.min(events[i + 1]?.at ?? Infinity, ev.at + WINDOW_MS);
    const upTo = comments.filter((c) => timeOf(c) <= ev.at);
    const vrepo = repoFor(data, ev);
    const j = judgeRound({ pr, repo: REPO, head: ev.head || String(data.headRefOid ?? '').toLowerCase(), trigger: ev.trigger, comments: upTo, files,
      ...(vrepo ? { verify: (f) => verifyFinding(f, vrepo) } : {}) });
    let actual = actualAfter(comments, ev.at, until);
    if (!actual && HANDOFF_ACTIONS[pr] && i === events.length - 1) actual = { action: HANDOFF_ACTIONS[pr], at: 0, note: 'handoff note' };
    const verdict = j.verdict;
    const strict = actual ? verdict === actual.action : null;
    const lenient = actual ? (strict || (LENIENT_SAME.has(verdict) && LENIENT_SAME.has(actual.action))) : null;
    return { pr, trigger: ev.trigger, at: new Date(ev.at).toISOString(), verdict: j.verdict === 'grant' ? `grant(+${j.k})` : j.verdict,
      reasons: j.reasons, proof: j.proof ?? null, actual: actual?.action ?? null, actualNote: actual?.note ?? null, strict, lenient };
  });
}

export function summarize(rows) {
  const judged = rows.filter((r) => r.actual);
  const pct = (n) => (judged.length ? Math.round((100 * n) / judged.length) : 0);
  const strict = judged.filter((r) => r.strict).length;
  const lenient = judged.filter((r) => r.lenient).length;
  return { events: rows.length, withActual: judged.length, strict, lenient, strictPct: pct(strict), lenientPct: pct(lenient) };
}

function readPr(n, fromDir) {
  if (fromDir) {
    const p = join(fromDir, `${n}.json`);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  const env = { ...process.env }; delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  const run = (args) => execFileSync('/opt/homebrew/bin/gh', args, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const meta = JSON.parse(run(['pr', 'view', String(n), '--repo', REPO, '--json', 'number,labels,files,headRefOid']));
  // The COMPLETE paginated thread (the sanctioned reader), never `gh pr view --json comments` (stops at one page).
  return { ...meta, comments: parseJsonLines(run(GH_ARGV.readComments(REPO, n))) };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? '').slice(k.length + 3) || undefined;
  const prs = (arg('prs')?.split(',').map(Number)) ?? REPLAY_PRS;
  // Claim checking reads the PR's FINAL head from this clone (read-only `git show`/`git grep`). `--fetch` first fetches
  // refs/pull/<N>/head into the object store so a merged or force-pushed head is present.
  const fetched = new Set();
  const repoFor = (data) => {
    if (process.argv.includes('--no-verify') || !data.headRefOid) return null;
    if (process.argv.includes('--fetch') && !fetched.has(data.number)) {
      fetched.add(data.number);
      try { execFileSync('git', ['fetch', '-q', 'origin', `refs/pull/${data.number}/head`], { stdio: 'ignore', timeout: 60000 }); } catch { /* inconclusive */ }
    }
    return makeGitRepo({ head: data.headRefOid });
  };
  const rows = prs.flatMap((n) => { try { return replayPr(readPr(n, arg('from-dir')), { repoFor }); } catch (e) { return [{ pr: n, error: String(e.message).slice(0, 120) }]; } });
  const ok = rows.filter((r) => !r.error);
  const s = summarize(ok);
  const rows2 = prs.flatMap((n) => { try { return replayPr(readPr(n, arg('from-dir')), { withoutGuardFiles: true, repoFor }); } catch { return []; } });
  const s2 = summarize(rows2);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ summary: s, summaryIfGuardRuleOff: s2, rows }, null, 1));
  else {
    for (const r of rows) {
      console.log(r.error ? `#${r.pr} ERROR ${r.error}`
        : `#${r.pr} ${r.at.slice(5, 16)}Z ${r.trigger.padEnd(12)} judge=${r.verdict.padEnd(14)} actual=${(r.actual ?? 'none').padEnd(13)} ${r.strict == null ? '-' : r.strict ? 'STRICT' : r.lenient ? 'lenient' : 'MISS'}  ${r.reasons.join(';').slice(0, 90)}${r.proof ? `  EVIDENCE ${r.proof.join(' | ').slice(0, 300)}` : ''}`);
    }
    console.log(`\nevents=${s.events} withOperatorAction=${s.withActual} strict=${s.strict} (${s.strictPct}%) lenient=${s.lenient} (${s.lenientPct}%)`);
    console.log(`PR guard files dropped from the file list (diagnostic only, approximate): strict=${s2.strict} (${s2.strictPct}%) lenient=${s2.lenient} (${s2.lenientPct}%)`);
  }
}
