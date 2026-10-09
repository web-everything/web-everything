/** Coroner change-request rounds (card 102). Pure core + bounded gh/fs IO.
 * A round is one PR head that got a changes request: a conveyor review `changes` verdict, an advisory `changes`
 * outcome, a block-ruled mandatory referral, an operator send-back, or a red CI run that a later head replaced.
 * Each round carries its findings (file:line, lens, claim, ruling), the fix sessions it cost, and what the next
 * push changed (diffstat). Findings carry deterministic hints only; the /coroner skill makes the root-cause call.
 * Only comments from the automation or operator logins are read (marker-authorship.mjs).
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { isTrustedMarkerAuthor, isOperatorAuthored } from '../lib/marker-authorship.mjs';
import { countEdgeCaseClasses } from '../backlog/edge-case-classes.mjs';
import { ACCEPTANCE_HEADING_RE } from '../backlog/task-agreement.mjs';

const stamp = (v) => typeof v === 'string' ? Date.parse(v) : NaN;
const round1 = (n, d = 1) => Number(n.toFixed(d));
const minutes = (ms) => round1(ms / 60000);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const SHA = /\b[0-9a-f]{7,40}\b/;

export const ROOT_CAUSES = Object.freeze(['checklist-lacked-requirement', 'reinvented-existing-primitive', 'gate-missed-catching-test', 'fix-introduced', 'later-round-find', 'flaky-infra', 'other']);

/** REST issue comment -> { at, login, body, trusted, operator }. */
export function normalizeComment(c) {
  const login = c?.user?.login ?? c?.author?.login ?? '';
  const shaped = { author: { login }, body: c?.body ?? '' };
  return { at: c?.created_at ?? c?.createdAt ?? '', login, body: String(c?.body ?? ''), trusted: isTrustedMarkerAuthor(shaped), operator: isOperatorAuthored(shaped) };
}

