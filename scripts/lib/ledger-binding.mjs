// @file Head-binding ledger fold (#5492 rebuild, design v2). PURE; only the slice-3 shadow calls it. May this PR land at live
// head X? Rows bind to their own full head (bar PR-level obligations); git append order; answers count only inside `seen`.
import { createHash } from 'node:crypto';

const SHA40 = /^[0-9a-f]{40}$/;
const SHORT = /^[0-9a-f]{7,39}$/;
const HOLD_LABELS = new Set(['review:human', 'review:changes', 'review:pending', 'advisory:ruling-needed']);
const CARRY_SOURCES = new Set(['merge-ai-prs']);
const RETIRED_CHANNEL = 'mandatory-referral-retired';
const APPROVAL_KINDS = new Set(['clear-human', 'clear-operator']); // `judge` answers nothing
const MAX_CARRY_DEPTH = 16;
const TYPES = new Set(['verdict', 'review-exempt', 'referral', 'ruling', 'review-run', 'hold', 'release', 'approval',
  'send-back', 'author', 'label-input', 'finding']);
const VERDICTS = new Set(['accepted', 'changes', 'pending', 'human', 'clear-human', 'restamped', 'carried', 'observed', 'head-moved']);
const HOLDING = new Set(['changes', 'pending', 'human']);
const NOT_BEARING = new Set(['observed', 'head-moved']); // old `head-moved` rows are ignored
const TRANSPORT = ['at', 'writer', 'unlocked', 'id'];

const str = v => typeof v === 'string' && v !== '';
const strs = v => Array.isArray(v) && v.every(str);
/** Fail-closed payload checks: a row whose bearing fields are missing or mistyped is malformed (a hold), never skipped. */
const PAYLOAD = {
  verdict: r => VERDICTS.has(r.verdict) && (r.coverage === undefined || (r.coverage && typeof r.coverage === 'object' && !Array.isArray(r.coverage))),
  'review-exempt': r => str(r.headSha),
  referral: r => str(r.headSha) && strs(r.findingKeys) && r.findingKeys.length > 0,
  ruling: r => str(r.findingKey) && ['block', 'card', 'not-real'].includes(r.ruling),
  'review-run': r => str(r.headSha) && ['started', 'completed'].includes(r.phase) && [undefined, null, true, false].includes(r.posted)
    && (r.raised === undefined || strs(r.raised)) && (r.scope === undefined || str(r.scope)),
  hold: r => str(r.holdSource) && str(r.reasonCode),
  release: r => str(r.holdSource) && str(r.reasonCode),
  approval: r => str(r.approval) && (r.delegation == null || (typeof r.delegation === 'object' && str(r.delegation.expires))),
  'send-back': r => str(r.cause),
  'label-input': r => str(r.label) && ['added', 'removed'].includes(r.change),
  author: () => true, finding: () => true,
};
const headField = v => v === undefined || v === null || typeof v === 'string';
const wellFormed = r => r && typeof r === 'object' && !Array.isArray(r) && TYPES.has(typeOf(r)) && PAYLOAD[typeOf(r)](r)
  && headField(r.headSha) && headField(r.judgedHead) && (r.coverage === undefined || headField(r.coverage.headSha))
  && (r.id === undefined || str(r.id)) && (r.runId === undefined || str(r.runId));
const canon = v => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
const json = v => JSON.stringify(canon(v));
const hash = v => `sha256:${createHash('sha256').update(json(v)).digest('hex')}`;
const typeOf = r => (r.type === undefined ? 'verdict' : r.type); // only an OMITTED type is a v1 verdict
/** The head a row names: the writer's pin `judgedHead` when present (slice 2), else a verdict's `coverage.headSha` or
 *  another type's `headSha`. Never trimmed or case-folded. */
