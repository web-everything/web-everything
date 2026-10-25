/**
 * @file scripts/lib/round-judge.mjs
 * @description THE SHADOW ROUND JUDGE (operator OK 2026-10-21): when a PR reaches a round cap, compute what a judge
 *   WOULD do from round N versus round N-1 evidence. It never acts: the caller logs the verdict and nothing else.
 *
 *   PURE. No gh, no fs, no clock. Deterministic rules only; there is no model call. The verdict is one of
 *     grant(+K)       - findings are shrinking and none came back unfixed: one more auto round is worth it.
 *     send-back       - the DEFAULT when unsure: return the open findings to the fixer.
 *     card-the-rest   - every open finding is coverage / degraded class (never a confirmed correctness or security
 *                       break): file them as cards instead of spending another round.
 *     suggest-split   - the diff (or the surface the findings touch) keeps growing: split the PR.
 *     escalate        - a person must look: a guard / gate file is touched, the same finding came back unfixed after
 *                       more than one send-back, a finding reads like a guard being weakened, or the judge failed.
 *
 *   Findings are mapped through the EXISTING policy, not a new one: red-team findings and review findings both go
 *   through `we:scripts/lib/red-team-gate.mjs` `breakClass` + `planRedTeamActions` under the live
 *   `redTeam.confirmedBreaks` setting (broken -> send-back, degraded -> card, unconfirmed -> advisory). A review
 *   finding the reviewer labelled COVERAGE (or `impact if unfixed: degraded`) is the `degraded` class.
 *
 *   FAIL CLOSED: any throw, and any verdict that fails {@link validateVerdict}, becomes `escalate`.
 */
import { parseRedTeamComment, breakClass, planRedTeamActions, CONFIRMED_BREAKS_DEFAULTS, parseRedTeamGateMarker,
  GATE_OUTCOMES } from './red-team-gate.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { roundExtensionGrants } from '../conveyor/round-extension-mark.mjs';
import { verifyFinding } from './round-judge-verify.mjs';
import { isTrustChainPath, isPolicyCorePath, isEngineTierPath, isPolicySpecPath, isStatutePath } from './gate-config.mjs';

export const VERDICTS = Object.freeze(['grant', 'send-back', 'card-the-rest', 'suggest-split', 'escalate', 'not-real-verified']);
export const TRIGGERS = Object.freeze(['red-team-cap', 'review-cap', 'referral-hold']);
/** Hard backstop on total grants per PR (operator 2026-10-21: progress decides, this only stops a runaway). Setting `rounds.judge.maxGrants`. */
export const MAX_JUDGE_GRANTS = 20;
/** Diff growth that reads as "keeps growing": at least this ratio AND this many lines since the prior observation. */
export const SPLIT_GROWTH_RATIO = 1.3;
export const SPLIT_GROWTH_LINES = 150;
const SIMILARITY = 0.6;

const REVIEW_CHANGES_PREFIX = '🔁 review — changes requested';
const REVIEW_ROUND_NOTE = /auto-repair rounds exhausted/i;
const MECHANICAL_PUSH = /previously accepted PR was re-pushed|card squash proof|unowned mechanical rebase|stale-base refresh|acceptance re-stamped after a rebase|Recorded by parked-pr-conflict/i;
const WEAKENING = /\b(fail[- ]open|forge[sd]?|forgeable|bypass(?:es|ed)?|weaken(?:s|ed|ing)?|disable[sd]? the (?:guard|gate)|kill[- ]switch)\b/i;

const bodyOf = (c) => (typeof c === 'string' ? c : typeof c?.body === 'string' ? c.body : '');
const timeOf = (c) => { const t = Date.parse(c?.createdAt ?? ''); return Number.isFinite(t) ? t : 0; };

/**
 * A guard / gate file: the trust chain, policy core / engine / spec, or a CI workflow. PURE.
 * Statute paths (`docs/agent/platform-decisions.md` ...) are NOT matched by path alone: whether a statute is edited
 * needs the diff hunks (`gate-config.mjs#isStatuteAnchorEdit`), which a thread does not carry. Matching the whole file
 * would escalate every PR that merely touches a prose doc.
 */