/** Findings from a review / advisory body: `**lens/category** (n)` groups of `- \`file:line\` — claim — …` lines. */
export function parseFindings(body) {
  const out = [];
  const section = String(body).split(/^### Findings[^\n]*$/m)[1];
  if (!section) return out;
  let lens = null, category = null, current = null;
  for (const line of section.split('\n')) {
    if (/^(?:### |\*\*Advisory outcome:|---\s*$|Net basis:)/.test(line)) break;
    const head = line.match(/^\*\*([^*/]+)\/([^*]+)\*\*\s*\(\d+\)/);
    if (head) { lens = head[1].trim(); category = head[2].trim(); continue; }
    const item = line.match(/^- `([^`:]+?)(?::(\d+))?`\s+—\s+(.*)$/);
    if (item && lens) {
      current = { file: item[1], line: item[2] ? Number(item[2]) : null, lens, category, claim: clip(item[3].split(/\s+—\s+/)[0], 220), confidence: item[3].match(/_\[(CONFIRMED|PLAUSIBLE|SPECULATIVE)\]_/)?.[1] ?? null, impact: item[3].match(/impact if unfixed: (\w+)/)?.[1] ?? null };
      out.push(current); continue;
    }
    const prevention = line.match(/^\s+- _Prevention[^:]*:_\s*(.*)$/);
    if (prevention && current) current.prevention = clip(prevention[1], 200);
  }
  return out;
}

const lastMatch = (text, re) => { let m = null; for (const x of text.matchAll(re)) m = x; return m; };
/** Mandatory-referral rulings: `Rulings: [...]` JSON keys are ["judge", file, line, claim]. */
export function parseRulings(body) {
  const raw = String(body).match(/^Attempt recorded: true\.[^\n]*Rulings: (\[.*\])\s*$/m)?.[1];
  let list = [];
  try { list = JSON.parse(raw ?? '[]'); } catch { list = []; }
  return (Array.isArray(list) ? list : []).map((r) => {
    let key = [];
    try { key = JSON.parse(r?.key ?? '[]'); } catch { key = []; }
    return { file: typeof key[1] === 'string' ? key[1] : null, line: Number.isFinite(key[2]) ? key[2] : null, claim: clip(key[3] ?? '', 220), lens: 'referral', result: String(r?.result ?? '') };
  }).filter((r) => r.result);
}

/** One trusted comment -> a classified event, or null. */
export function classifyEvent(c) {
  if (!c.trusted) return null;
  const b = c.body, first = b.split('\n')[0];
  const head = (b.match(/^Net basis: `[0-9a-f]+\.\.([0-9a-f]{7,40})`/m)?.[1]) ?? (b.match(/for head `([0-9a-f]{7,40})`/)?.[1]) ?? null;
  if (/^🔁 review — changes requested/.test(first)) {
    const agent = /^Recorded by agent\b/m.test(b);
    const parsed = parseFindings(b);
    // An operator send-back is free text: its findings are the `file:line` citations it names.
    const findings = parsed.length ? parsed : [...new Map([...b.matchAll(/`([\w./-]+\.[a-z]{1,5}):(\d+)`[,:]?\s*([^\n]*)/g)].map((m) => [`${m[1]}:${m[2]}`, { file: m[1], line: Number(m[2]), lens: 'operator', category: 'send-back', claim: clip(m[3], 220) }])).values()];
    return { type: 'round', trigger: agent && !c.operator ? 'review-changes' : 'operator-send-back', at: c.at, head, findings, ...review(b) };
  }
  if (/^\*\*⚠️ THIS IS AN ADVISORY REVIEW/.test(first)) {
    // The real outcome line is rendered last; earlier ones can be juror text.
    const outcome = lastMatch(b, /^\*\*Advisory outcome:\*\* `(\w+)`/gm)?.[1] ?? null;
    return outcome === 'changes' ? { type: 'round', trigger: 'advisory-changes', at: c.at, head, findings: parseFindings(b), ...review(b) } : { type: 'review', outcome, at: c.at, head, ...review(b) };
  }
  if (/^✅ review — accepted/.test(first)) return { type: 'review', outcome: 'accept', at: c.at, head, ...review(b) };
  if (/^Mandatory review owner:/.test(first)) {
    const rulings = parseRulings(b);
    const encoded = b.match(/<!-- mandatory-referrals-v1: (\S+)/)?.[1];
    let refHead = null;
    try { refHead = JSON.parse(decodeURIComponent(encoded ?? ''))?.head ?? null; } catch { refHead = decodeURIComponent(encoded ?? '').match(/"head":"([0-9a-f]{40})"/)?.[1] ?? null; }
    const blocks = rulings.filter((r) => r.result === 'block');
    return blocks.length ? { type: 'round', trigger: 'referral-block', at: c.at, head: refHead, findings: blocks.map((r) => ({ ...r, ruling: 'block' })), rulings } : rulings.length ? { type: 'rulings', at: c.at, head: refHead, rulings } : null;
  }
  if (/^## (?:Operator|Automatic policy) ruling on mandatory referrals/.test(first)) {
    const blocks = [...b.matchAll(/^\d+\. \*\*(\w[\w-]*)\*\* — (.*?)(?: \(run `[^`]+`\))?$/gm)].map((m) => ({ file: null, line: null, lens: 'referral', claim: clip(m[2], 220), ruling: m[1] }));
    const hit = blocks.filter((x) => x.ruling === 'block');
    return hit.length ? { type: 'round', trigger: /^## Automatic policy/.test(first) ? 'policy-send-back' : 'operator-send-back', at: c.at, head, findings: hit } : null;
  }
  const who = b.match(/\*\*Who:\*\* `([^`]+)`/)?.[1] ?? b.match(/<!-- fix-claim who=(\S+) -->/)?.[1];
  if (/^🔒 conveyor fix-begin/.test(first)) return { type: 'fix-begin', at: c.at, who: who ?? 'fixer', head: b.match(/\*\*Branch:\*\* `[^`]+` at `([0-9a-f]{7,40})`/)?.[1] ?? null };
  if (/^🔓 conveyor fix-end/.test(first)) return { type: 'fix-end', at: c.at, who: b.match(/^`([^`]+)` released/m)?.[1] ?? who ?? 'fixer' };
  if (/^🩹 conveyor CI-heal/.test(first)) return { type: 'ci-heal', at: c.at };
  if (/merge conflict|CONFLICTING|conflict-fix/i.test(first)) return { type: 'conflict', at: c.at };
  return null;
}

/** Shared review-shape fields: care level and seated lenses ("Earned vs seated"), panel lens rows. */
function review(b) {
  const care = b.match(/scores care `(\w+)`/)?.[1] ?? null;
  const seated = Number(b.match(/This run seated (\d+) lens/)?.[1]);
  const table = b.split(/^### Panel verdicts\s*$/m)[1]?.split(/^### /m)[0] ?? '';
  const lenses = [...table.matchAll(/^\| ([^|]+?) \| (mandatory|advisory) \| (\w[\w-]*) \|$/gm)].map((m) => ({ lens: m[1], weight: m[2], verdict: m[3] }));
  return { care, seated: Number.isFinite(seated) ? seated : lenses.length || null, lenses };
}

/** New-side line ranges of a unified-diff patch. */
export function hunkRanges(patch) {
  return [...String(patch ?? '').matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => [Number(m[1]), Number(m[1]) + Math.max(0, Number(m[2] ?? 1) - 1)]);
}
const inRanges = (line, ranges, slack = 3) => Number.isFinite(line) && ranges.some(([a, b]) => line >= a - slack && line <= b + slack);

/** Heads of a PR in push order from the commits list ({ sha, commit: { committer: { date } } }). */
export function headsOf(commits) {
  return (commits ?? []).map((c) => ({ sha: c.sha, at: c.commit?.committer?.date ?? c.commit?.author?.date ?? '', parents: c.parents ?? [] })).filter((c) => c.sha && c.at).sort((a, b) => compare(a.at, b.at));
}
const headAt = (heads, at) => heads.filter((h) => stamp(h.at) <= stamp(at)).at(-1)?.sha ?? null;
const sameSha = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));

/** CI-red rounds: latest run per (head, workflow) red on a head that a later head replaced. */
export function ciRounds(ciRuns, heads) {
  const latest = new Map();
  for (const r of [...ciRuns].filter((x) => x.conclusion && !/review.?gate/i.test(x.name)).sort((a, b) => compare(a.createdAt, b.createdAt) || (a.runAttempt ?? 0) - (b.runAttempt ?? 0))) latest.set(`${r.headSha}|${r.name}`, r);
  const byHead = new Map();
  for (const r of latest.values()) {
    if (!['failure', 'timed_out', 'startup_failure'].includes(r.conclusion)) continue;
    const g = byHead.get(r.headSha) ?? []; g.push(r); byHead.set(r.headSha, g);
  }
  const final = heads.at(-1)?.sha;
  const out = [];
  for (const [sha, runs] of byHead) {
    if (sameSha(sha, final)) continue;
    const at = runs.map((r) => r.updatedAt || r.createdAt).sort(compare).at(-1);
    const checks = [...new Set(runs.flatMap((r) => (r.jobs ?? []).filter((j) => ['failure', 'timed_out'].includes(j.conclusion)).map((j) => j.name)).concat(runs.filter((r) => !r.jobs?.length).map((r) => r.name)))].slice(0, 6);
    const infra = runs.every((r) => r.conclusion !== 'failure') || checks.every((n) => /soak|smoke|outage/i.test(n));
    out.push({ type: 'round', trigger: 'ci-red', at, head: sha, findings: checks.map((name) => ({ file: null, line: null, lens: 'ci', category: name, claim: `CI check red: ${name}`, hint: infra ? 'flaky-infra' : 'gate-missed-catching-test' })) });
  }
  return out;
}

/** One finding per (file, line) or claim within a round; a referral ruling folds into the review finding it rules on. */
function mergeFindings(into, add) {
  for (const f of add) {
    const same = into.find((g) => f.file && g.file === f.file && (f.line == null || g.line == null || Math.abs(g.line - f.line) <= 2)) ?? into.find((g) => !f.file && g.claim === f.claim);
    if (same) { if (f.ruling) same.ruling = f.ruling; same.seenBy = [...new Set([...(same.seenBy ?? [same.lens]), f.lens])]; continue; }
    into.push({ ...f });
  }
  return into;
}

/** Group a PR's events into rounds (one per head) with fix sessions, next push and finding hints. */
export function buildPrRounds({ comments = [], commits = [], ciRuns = [], files = [], compares = {}, mergedAt = null }) {
  const events = comments.map(normalizeComment).map(classifyEvent).filter(Boolean).sort((a, b) => compare(a.at, b.at));
  const heads = headsOf(commits);
  const raw = [...events.filter((e) => e.type === 'round'), ...ciRounds(ciRuns, heads)].sort((a, b) => compare(a.at, b.at));
  const rounds = [];
  for (const e of raw) {
    const head = e.head ?? headAt(heads, e.at);
    const prev = rounds.find((r) => sameSha(r.head, head) || (!head && !r.head));
    if (prev) { prev.triggers = [...new Set([...prev.triggers, e.trigger])]; mergeFindings(prev.findings, e.findings); if (!prev.care && e.care) prev.care = e.care; continue; }
    rounds.push({ head, at: e.at, triggers: [e.trigger], findings: mergeFindings([], e.findings), care: e.care ?? null, seated: e.seated ?? null });
  }
  // Fix sessions: begin/end pairs by holder.
  const open = new Map(), sessions = [];
  for (const e of events) {
    if (e.type === 'fix-begin') open.set(e.who, e.at);
    if (e.type === 'fix-end' && open.has(e.who)) { sessions.push({ who: e.who, from: open.get(e.who), to: e.at }); open.delete(e.who); }
  }
  const originalFiles = new Set(files.map((f) => f.filename));
  const prior = [];
  rounds.forEach((r, i) => {
    const until = rounds[i + 1]?.at ?? mergedAt ?? '9999';
    const mine = sessions.filter((s) => stamp(s.from) >= stamp(r.at) - 60000 && stamp(s.from) < stamp(until));
    r.round = i + 1;
    r.fixSessions = mine.map((s) => ({ who: s.who, minutes: minutes(stamp(s.to) - stamp(s.from)) }));
    r.minutes = round1(r.fixSessions.reduce((a, s) => a + s.minutes, 0));
    const next = heads.find((h) => stamp(h.at) > stamp(r.at));
    const nextEnd = heads.filter((h) => stamp(h.at) > stamp(r.at) && stamp(h.at) < stamp(until)).at(-1) ?? next;
    const diff = r.head && nextEnd ? compares[`${r.head}...${nextEnd.sha}`] : null;
    const merged = heads.some((h) => stamp(h.at) > stamp(r.at) && stamp(h.at) < stamp(until) && (h.parents ?? []).length > 1);
    r.nextPush = next ? { sha: next.sha.slice(0, 9), at: next.at, waitMin: minutes(stamp(next.at) - stamp(r.at)), ...(merged ? { includesMainMerge: true } : {}), ...(diff ? { files: diff.files.length, additions: diff.additions, deletions: diff.deletions, paths: diff.files.slice(0, 8).map((f) => f.filename) } : {}) } : null;
    const prevFix = i > 0 ? compares[rounds[i - 1].compareKey] : null;
    for (const f of r.findings) {
      if (f.hint) continue;
      const reRaised = prior.some((p) => p.file && p.file === f.file && (f.line == null || p.line == null || Math.abs(p.line - f.line) <= 15));
      const fixHunk = prevFix?.files.find((x) => x.filename === f.file);
      f.hint = i === 0 ? null : fixHunk && inRanges(f.line, hunkRanges(fixHunk.patch)) ? 'fix-introduced' : reRaised ? 're-raised' : f.file && originalFiles.has(f.file) ? 'later-round-find' : null;
      if (reRaised) f.reRaised = true;
    }
    prior.push(...r.findings);
    r.compareKey = r.head && nextEnd ? `${r.head}...${nextEnd.sha}` : null;
  });
  const reviews = events.filter((e) => e.care || e.seated);
  return {
    rounds: rounds.map(({ compareKey, ...r }) => ({ ...r, head: r.head?.slice(0, 9) ?? null })),
    care: reviews[0]?.care ?? null, seated: reviews[0]?.seated ?? null,
    conflicts: events.filter((e) => e.type === 'conflict').length,
    fixMinutes: round1(sessions.reduce((a, s) => a + (stamp(s.to) - stamp(s.from)) / 60000, 0)),
    compareKeys: rounds.map((r) => r.compareKey).filter(Boolean),
  };
}

// --------------------------------------------------------------------------------------------- per-PR attributes
const isTest = (p) => /(?:^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|(?:^|\/)tests?\//.test(p);
/** Subsystem = up to two leading directories (`backlog` alone); a root file is `.`. */
export const subsystemOf = (p) => p.split('/').slice(0, -1).slice(0, p.startsWith('backlog/') ? 1 : 2).join('/') || '.';
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}${g.endsWith('/') ? '' : '$'}`);