const rawHead = r => (r.judgedHead !== undefined ? r.judgedHead : typeOf(r) === 'verdict' ? r.coverage?.headSha : r.headSha);
const full = v => typeof v === 'string' && SHA40.test(v);
/** A full head, `'short'` (7–39 hex: never a base or an answer), or null (headless or garbage). */
const headClass = r => { const h = rawHead(r); return full(h) ? h : typeof h === 'string' && SHORT.test(h) ? 'short' : null; };
/** Content minus transport metadata (and, for a review-run, `posted`): what a same-id retry must repeat exactly. */
const body = r => { const c = { ...r }; for (const k of TRANSPORT) delete c[k]; if (typeOf(r) === 'review-run') delete c.posted; return json(c); };
const nowMs = now => (typeof now === 'number' && Number.isFinite(now) ? now : typeof now === 'string' ? Date.parse(now) : NaN);
/** A row's identity: its explicit `id`, else the canonical content hash without `id`/`unlocked` (what `seen` keys name). */
export const rowIdentity = r => (str(r?.id) ? r.id : hash(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id' && k !== 'unlocked'))));

/** Raw rows → logical rows (raw position = index BEFORE collapse; same id+body = one row, else `id-conflict`). */
function analyze(raw, now) {
  const rows = [], faults = [], rawKeys = [], groups = new Map(), cache = new Map();
  raw.forEach((r, i) => {
    const pos = i + 1;
    if (!wellFormed(r)) {
      rawKeys.push(null);
      faults.push({ code: 'malformed-row', ref: `#${pos}`, pos, releasable: false });
      return;
    }
    const key = rowIdentity(r);
    rawKeys.push(key);
    const b = body(r), group = groups.get(key) ?? [];
    const same = group.find(L => L.body === b);
    if (same) { if (r.posted === true && same.postedAt === null) same.postedAt = pos; return; }
    if (group.length) faults.push({ code: 'id-conflict', ref: key, pos });
    const L = { r, pos, key, body: b, type: typeOf(r), head: headClass(r), postedAt: r.posted === true ? pos : null, bound: null };
    group.push(L); groups.set(key, group); rows.push(L);
  });
  // The judgment boundary: "n:key" names raw entry n, strictly before this row; "empty" = saw nothing; absent = legacy.
  for (const L of rows) {
    const s = L.r.seen, ks = L.r.seenKeys;
    // Slice 4: `seenKeys` = EXACTLY the question rows its judge was shown (each strictly earlier); never with `seen`.
    if (ks !== undefined) {
      const prior = new Set(rawKeys.slice(0, L.pos - 1));
      if (s === undefined && Array.isArray(ks) && ks.length <= 200 && ks.every(k => typeof k === 'string' && /^[A-Za-z0-9:._-]{8,128}$/.test(k) && prior.has(k))) L.seenKeys = new Set(ks);
      else faults.push({ code: 'bad-seen', ref: L.key, pos: L.pos });
      continue;
    }
    if (s === undefined) continue; // absent = legacy; any supplied value must be "empty" or a valid boundary
    if (s === 'empty') { L.bound = 0; continue; }
    const m = /^(\d+):(.+)$/.exec(typeof s === 'string' ? s : '');
    const n = m ? Number(m[1]) : NaN;
    if (m && Number.isSafeInteger(n) && n >= 1 && n < L.pos && rawKeys[n - 1] === m[2]) L.bound = n;
    else faults.push({ code: 'bad-seen', ref: L.key, pos: L.pos }); // and the row stays legacy: it answers nothing
  }
  // Run conflicts: same runId + conflict key, different judgment payload. `posted` is not judgment.
  const payloads = new Map();
  for (const L of rows) {
    const { runId } = L.r;
    if (typeof runId !== 'string' || !runId || !['verdict', 'review-run'].includes(L.type)) continue;
    const head = rawHead(L.r) ?? null, seen = [L.r.seen ?? null, L.r.seenKeys ?? null];
    const ck = L.type === 'verdict' ? [runId, 'verdict'] : [runId, 'review-run', L.r.phase ?? null];
    const p = json(L.type === 'verdict' ? { verdict: L.r.verdict, head, seen }
      : { head, scope: L.r.scope ?? null, raised: L.r.raised ?? null, seen });
    const k = JSON.stringify(ck), set = payloads.get(k) ?? new Set();
    if (set.size && !set.has(p)) faults.push({ code: 'run-conflict', ref: runId, pos: L.pos });
    set.add(p); payloads.set(k, set);
    L.judgment = k + p;
  }
  const lastRelease = new Map(rows.filter(x => x.type === 'release').map(x => [JSON.stringify([x.r.holdSource, x.r.reasonCode]), x.pos]));
  const released = (source, code, after) => (lastRelease.get(JSON.stringify([source, code])) ?? 0) > after; // indexed: linear, not quadratic
  const byPos = new Map(rows.map(L => [L.pos, L]));
  const ctx = {
    rows, byPos, now, released, memo: new Map(),
    // A release covers only the contributions already present at its position; a later distinct payload re-arms.
    faults: faults.filter(f => f.releasable === false || !released(f.code, f.ref, f.pos)),
    prefix: pos => cache.get(pos) ?? cache.set(pos, analyze(raw.slice(0, pos - 1), now)).get(pos),
  };
  // A completed run counts as posted from the first `posted:true` witness of the SAME judgment (never backdated).
  for (const L of rows) {
    if (L.type !== 'review-run') continue;
    const twins = L.judgment ? rows.filter(M => M.judgment === L.judgment) : [L];
    const at = twins.map(M => M.postedAt).filter(p => p !== null);
    L.postedFrom = at.length ? Math.min(...at) : null;
  }
  return ctx;
}

const isV = (L, v) => L.type === 'verdict' && L.r.verdict === v;
const sees = (A, Q) => (A.seenKeys ? !!Q && A.seenKeys.has(Q.key) && Q.pos < A.pos : A.bound !== null && !!Q && Q.pos <= A.bound);
function validApproval(ctx, L, H) {
  if (L.type !== 'approval' || L.head !== H || !APPROVAL_KINDS.has(L.r.approval)) return false;
  const d = L.r.delegation;
  return !d || Date.parse(d.expires) > ctx.now; // NaN on either side is not valid (default deny)
}

/** A direct answer at H to a per-head hold verdict Q: `accepted` → an accepted verdict, `human` → a valid approval. */
const answer = (ctx, H, Q, kind) => (kind === 'accepted'
  ? (ctx.rows.some(A => isV(A, 'accepted') && A.head === H && sees(A, Q)) ? { byApproval: false } : null)
  : (ctx.rows.some(A => validApproval(ctx, A, H) && sees(A, Q)) ? { byApproval: true } : null));

/** The clearance base at H: review, human, exempt, or carry (first that holds). */
function base(ctx, H, chain) {
  const mk = `${H}|${[...chain].sort().join(',')}`;
  if (ctx.memo.has(mk)) return ctx.memo.get(mk);
  ctx.memo.set(mk, null); // re-entry while computing is a cycle: no base
  const rs = ctx.rows;
  let b = null;
  if (rs.some(L => isV(L, 'accepted') && L.head === H)) b = { kind: 'review', human: false };
  else if (rs.some(L => isV(L, 'clear-human') && L.head === H) && rs.some(L => validApproval(ctx, L, H))) b = { kind: 'human', human: true };
  else if (rs.some(L => L.type === 'review-exempt' && L.head === H)
    && !rs.some(L => L.type === 'verdict' && !NOT_BEARING.has(L.r.verdict))) b = { kind: 'exempt', human: false };
  else {
    for (const C of rs) {
      if (C.head !== H) continue;
      if (isV(C, 'restamped')) { b = { kind: 'carry', human: false, legacy: true }; break; } // legacy: a base, never an answer
      if (isV(C, 'carried') && (b = carry(ctx, C, H, chain))) break;
    }
  }
  ctx.memo.set(mk, b);
  return b;
}

/** A `carried` row C at H: consistent proof, source cleared both before C and now, `carryHuman` when needed. */
function carry(ctx, C, H, chain) {
  const F = C.r.fromHead, p = C.r.proof;
  if (!full(F) || F === H || !CARRY_SOURCES.has(C.r.source)) return null;
  if (!p || typeof p !== 'object' || p.v !== 1 || p.rule !== 'tree-identical' || p.fromHead !== F
    || p.toHead !== H || !full(p.fromTree) || p.fromTree !== p.toTree) return null;
  const next = new Set(chain).add(H);
  if (next.has(F) || next.size > MAX_CARRY_DEPTH) return null;
  const lp = localClears(ctx.prefix(C.pos), F, next), lf = localClears(ctx, F, next);
  if (!lp || !lf || lp.exempt || lf.exempt) return null;
  const human = lp.human || lf.human;
  if (human && C.r.carryHuman !== true) return null;
  return { kind: 'carry', human, C, F, chain: next };
}

/** Per-head obligations at H: hold verdicts at H (answered by a review/approval that saw them) and send-backs of H (targeted release only). */
function perHead(ctx, H) {
  const out = [];
  for (const Q of ctx.rows) {
    if (Q.head !== H) continue;
    if (Q.type === 'verdict' && HOLDING.has(Q.r.verdict)) {
      out.push({ code: `verdict:${Q.r.verdict}`, pos: Q.pos, ans: answer(ctx, H, Q, Q.r.verdict === 'human' ? 'human' : 'accepted') });
    } else if (Q.type === 'send-back') {
      out.push({ code: 'send-back', pos: Q.pos, ans: ctx.released('send-back', Q.key, Q.pos) ? { byApproval: false } : null });
    }
  }
  return out;
}

/** F clears on its own: a base, every per-head obligation answered, no structural fault. PR-level ones are judged at X. */
function localClears(ctx, F, chain) {
  const b = base(ctx, F, chain);
  if (!b || ctx.faults.length) return null;
  const obs = perHead(ctx, F); if (obs.some(o => !o.ans)) return null;
  return { human: b.human || obs.some(o => o.ans.byApproval), exempt: b.kind === 'exempt' };
}

/** PR-level obligations answerable by a head-bound answer (operational holds are separate: release only). */
function prLevel(ctx) {
  const out = [];
  for (const Q of ctx.rows) {
    const headless = Q.head === null || Q.head === 'short';
    if (Q.type === 'label-input' && Q.r.change === 'added' && HOLD_LABELS.has(Q.r.label)) {
      const human = Q.r.label === 'review:human';
      out.push({ code: `label-input:${Q.r.label}`, pos: Q.pos, kind: human ? 'human' : 'review', humanKind: human });
    } else if (headless && Q.type === 'verdict' && HOLDING.has(Q.r.verdict)) {
      const human = Q.r.verdict === 'human';
      out.push({ code: `headless-verdict:${Q.r.verdict}`, pos: Q.pos, kind: human ? 'human' : 'review', humanKind: human });
    } else if (headless && Q.type === 'send-back') {
      out.push({ code: 'headless-send-back', pos: Q.pos, kind: 'accepted', humanKind: false, sendBack: true });
    }
  }
  return out;
}

/** Referral occurrences (row, key) still open at key level (latest explicit ruling; retirement only for unruled keys). */
function occurrences(ctx) {
  const out = [];
  for (const R of ctx.rows) {
    const keys = R.type === 'referral' ? R.r.findingKeys
      : R.type === 'review-run' && R.r.phase === 'completed' ? R.r.raised : null;
    for (const K of Array.isArray(keys) ? keys : []) {
      const rulings = ctx.rows.filter(x => x.type === 'ruling' && x.r.findingKey === K);
      const retired = x => x.r.source === 'review-pr' && x.r.actor?.channel === RETIRED_CHANNEL;
      const explicit = rulings.filter(x => !retired(x)), last = explicit.at(-1);
      if (last && (last.r.ruling === 'not-real' || last.r.ruling === 'card')) continue;
      if (!explicit.length && rulings.some(x => retired(x) && sees(x, R))) continue;
      out.push({ code: 'referral', pos: R.pos, K, block: last?.r.ruling === 'block' ? last.pos : null, humanKind: false });
    }
  }
  return out;
}

/** Every direct answer path for an obligation at H, appended (and, for a run, published) before `lim`. */
function directPaths(ctx, H, ob, lim) {
  const Q = ctx.byPos.get(ob.pos);
  if (!Q || Q.pos >= lim) return [];
  const ok = A => A.head === H && A.pos < lim && sees(A, Q), mk = (A, ap) => ({ sig: `${A.pos}`, byApproval: ap, human: ap });
  if (ob.code === 'referral') {
    return ctx.rows.filter(run => run.type === 'review-run' && run.r.phase === 'completed' && run.r.scope === 'full' && ok(run)
      && run.postedFrom !== null && run.postedFrom < lim && Array.isArray(run.r.raised) && !run.r.raised.includes(ob.K)
      && (ob.block === null || sees(run, ctx.byPos.get(ob.block)))).map(run => mk(run, false));
  }
  const out = ob.sendBack && ctx.released('send-back', Q.key, Q.pos) ? [{ sig: 'release', byApproval: false, human: false }] : [];
  if (ob.kind !== 'human') out.push(...ctx.rows.filter(A => isV(A, 'accepted') && ok(A)).map(A => mk(A, false)));
  if (ob.kind !== 'accepted') out.push(...ctx.rows.filter(A => validApproval(ctx, A, H) && ok(A)).map(A => mk(A, true)));
  return out;
}

/** Every answer path at H: direct, or via ANY valid carry C at H from F. A carried path must exist IDENTICALLY (same
 *  answers, same nested carries) in the prefix before C and in this fold limited to rows before C: nothing is spliced.
 *  An approval or a human-kind Q needs `carryHuman` at every link; a human-dependent carry makes the path human. */
function paths(ctx, H, ob, chain, lim = Infinity) {
  const mk = `${H}|${ob.pos}|${ob.K ?? ''}|${[...chain].sort().join(',')}|${lim}`;
  if (ctx.memo.has(mk)) return ctx.memo.get(mk);
  const out = directPaths(ctx, H, ob, lim);
  ctx.memo.set(mk, out);
  for (const C of ctx.rows) {
    if (!isV(C, 'carried') || C.head !== H || C.pos >= lim) continue;
    const c = carry(ctx, C, H, chain);
    if (!c) continue;
    const now = new Map(paths(ctx, c.F, ob, c.chain, C.pos).map(p => [p.sig, p]));
    for (const p of paths(ctx.prefix(C.pos), c.F, ob, c.chain)) {
      const q = now.get(p.sig);
      if (!q) continue;
      const byApproval = p.byApproval || q.byApproval;
      if ((ob.humanKind || byApproval) && C.r.carryHuman !== true) continue;
      out.push({ sig: `${C.pos}>${p.sig}`, byApproval, human: byApproval || p.human || q.human || c.human });
    }
  }
  return out;
}
const discharge = (ctx, H, ob, chain) => { const ps = paths(ctx, H, ob, chain); return ps.find(p => !p.human) ?? ps[0] ?? null; };

// `key` (slice 4): the identity of the question row behind a hold, so a reviewer can be shown it and answer exactly it.
const hold = (code, reason, key) => (key === undefined ? { code, reason } : { code, reason, key });

/** `ledgerAt(rows in git append order, liveHead 40 lowercase hex, { now })` → { clears, holds, base, humanDependent }.
 *  `now` is the delegation clock; a missing or invalid one makes every delegated approval invalid. */
export function ledgerAt(rows, liveHead, opts) {
  const held = (code, reason) => ({ clears: false, holds: [hold(code, reason)], base: null, humanDependent: false });
  if (typeof liveHead !== 'string' || !SHA40.test(liveHead)) return held('head-unknown', 'the live head is not 40 lowercase hex');
  if (!Array.isArray(rows)) return held('ledger-unreadable', 'rows is not an array');
  try {
    const X = liveHead, ctx = analyze(rows, nowMs(opts?.now)), root = new Set();
    const holds = ctx.faults.map(f => hold(f.code, `structural fault ${f.code} at row ${f.pos} (${String(f.ref).slice(0, 24)})`));
    const b = base(ctx, X, root);
    if (!b) holds.push(hold('no-clearance', 'no review, human ceremony, exemption or valid carry at this head'));
    let human = !!b?.human;
    for (const o of perHead(ctx, X)) {
      if (!o.ans) holds.push(hold(o.code, `unanswered ${o.code} at row ${o.pos}`, ctx.byPos.get(o.pos)?.key));
      else human ||= o.ans.byApproval;
    }
    for (const Q of ctx.rows) {
      if (Q.type === 'hold' && !ctx.released(Q.r.holdSource, Q.r.reasonCode, Q.pos)) {
        holds.push(hold(`hold:${Q.r.holdSource}:${Q.r.reasonCode}`, `operational hold at row ${Q.pos}`, Q.key));
      }
    }
    for (const ob of [...prLevel(ctx), ...occurrences(ctx)]) {
      const d = discharge(ctx, X, ob, root);
      if (!d) holds.push(hold(ob.code, `unanswered ${ob.code}${ob.K ? ` ${String(ob.K).slice(0, 16)}` : ''} at row ${ob.pos}`, ctx.byPos.get(ob.pos)?.key));
      else human ||= d.human;
    }
    return { clears: holds.length === 0, holds, base: b?.kind ?? null, humanDependent: human };
  } catch (e) {
    return held('fold-crashed', `the fold crashed (${String(e?.message ?? e).slice(0, 120)}); a crash is a hold`);
  }
}