export function isGuardPath(path) {
  const p = String(path ?? '').replace(/^we:/, '');
  if (!p) return false;
  return GATE_FILE.test(p) || isTrustChainPath(p) || isPolicyCorePath(p) || isEngineTierPath(p) || isPolicySpecPath(p)
    || /^\.github\/workflows\//.test(p);
}

/** Gate / guard modules by name, beyond the trust chain: the red-team and merge gates, the drain's safety, gate-* libs. */
const GATE_FILE = /(?:^|\/)(?:red-team-gate[\w-]*|review-gate[\w-]*|merge-gate[\w-]*|drain-queue-safety[\w-]*|gate-[\w-]+)\.(?:mjs|cjs|js)$/;
const tokens = (s) => new Set(String(s ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(' ').filter((w) => w.length > 3));
function similarity(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

/** Same finding re-raised: same file:line, or (same file or an unnamed file) with a near-identical summary. PURE. */
export function sameFinding(a, b) {
  if (a.file && a.file === b.file && a.line != null && a.line === b.line) return true;
  const fileOk = !a.file || !b.file || a.file === b.file;
  return fileOk && similarity(a.summary, b.summary) >= SIMILARITY;
}

// ── Evidence from the PR thread ─────────────────────────────────────────────────────────────────────────────────

const REVIEW_BULLET = /^(?:- |\d+\. )`([^`\s]+?)(?::(\d+))?`(?: \([^)]*\))? — (.*)$/;

/** Findings from one `review — changes requested` comment from the reviewer. PURE. */
export function parseReviewFindings(body) {
  const out = [];
  for (const line of String(body ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const m = REVIEW_BULLET.exec(line);
    if (!m) continue;
    const summary = m[3].replace(/_\[[^\]]*\]_/g, '').trim().slice(0, 700);
    const impact = /_\[impact if unfixed: ([a-z]+)\]_/i.exec(m[3])?.[1]?.toLowerCase() ?? null;
    const coverage = /^COVERAGE\b/i.test(summary);
    out.push({ file: m[1], line: m[2] == null ? null : Number(m[2]), summary, confirmed: true,
      // An explicit `broken` impact wins over a COVERAGE label: never downgrade a stated break.
      impact: impact === 'broken' ? 'broken' : (coverage || impact === 'degraded' || impact === 'cosmetic' ? 'degraded' : (impact ?? null)),
      category: coverage ? 'coverage' : 'review' });
  }
  return out;
}

function classify(f) { return breakClass({ confirmed: f.confirmed, impact: f.impact }); }

/**
 * Every round of findings in the thread, oldest first. A red-team round is one trusted advisory comment (per head);
 * a review round is one reviewer `changes requested` comment. Conflict-watch bounces, the red-team gate's own
 * send-back copy and operator decisions are not review rounds. PURE.
 * @returns {Array<{source:'red-team'|'review', at:number, rev:(string|null), findings:object[]}>}
 */
export function extractRounds(comments, pr) {
  const out = [];
  (Array.isArray(comments) ? comments : []).forEach((c, i) => {
    if (!isTrustedMarkerAuthor(c)) return;
    const body = bodyOf(c);
    const rt = parseRedTeamComment(body);
    if (rt) {
      if (rt.pr !== Number(pr)) return;
      const findings = rt.findings.map((f) => ({ file: f.file, line: f.line, summary: f.summary, confirmed: f.confirmed,
        impact: f.impact, category: f.category, detail: [f.scenario, f.recheck].filter(Boolean).join(' ').slice(0, 700) }));
      out.push({ source: 'red-team', at: timeOf(c), i, rev: rt.rev, findings });
      return;
    }
    const head = body.trimStart();
    if (/^review paused:/.test(head) && /Waiting on your ruling/.test(head)) {
      const findings = parseReviewFindings(head.split('Waiting on your ruling')[1] ?? '');
      if (findings.length) out.push({ source: 'referral', at: timeOf(c), i, rev: null, findings });
      return;
    }
    if (!head.startsWith(REVIEW_CHANGES_PREFIX)) return;
    if (/Recorded by (?:parked-pr-conflict|agent \(red-team gate\)|chalbert|auto-policy)/i.test(head.slice(0, 400))) return;
    const findings = parseReviewFindings(head);
    if (findings.length) out.push({ source: 'review', at: timeOf(c), i, rev: null, findings });
  });
  return out.sort((a, b) => a.at - b.at || a.i - b.i);
}

/**
 * Which cap the PR is at, from the thread and the status state. PURE.
 * red-team-cap: the gate's `round-cap` record for the LIVE head, with no later `sent-back` record for that head.
 * referral-hold: the review paused for a ruling on mandatory referral findings and none was recorded after it.
 * review-cap: the status state is `at-round-limit`, or the conveyor's "auto-repair rounds exhausted" note stands
 * with no operator grant after it.
 * @returns {{trigger:('red-team-cap'|'review-cap'), at:number, key:string}|null}
 */
export function detectRoundCap({ comments, pr, head, state = null, repo = null }) {
  const list = Array.isArray(comments) ? comments : [];
  const live = String(head ?? '').toLowerCase();
  const gates = list.map((c, i) => ({ c, i, g: isTrustedMarkerAuthor(c) ? parseRedTeamGateMarker(bodyOf(c)) : null }))
    .filter((x) => x.g && x.g.pr === Number(pr) && x.g.rev === live);
  const cap = gates.filter((x) => x.g.outcome === GATE_OUTCOMES.ROUND_CAP).at(-1);
  if (cap) {
    const later = gates.some((x) => x.g.outcome === GATE_OUTCOMES.SENT_BACK && (timeOf(x.c) > timeOf(cap.c) || (timeOf(x.c) === timeOf(cap.c) && x.i > cap.i)));
    if (!later) return { trigger: 'red-team-cap', at: timeOf(cap.c), key: `${pr}:${live}:red-team-cap:${cap.g.result ?? ''}` };
  }
  // referral-hold: the review paused waiting for a block / card / not-real ruling, and none has been recorded since.
  const hold = list.filter((c) => isTrustedMarkerAuthor(c) && /^review paused:/.test(bodyOf(c).trimStart()) && /Waiting on your ruling/.test(bodyOf(c))).at(-1);
  if (hold && !list.some((c) => timeOf(c) > timeOf(hold) && isTrustedMarkerAuthor(c) && /^## (?:Operator|Automatic policy) ruling on mandatory referrals/.test(bodyOf(c).trimStart()))) {
    const h = /review-referral-hold: ([0-9a-f]{8,})/.exec(bodyOf(hold))?.[1] ?? String(timeOf(hold));
    return { trigger: 'referral-hold', at: timeOf(hold), key: `${pr}:${live}:referral-hold:${h}` };
  }
  const grants = repo ? roundExtensionGrants(list, { repo, pr }) : [];
  const lastGrantAt = grants.reduce((m, g) => Math.max(m, timeOf(list[g.index])), 0);
  const note = list.filter((c) => /needs your decision/i.test(bodyOf(c).slice(0, 80)) && REVIEW_ROUND_NOTE.test(bodyOf(c))).at(-1);
  if (state === 'at-round-limit' || (note && timeOf(note) > lastGrantAt && (state === 'needs-you' || state === 'escalated'))) {
    const noteKey = /conveyor-note-key: ([^\s>]+)/.exec(bodyOf(note))?.[1] ?? '';
    return { trigger: 'review-cap', at: note ? timeOf(note) : 0, key: `${pr}:${live}:review-cap:${noteKey || grants.length}` };
  }
  return null;
}

/**
 * Did the cap get spent without a finding? Counts mechanical re-push comments (conflict bounces, card squashes,
 * rebases, restamps) and reads whether the reviewer's LATEST verdict is an accept. PURE.
 */
export function mechanicalSpend(comments) {
  const list = (Array.isArray(comments) ? comments : []).filter((c) => isTrustedMarkerAuthor(c));
  const pushes = list.filter((c) => MECHANICAL_PUSH.test(bodyOf(c).trimStart().slice(0, 400))).length;
  const verdicts = list.filter((c) => /^(✅ review — accepted|🔁 review — changes requested)/.test(bodyOf(c).trimStart())
    && !/Recorded by (?:parked-pr-conflict|chalbert)/i.test(bodyOf(c).slice(0, 400)));
  const last = verdicts.sort((a, b) => timeOf(a) - timeOf(b)).at(-1);
  return { pushes, latestAccepted: !!last && bodyOf(last).trimStart().startsWith('✅') };
}

// ── The verdict ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Schema check for a verdict object (the judge's own output, and any future model's). PURE. */
export function validateVerdict(v) {
  const bad = (why) => ({ ok: false, why });
  if (!v || typeof v !== 'object') return bad('not an object');
  if (!VERDICTS.includes(v.verdict)) return bad(`verdict ${JSON.stringify(v.verdict)} is not one of ${VERDICTS.join('|')}`);
  if (v.verdict === 'not-real-verified' && (!Array.isArray(v.proof) || !v.proof.length || v.proof.some((x) => typeof x !== 'string' || !x.trim()))) return bad('not-real-verified needs non-empty proof');
  if (v.verdict === 'grant') {
    if (!Number.isInteger(v.k) || v.k < 1 || v.k > MAX_JUDGE_GRANTS) return bad('grant needs an integer k in 1..20');
  } else if (v.k !== undefined && v.k !== null) return bad('k is only valid on grant');
  if (v.body !== undefined && typeof v.body !== 'string') return bad('body must be a string');
  if (!Array.isArray(v.reasons) || !v.reasons.length || v.reasons.some((r) => typeof r !== 'string' || !r.trim())) return bad('reasons must be a non-empty list of strings');
  return { ok: true };
}

const failClosed = (why, extra = {}) => ({ verdict: 'escalate', reasons: [`fail-closed: ${why}`], evidence: { failClosed: true, ...extra } });

/**
 * Judge one PR at a round cap. PURE; fail closed.
 * @param {{pr:number, repo?:string, head:string, trigger:'red-team-cap'|'review-cap'|'referral-hold', comments:object[], files?:string[],
 *   diff?:{size?:number|null, prevSize?:number|null}, setting?:object, llm?:(evidence:object)=>object,
 *   verify?:(finding:object)=>{status:string, evidence:(string|null)}}} o
 *   `verify` is the deterministic claim checker (`round-judge-verify.mjs`); only a `refuted` result WITH evidence counts.
 *   `llm` is an optional tool-free, read-only second opinion supplied by a caller; its output is schema-validated and
 *   anything invalid, or any throw, is `escalate`. The judge never calls a model on its own.
 * @returns {{verdict:string, k?:number, reasons:string[], evidence:object}}
 */
export function judgeRound(o) {
  try {
    const v = judgeRoundUnsafe(o);
    const ok = validateVerdict(v);
    if (!ok.ok) return failClosed(`verdict failed schema (${ok.why})`);
    if (typeof o.llm === 'function') {
      let second;
      try { second = o.llm(v.evidence); } catch (e) { return failClosed(`llm judge threw (${String(e?.message ?? e).slice(0, 120)})`, { deterministic: v.verdict }); }
      const sv = validateVerdict(second);
      if (!sv.ok) return failClosed(`llm verdict failed schema (${sv.why})`, { deterministic: v.verdict });
      // A second opinion may only be stricter: it can never loosen the deterministic verdict.
      if (strictness(second.verdict) < strictness(v.verdict)) {
        return { ...v, reasons: [...v.reasons, `llm-suggested-looser:${second.verdict}-ignored`] };
      }
      if (strictness(second.verdict) > strictness(v.verdict)) return { ...second, evidence: v.evidence };
    }
    return v;
  } catch (e) {
    return failClosed(`judge threw (${String(e?.message ?? e).slice(0, 160)})`);
  }
}

const STRICT_ORDER = ['not-real-verified', 'grant', 'card-the-rest', 'send-back', 'suggest-split', 'escalate'];
const strictness = (v) => STRICT_ORDER.indexOf(v);

function judgeRoundUnsafe({ pr, repo = null, head, trigger, comments, files = [], diff = {}, setting = CONFIRMED_BREAKS_DEFAULTS, verify = null, maxGrants = MAX_JUDGE_GRANTS }) {
  if (!TRIGGERS.includes(trigger)) throw new Error(`unknown trigger ${JSON.stringify(trigger)}`);
  const rounds = extractRounds(comments, pr);
  const sourceOf = { 'red-team-cap': 'red-team', 'review-cap': 'review', 'referral-hold': 'referral' }[trigger];
  const same = rounds.filter((r) => r.source === sourceOf);
  const latest = same.at(-1) ?? null;
  const prior = latest ? same.slice(0, -1) : [];
  const prev = prior.at(-1) ?? null;
  const grants = repo ? roundExtensionGrants(comments ?? [], { repo, pr }) : [];
  // The shared reader clamps its running total at 10; the judge's ceiling is its own, so validate each grant alone.
  const grantsSoFar = repo ? (comments ?? []).reduce((n, c) => n + (roundExtensionGrants([c], { repo, pr })[0]?.by ?? 0), 0) : 0;
  const fileList = [...new Set((files ?? []).map(String))];
  const reasons = [];

  const open = (r) => (r?.findings ?? []).filter((f) => f.confirmed);
  const latestOpen = open(latest);
  const prevOpen = open(prev);
  const history = rounds.filter((r) => r !== latest && r.at <= (latest?.at ?? Infinity));

  // Per finding: how many EARLIER rounds already raised it.
  const annotated = latestOpen.map((f) => ({
    ...f, cls: classify(f),
    priorAppearances: history.filter((r) => open(r).some((g) => sameFinding(f, g))).length,
  }));
  const repeated = annotated.filter((f) => f.priorAppearances >= 1);
  const unfixedAfterSendBacks = annotated.filter((f) => f.priorAppearances >= 2); // came back after >1 send-back
  const knownFiles = new Set(history.flatMap((r) => open(r).map((f) => f.file)).filter(Boolean));
  const newFiles = [...new Set(annotated.map((f) => f.file).filter((f) => f && !knownFiles.has(f)))];

  const plan = planRedTeamActions({ findings: latestOpen }, setting);
  const keyOf = (f) => `${f.file}:${f.line}:${f.summary}`;
  const planKeys = { sendBack: new Set(plan.sendBack.map(keyOf)), card: new Set(plan.card.map(keyOf)) };
  const brokenOpen = annotated.filter((f) => f.cls === 'broken');

  // Confirmed breaks still open in the OTHER sources' latest rounds (a red-team round counts only for the live head)
  // must never be carded or granted over, whichever source tripped the cap.
  const liveHead = String(head ?? '').toLowerCase();
  const crossBroken = ['red-team', 'review', 'referral'].filter((src) => src !== sourceOf).flatMap((src) => {
    const r = rounds.filter((x) => x.source === src && (src !== 'red-team' || !liveHead || x.rev === liveHead)).at(-1);
    return r && (!latest || r.at >= latest.at - 7 * 864e5) ? open(r).filter((f) => classify(f) === 'broken') : [];
  });

  // Mechanical refutation (operator 2026-10-21, #5768): every open finding provably false on the live head.
  const checks = typeof verify === 'function' && annotated.length
    ? annotated.map((f) => { let r; try { r = verify(f); } catch { r = null; } return { f, r: r?.status === 'refuted' && r.evidence ? r : { status: 'inconclusive', evidence: null } }; })
    : [];
  const refuted = checks.filter((c) => c.r.status === 'refuted');
  const proof = refuted.map((c) => `${c.f.file}:${c.f.line} -> ${c.r.evidence}`);

  const guardFiles = [...new Set([...fileList, ...annotated.map((f) => f.file).filter(Boolean)])].filter(isGuardPath);
  // Operator 2026-10-21: a guard file ALONE never escalates. Only a finding IN guard code that the judge would rule
  // not-real or card (below) escalates; otherwise the usual rules apply (unsure -> send-back).
  const guardFindings = annotated.filter((f) => f.file && isGuardPath(f.file));
  const weakening = brokenOpen.filter((f) => WEAKENING.test(f.summary));

  const size = Number.isFinite(diff?.size) ? diff.size : null;
  const prevSize = Number.isFinite(diff?.prevSize) ? diff.prevSize : null;
  const growth = size != null && prevSize != null ? size - prevSize : null;
  const growthRatio = growth != null && prevSize > 0 ? size / prevSize : null;
  const diffGrowing = growth != null && growth >= SPLIT_GROWTH_LINES && (growthRatio == null || growthRatio >= SPLIT_GROWTH_RATIO);
  const surfaceWidening = same.length >= 3 && newFiles.length >= 2 && annotated.length >= prevOpen.length;

  const trend = !latest ? 'no-evidence' : !prev ? 'first-round'
    : repeated.length * 2 >= annotated.length && annotated.length ? 'repeating'
      : latestOpen.length < prevOpen.length ? 'shrinking' : 'changing';
  const categories = [...new Set(annotated.map((f) => f.category).filter(Boolean))];
  if (prev && categories.length && categories.every((c) => c === 'edge-case') && prevOpen.some((f) => f.category !== 'edge-case')) reasons.push('edge-case-drift');

  const evidence = {
    trigger, head: String(head ?? '').slice(0, 12), rounds: same.length, otherSourceRounds: rounds.length - same.length,
    latest: annotated.map((f) => ({ file: f.file, line: f.line, summary: f.summary.slice(0, 140), cls: f.cls, priorAppearances: f.priorAppearances })),
    latestCount: latestOpen.length, prevCount: prev ? prevOpen.length : null, trend,
    repeated: repeated.length, unfixedAfterSendBacks: unfixedAfterSendBacks.length, newFiles,
    classes: Object.fromEntries(['broken', 'degraded', 'unconfirmed'].map((k) => [k, annotated.filter((f) => f.cls === k).length])),
    policy: { sendBack: plan.sendBack.length, card: plan.card.length, advisory: plan.advisory.length },
    grantsSoFar, guardFiles, crossBroken: crossBroken.length, verified: checks.map((c) => ({ file: c.f.file, line: c.f.line, status: c.r.status, evidence: c.r.evidence })), diff: { size, prevSize, growth, growthRatio: growthRatio == null ? null : Number(growthRatio.toFixed(2)) },
    filesKnown: fileList.length > 0, mechanical: mechanicalSpend(comments),
  };

  const done = (verdict, why, k, withProof) => ({ verdict, ...(verdict === 'grant' ? { k } : {}), ...(withProof ? { proof: withProof } : {}), reasons: [...why, ...reasons], evidence });
  const statuteTouched = fileList.filter(isStatutePath);
  // Grants need file evidence and no statute edit we cannot inspect (no hunks in a thread) and no cross-source break.
  const noGrant = () => (!fileList.length ? 'no-file-evidence-no-grant'
    : statuteTouched.length ? `statute-file-uncertain-no-grant:${statuteTouched[0]}`
      : crossBroken.length ? `open-break-in-other-source-no-grant:${crossBroken[0].file}:${crossBroken[0].line}` : null);

  if (annotated.length && refuted.length === annotated.length && crossBroken.length) reasons.push(`not-real-blocked-by-open-break-in-other-source:${crossBroken[0].file}:${crossBroken[0].line}`);
  if (annotated.length && refuted.length === annotated.length && !crossBroken.length) {
    if (guardFindings.length) return done('escalate', [`not-real-on-guard-code:${guardFindings[0].file}:${guardFindings[0].line}`, `all-${annotated.length}-findings-mechanically-refuted`]);
    return done('not-real-verified', [`all-${annotated.length}-findings-mechanically-refuted`], undefined, proof);
  }
  if (refuted.length) reasons.push(`partially-refuted:${refuted.length}-of-${annotated.length}`);

  if (guardFiles.length) reasons.push(`guard-file-touched-noted:${guardFiles[0]}`);
  if (unfixedAfterSendBacks.length) {
    // Operator 2026-10-21: work out the concrete fix first; escalate only when none can be named.
    const fixes = unfixedAfterSendBacks.map(proposeFix);
    const tag = `${unfixedAfterSendBacks[0].priorAppearances}-send-backs:${unfixedAfterSendBacks[0].file}:${unfixedAfterSendBacks[0].line}`;
    if (fixes.every(Boolean)) return { ...done('send-back', [`same-finding-unfixed-after-${tag}`, 'concrete-fix-proposed']), body: fixes.join('\n') };
    return done('escalate', [`same-finding-unfixed-after-${tag}`, 'no-concrete-fix-found']);
  }
  if (weakening.length) return done('send-back', [`possible-guard-weakening:${weakening[0].file}:${weakening[0].line}`]);
  if (!latest && trigger === 'review-cap') {
    const m = mechanicalSpend(comments);
    if (m.latestAccepted && m.pushes >= 2) {
      if (grantsSoFar >= maxGrants) return done('escalate', [`mechanical-cap-but-${grantsSoFar}-grants-already-spent-ceiling-${maxGrants}`]);
      const blocked = noGrant();
      if (blocked) return done('send-back', [blocked]);
      const cardOnly = fileList.length > 0 && fileList.every((f) => /^backlog\//.test(f));
      return done('grant', [`cap-spent-on-${m.pushes}-mechanical-re-pushes`, 'latest-review-accepted', ...(cardOnly ? ['card-only'] : [])], 1);
    }
  }
  if (!latest) return done('send-back', ['no-parseable-findings-for-trigger']);
  if (diffGrowing) return done('suggest-split', [`diff-grew-${growth}-lines${growthRatio ? `-x${growthRatio.toFixed(2)}` : ''}`]);
  if (surfaceWidening) return done('suggest-split', [`finding-surface-widening:${newFiles.slice(0, 3).join(',')}`]);

  if (annotated.length && !brokenOpen.length && !crossBroken.length && annotated.every((f) => planKeys.card.has(keyOf(f)) || !planKeys.sendBack.has(keyOf(f)))) {
    if (guardFindings.length) return done('escalate', [`card-on-guard-code:${guardFindings[0].file}:${guardFindings[0].line}`]);
    return done('card-the-rest', ['only-coverage-or-degraded-findings-open', `cards=${plan.card.length}`]);
  }
  if (!annotated.length) return done(crossBroken.length ? 'send-back' : 'card-the-rest', [crossBroken.length ? 'open-break-in-other-source' : 'no-confirmed-findings-open']);
  if (trend === 'first-round') return done('send-back', ['first-round-nothing-to-compare']);
  if (trend === 'shrinking' && !repeated.length) {
    if (grantsSoFar >= maxGrants) return done('escalate', [`converging-but-${grantsSoFar}-grants-already-spent-ceiling-${maxGrants}`]);
    const blocked = noGrant();
    if (blocked) return done('send-back', [blocked]);
    const k = Math.min(maxGrants - grantsSoFar, annotated.length <= 2 && annotated.length * 2 <= prevOpen.length ? 2 : 1);
    return done('grant', [`findings-shrinking-${prevOpen.length}-to-${annotated.length}`, 'none-repeated'], k);
  }
  if (trend === 'repeating') return done('send-back', [`repeating-${repeated.length}-of-${annotated.length}-re-raised`]);
  if (trend === 'shrinking') return done('send-back', [`shrinking-but-${repeated.length}-re-raised`]);
  return done('send-back', ['findings-changing-not-shrinking']);
}

const REMEDY = /[^.!?\n]*\b(?:should|must|needs? to|ought to|instead of|rather than|replace|release|retain|count|keep|add (?:a|the|an)|use|make|reject|require)\b[^.!?\n]*[.!?]?/gi;

/**
 * Work out the concrete fix for a finding from its own text (the remedy sentence the reviewer / red team wrote, else a
 * named test). PURE. Returns a short instruction, or null when the text states none (the judge cannot name a fix).
 */
export function proposeFix(f) {
  const text = `${f.summary ?? ''} ${f.detail ?? ''}`;
  const hit = [...text.matchAll(REMEDY)].map((m) => m[0].trim()).filter((x) => x.length >= 25).at(-1);
  return hit ? `${f.file ?? '(file)'}${f.line ? `:${f.line}` : ''} - ${hit.slice(0, 300)}` : null;
}

/** The one-line log form. PURE. */
export function formatJudgeLine(pr, result) {
  const verdict = result.verdict === 'grant' ? `grant(+${result.k})` : result.verdict;
  const ev = result.proof?.length ? ` evidence=${result.proof.join(' | ')}` : '';
  return `round-judge-shadow: #${pr} verdict=${verdict}${ev} reasons=${result.reasons.join(';')}`;
}