/** Minimal frontmatter + body facts of one backlog card. */
export function parseCard(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) { const kv = line.match(/^([A-Za-z]\w*):\s*(.*)$/); if (kv) fm[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1'); }
  let scope = [];
  try { scope = JSON.parse(fm.scope ?? '[]'); } catch { scope = []; }
  const body = m[2];
  // The acceptance section (h2/h3): the shared task-agreement reader's heading rule (#5399 S7), plus the
  // hyphenated and "Definition of done" spellings this probe has always accepted.
  const acc = [...body.matchAll(/^#{2,3}\s+([^\n]*)$/gm)]
    .find((h) => ACCEPTANCE_HEADING_RE.test(h[1].trim()) || /^(?:done-when|definition of done)\b/i.test(h[1].trim()));
  const doneWhen = acc ? body.slice(acc.index + acc[0].length).split(/^#{1,3}\s/m)[0] : '';
  return {
    kind: fm.kind ?? null, size: Number.isFinite(Number(fm.size)) && fm.size !== '' ? Number(fm.size) : null, tier: fm.tier ?? null,
    preparedDate: /^\d{4}-\d{2}-\d{2}/.test(fm.preparedDate ?? '') ? fm.preparedDate : null, bornAs: fm.bornAs ?? null,
    scope: Array.isArray(scope) ? scope.filter((s) => typeof s === 'string') : [],
    checklist: /^\s*- \[[ xX]\]/m.test(body), checklistClasses: countEdgeCaseClasses(body),
    doneWhen: Boolean(doneWhen.trim()), doneWhenExecutable: /`[^`]*\b(?:node|npx|npm|vitest|bun)\b[^`]*`/.test(doneWhen),
  };
}

/** Card id from the lane branch: `lane/<digits>-…` or `lane/<x-hash>-…`; `lane/item-N` is a handoff item, not a card. */
export const cardIdOf = (ref) => String(ref ?? '').match(/^lane\/(\d{3,}|x[a-z0-9]{6})(?:-|$)/)?.[1] ?? null;

export function prAttributes({ pr, files = [], kind = 'code', card = null, receipt = null, baseDate = null, care = null, seated = null }) {
  const lines = (f) => (f.additions ?? 0) + (f.deletions ?? 0);
  const test = files.filter((f) => isTest(f.filename)), code = files.filter((f) => !isTest(f.filename) && !/\.md$/.test(f.filename));
  const subs = [...new Set(files.map((f) => subsystemOf(f.filename)))].sort(compare);
  const declared = (card?.scope ?? []).filter((s) => s.startsWith('we:')).map((s) => s.slice(3));
  const res = declared.map(globRe);
  const touched = files.map((f) => f.filename).filter((p) => !p.startsWith('backlog/'));
  const outside = declared.length ? touched.filter((p) => !res.some((re) => re.test(p))) : [];
  const untouched = declared.filter((s, i) => !touched.some((p) => res[i].test(p)));
  const routing = receipt?.entry?.payload?.routing ?? {};
  const author = pr.author ?? '';
  return {
    kind, filesChanged: files.length, additions: files.reduce((a, f) => a + (f.additions ?? 0), 0), deletions: files.reduce((a, f) => a + (f.deletions ?? 0), 0),
    subsystems: subs.length, subsystemList: subs.slice(0, 6),
    testToCode: round1(test.reduce((a, f) => a + lines(f), 0) / Math.max(1, code.reduce((a, f) => a + lines(f), 0)), 2),
    card: card ? { id: card.id, size: card.size, kind: card.kind, tier: card.tier } : null,
    prep: card ? {
      prepared: Boolean(card.preparedDate),
      preparedAgeDays: card.preparedDate ? round1((stamp(pr.createdAt) - stamp(`${card.preparedDate}T00:00:00Z`)) / 86400000) : null,
      checklist: card.checklist, checklistClasses: card.checklistClasses, doneWhenExecutable: card.doneWhenExecutable,
      scopeDeclared: declared.length, scopeOutside: outside.length, scopeUntouched: untouched.length,
    } : null,
    builder: receipt ? { who: 'conveyor-builder', executor: routing.executed ?? routing.routed ?? null, model: routing.model ?? null, tier: routing.tier ?? null }
      : { who: /\[bot\]$|^web-everything$/.test(author) ? 'conveyor-other' : author ? 'operator-agent' : 'unknown', executor: null, model: null, tier: null },
    care, seated,
    laneBaseAgeHours: baseDate ? round1((stamp(pr.createdAt) - stamp(baseDate)) / 3600000) : null,
  };
}

// --------------------------------------------------------------------------------------------- correlation
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; }
  return r;
}
export function spearman(xs, ys) {
  if (xs.length < 3) return null;
  const rx = ranks(xs), ry = ranks(ys), mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? round1(num / Math.sqrt(dx * dy), 2) : null;
}

/** Attribute accessors: numeric -> number|null; categorical -> string|null. */
export const ATTRIBUTES = Object.freeze({
  filesChanged: (a) => a.filesChanged, linesChanged: (a) => a.additions + a.deletions, subsystems: (a) => a.subsystems,
  testToCode: (a) => a.testToCode, cardSize: (a) => a.card?.size ?? null, cardKind: (a) => a.card?.kind ?? (a.card ? null : 'no-card'),
  care: (a) => a.care, seatedLenses: (a) => a.seated, prepared: (a) => a.prep ? String(a.prep.prepared) : null,
  preparedAgeDays: (a) => a.prep?.preparedAgeDays ?? null, checklist: (a) => a.prep ? String(a.prep.checklist) : null, checklistClasses: (a) => a.prep?.checklistClasses ?? null,
  doneWhenExecutable: (a) => a.prep ? String(a.prep.doneWhenExecutable) : null, scopeOutside: (a) => a.prep?.scopeOutside ?? null,
  builder: (a) => a.builder.who, executor: (a) => a.builder.executor ?? (a.builder.who === 'conveyor-builder' ? 'unrecorded' : null),
  laneBaseAgeHours: (a) => a.laneBaseAgeHours,
});

/** Ranked attribute -> extra-rounds table. extra = rounds - 1 floored at 0. Numeric splits at the median. */
export function correlate(prs, { minBucket = 2 } = {}) {
  const rows = [];
  for (const [name, get] of Object.entries(ATTRIBUTES)) {
    const pts = prs.map((p) => ({ p, v: get(p.attributes), y: Math.max(0, p.rounds.length - 1) })).filter((x) => x.v !== null && x.v !== undefined);
    if (pts.length < 2 * minBucket) continue;
    const numeric = pts.every((x) => typeof x.v === 'number');
    let buckets;
    if (numeric) {
      const sorted = pts.map((x) => x.v).sort((a, b) => a - b), med = sorted[Math.floor((sorted.length - 1) / 2)];
      buckets = [[`<= ${med}`, pts.filter((x) => x.v <= med)], [`> ${med}`, pts.filter((x) => x.v > med)]];
    } else {
      const g = new Map(); for (const x of pts) { const k = String(x.v); g.set(k, [...(g.get(k) ?? []), x]); }
      buckets = [...g];
    }
    buckets = buckets.filter(([, xs]) => xs.length >= minBucket);
    if (buckets.length < 2) continue;
    const stats = buckets.map(([value, xs]) => ({ value, n: xs.length, meanExtraRounds: round1(mean(xs.map((x) => x.y)), 2) })).sort((a, b) => b.meanExtraRounds - a.meanExtraRounds || compare(a.value, b.value));
    const worst = buckets.find(([v]) => v === stats[0].value)[1];
    rows.push({
      attribute: name, effect: round1(stats[0].meanExtraRounds - stats.at(-1).meanExtraRounds, 2), rho: numeric ? spearman(pts.map((x) => x.v), pts.map((x) => x.y)) : null, n: pts.length,
      buckets: stats, examples: worst.filter((x) => x.y > 0).sort((a, b) => b.y - a.y || a.p.pr - b.p.pr).slice(0, 2).map((x) => ({ pr: x.p.pr, extraRounds: x.y, value: x.v })),
    });
  }
  return rows.sort((a, b) => b.effect - a.effect || Math.abs(b.rho ?? 0) - Math.abs(a.rho ?? 0) || compare(a.attribute, b.attribute));
}

/** Pure: per-PR records (inputs already read) -> the `changeRequests` report, split by card-only / code. */
export function buildChangeRequests(prInputs) {
  const prs = prInputs.map((x) => {
    const r = buildPrRounds(x);
    const attributes = prAttributes({ ...x, care: r.care, seated: r.seated });
    return { pr: x.pr.number, kind: x.kind ?? 'code', mergedAt: x.pr.mergedAt ?? null, timeToMergeMin: x.pr.mergedAt ? minutes(stamp(x.pr.mergedAt) - stamp(x.pr.createdAt)) : null, rounds: r.rounds, conflicts: r.conflicts, fixMinutes: r.fixMinutes, ciReds: r.rounds.filter((y) => y.triggers.includes('ci-red')).length, attributes };
  }).sort((a, b) => a.pr - b.pr);
  const part = (kind) => {
    const mine = prs.filter((p) => p.kind === kind);
    const rounds = mine.flatMap((p) => p.rounds.map((r) => ({ ...r, pr: p.pr })));
    const byTrigger = {}, byHint = {};
    // A round can carry several triggers: byTrigger counts it once under each (minutes overlap).
    for (const r of rounds) for (const t of r.triggers) { byTrigger[t] ??= { rounds: 0, minutes: 0 }; byTrigger[t].rounds++; byTrigger[t].minutes = round1(byTrigger[t].minutes + r.minutes); }
    for (const r of rounds) for (const f of r.findings) { const h = f.hint ?? 'unclassified-round-1'; byHint[h] ??= { findings: 0, minutes: 0 }; byHint[h].findings++; byHint[h].minutes = round1(byHint[h].minutes + r.minutes / Math.max(1, r.findings.length)); }
    return {
      prs: mine.length, prsWithRounds: mine.filter((p) => p.rounds.length).length, rounds: rounds.length, findings: rounds.reduce((a, r) => a + r.findings.length, 0),
      minutes: round1(rounds.reduce((a, r) => a + r.minutes, 0)), byTrigger, byHint,
      records: mine.filter((p) => p.rounds.length).sort((a, b) => b.rounds.length - a.rounds.length || a.pr - b.pr),
      attributesOnly: mine.filter((p) => !p.rounds.length).map((p) => ({ pr: p.pr, attributes: p.attributes })),
      correlation: correlate(mine),
    };
  };
  return {
    basis: 'PRs opened in the window; a round = one PR head that got a changes request (review changes, advisory changes, block-ruled referral, operator send-back, or a red CI run on a head a later head replaced)',
    hints: 'deterministic only: fix-introduced (finding line inside the previous fix push hunks), re-raised (same file within 15 lines of an earlier finding), later-round-find (file in the original diff, raised after round 1), flaky-infra / gate-missed-catching-test (CI rounds). Round-1 findings are unclassified: the skill judges them.',
    rootCauses: ROOT_CAUSES,
    byKind: { code: part('code'), 'card-only': part('card-only') },
  };
}

// --------------------------------------------------------------------------------------------- IO (bounded)
/** Index backlog cards by number prefix and bornAs (first 4 KiB of each file only). */
export function cardIndex(dir, io = fs) {
  const byId = new Map();
  let names = [];
  try { names = io.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { return byId; }
  for (const name of names) {
    const num = name.match(/^(\d+|x[a-z0-9]{6})-/)?.[1];
    let fd, text = '';
    try { fd = io.openSync(join(dir, name), 'r'); const buf = Buffer.alloc(16 * 1024); const n = io.readSync(fd, buf, 0, buf.length, 0); text = buf.subarray(0, n).toString('utf8'); } catch { continue; } finally { if (fd !== undefined) io.closeSync(fd); }
    const card = parseCard(text);
    if (!card) continue;
    if (num) byId.set(num, { id: num, ...card });
    if (card.bornAs && !byId.has(card.bornAs)) byId.set(card.bornAs, { id: num ?? card.bornAs, ...card });
  }
  return byId;
}

export function readReceipts(dir, io = fs) {
  const byPr = new Map();
  let names = [];
  try { names = io.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return byPr; }
  for (const n of names) { try { const r = JSON.parse(io.readFileSync(join(dir, n), 'utf8')); if (Number.isSafeInteger(r?.pr)) byPr.set(r.pr, r); } catch { /* skip */ } }
  return byPr;
}

/** gh + git reads for the PRs opened in the window. Caps: `maxPrs` PRs (all comment pages, commits, files) and `maxCompares` compares. */
export function collectChangeRequests({ prs, prKinds = {}, prFiles = {}, ciRuns = [], gh, git = null, backlogDir, receiptsDir, repo, io = fs, maxPrs = 300, maxCompares = 150 }) {
  const notes = { prs: 0, commentReadsFailed: 0, compares: 0, comparesSkipped: 0 };
  if (typeof gh !== 'function') return { report: buildChangeRequests([]), notes: { ...notes, skipped: 'no gh' } };
  const cards = cardIndex(backlogDir, io), receipts = readReceipts(receiptsDir, io);
  const inputs = [];
  for (const pr of prs.slice(0, maxPrs)) {
    notes.prs++;
    // Every page (a long fix loop runs past 300 comments); the gh runner's maxBuffer bounds the read.
    const pages = gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr.number}/comments?per_page=100`]);
    const comments = Array.isArray(pages) ? pages.flat() : [];
    if (!Array.isArray(pages)) notes.commentReadsFailed++;
    let files = prFiles[pr.number];
    if (!files) { const data = gh(['api', `repos/${repo}/pulls/${pr.number}/files?per_page=100`]); files = Array.isArray(data) ? data : []; }
    files = files.map((f) => ({ filename: f.filename, additions: f.additions, deletions: f.deletions, patch: f.patch }));
    const commitsData = gh(['api', `repos/${repo}/pulls/${pr.number}/commits?per_page=100`]);
    const commits = Array.isArray(commitsData) ? commitsData.map((c) => ({ sha: c.sha, commit: { committer: { date: c.commit?.committer?.date } }, parents: (c.parents ?? []).map((p) => p.sha) })) : [];
    const baseSha = commits[0]?.parents?.[0];
    const baseDate = baseSha && typeof git === 'function' ? git(['show', '-s', '--format=%cI', baseSha]) : null;
    inputs.push({ pr, kind: prKinds[pr.number] ?? 'code', comments, commits, files, ciRuns: ciRuns.filter((r) => r.pr === pr.number || commits.some((c) => c.sha === r.headSha)) /* runs often carry no PR link */, card: cards.get(cardIdOf(pr.headRef)) ?? null, receipt: receipts.get(pr.number) ?? null, baseDate: baseDate && /^\d{4}-/.test(baseDate) ? baseDate.trim() : null, mergedAt: pr.mergedAt });
  }
  // Second pass: diffstat of what each round's next push changed.
  for (const x of inputs) {
    x.compares = {};
    for (const key of buildPrRounds(x).compareKeys) {
      if (notes.compares >= maxCompares) { notes.comparesSkipped++; continue; }
      notes.compares++;
      const data = gh(['api', `repos/${repo}/compare/${key}`]);
      if (!data || !Array.isArray(data.files)) continue;
      x.compares[key] = { files: data.files.map((f) => ({ filename: f.filename, patch: f.patch })), additions: data.files.reduce((a, f) => a + (f.additions ?? 0), 0), deletions: data.files.reduce((a, f) => a + (f.deletions ?? 0), 0) };
    }
  }
  return { report: buildChangeRequests(inputs), notes };
}
