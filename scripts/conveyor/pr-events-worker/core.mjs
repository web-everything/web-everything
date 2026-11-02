/**
 * @file scripts/conveyor/pr-events-worker/core.mjs
 * @description The PURE core of the PR-events webhook receiver (slice 1 of "webhooks, not polling, as the
 * primary PR trigger"). Everything here is plain JS over Web-standard APIs (WebCrypto, Request/Response), so it
 * runs unchanged in the Cloudflare Worker (`worker.mjs`) and in Node's vitest (`__tests__/`).
 *
 * WHAT IT DOES
 *   • POST /github/webhook — verifies GitHub's `X-Hub-Signature-256` HMAC over the RAW body with the
 *     `GITHUB_WEBHOOK_SECRET` binding, keeps only the PR-lifecycle events the daemons care about, turns each into
 *     a compact record (numbers, SHAs, label names — never titles, bodies or user text) and appends it to the
 *     event log. A GitHub redelivery (same `X-GitHub-Delivery` id) is stored once.
 *   • GET /events?cursor=N — bearer-authed with the SEPARATE `PR_EVENTS_READ_TOKEN` binding (the webhook secret
 *     never leaves GitHub↔Worker). Returns every event with `seq > cursor`, oldest first, plus the new cursor.
 *   • GET /health — `{ ok }` only; no data, no auth.
 *
 * CURSOR SEMANTICS (the contract `we:scripts/lib/pr-events.mjs` relies on)
 *   • `seq` is a strictly increasing integer, assigned by the single-writer log, never reused (pruning never
 *     lowers `head`).
 *   • `cursor` absent → `{ cursor: head, events: [], reset: true }`: a fresh reader starts at "now" (its own
 *     first full tick covers history — nothing is replayed).
 *   • `cursor > head` → the log was recreated under the reader; same answer as absent (`reset: true`).
 *   • `cursor < oldest - 1` → events the reader never saw were pruned: `gap: true` and the reader must treat
 *     that as "something happened" (run a full tick). Retention is bounded by count AND age.
 *   • `more: true` → a page limit cut the answer short; the reader asks again from the returned cursor.
 *
 * Fail-closed: a missing secret/token binding answers 503, never "accept unsigned" / "serve unauthenticated".
 */

export const ACCEPTED_EVENTS = Object.freeze({
  pull_request: new Set(['opened', 'synchronize', 'ready_for_review', 'converted_to_draft', 'closed', 'labeled', 'unlabeled', 'reopened']),
  check_suite: new Set(['completed']),
  check_run: new Set(['completed']),
  pull_request_review: new Set(['submitted', 'dismissed']),
  // Kept ONLY when the comment is on a PR and is an advisory note or an operator ruling (see classifyPrComment);
  // stored as a `kind` tag — never the body. Live 2026-10-09 (PR #4624): these are what make a fix owed, and the
  // fix daemon could not wake on them.
  issue_comment: new Set(['created']),
});

/** The advisory-note shape `review-pr.mjs#renderAdvisoryNote` emits (`advisory-labels.mjs#parseAdvisories` reads the
 *  same two lines) and the operator-ruling marker (`jury-core.mjs#OPERATOR_RULING_MARKER`). Inlined: the Worker
 *  bundle must not import repo code. */
export const OPERATOR_RULING_COMMENT_MARKER = 'mandatory-referral-operator-ruling-v1';

/** PURE: `'advisory'`, `'ruling'`, or `null` for a PR comment body. */
export function classifyPrComment(body) {
  const b = typeof body === 'string' ? body : '';
  if (b.includes(OPERATOR_RULING_COMMENT_MARKER)) return 'ruling';
  if (/^\*\*Verdict:\*\*/m.test(b) && /^Net basis: `[a-f0-9]+\.\.[a-f0-9]+`/im.test(b)) return 'advisory';
  return null;
}

export const DEFAULT_MAX_EVENTS = 5000;
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PR_RETENTION_MS = DEFAULT_RETENTION_MS;
export const DEFAULT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const PROJECTION_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_PAGE_LIMIT = 200;
export const MAX_PAGE_LIMIT = 500;
export const PRS_RESPONSE_BUDGET_BYTES = 20 * 1024 * 1024;
const PRS_ENVELOPE_OVERFLOW = 'PR snapshot envelope exceeds response budget';

const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare (length leak only). */
export function timingSafeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** `sha256=<hex>` HMAC of `body` (string or bytes) under `secret`. */
export async function signBody(secret, body) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = typeof body === 'string' ? enc.encode(body) : body;
  return `sha256=${toHex(await crypto.subtle.sign('HMAC', key, bytes))}`;
}

/** True only for a well-formed `sha256=` header matching the HMAC of the exact raw body. */
export async function verifySignature(secret, body, header) {
  if (!secret || typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  return timingSafeEqual((await signBody(secret, body)).toLowerCase(), header.toLowerCase());
}

const prNumbers = (list) => (Array.isArray(list) ? list.map((p) => p?.number).filter(Number.isInteger) : []);

/**
 * Turn one GitHub delivery into the compact stored record, or `null` when the event/action is not one we keep.
 * Only identifiers and states — no titles, bodies, comments or logins.
 */
export function parseGithubEvent(eventName, payload, { deliveryId = null, receivedAt = Date.now() } = {}) {
  const actions = ACCEPTED_EVENTS[eventName];
  if (!actions || !payload || typeof payload !== 'object') return null;
  const action = String(payload.action || '');
  if (!actions.has(action)) return null;
  const repo = payload.repository?.full_name;
  if (typeof repo !== 'string' || !repo) return null;
  const base = { id: deliveryId, at: new Date(receivedAt).toISOString(), type: eventName, action, repo };

  if (eventName === 'pull_request') {
    const pr = payload.pull_request || {};
    const rec = { ...base, prs: Number.isInteger(payload.number) ? [payload.number] : prNumbers([pr]), sha: pr.head?.sha || null };
    if (action === 'labeled' || action === 'unlabeled') rec.label = payload.label?.name || null;
    if (action === 'closed') rec.merged = pr.merged === true;
    if (typeof pr.draft === 'boolean') rec.draft = pr.draft;
    if (Array.isArray(pr.labels)) rec.labels = pr.labels.map((l) => l.name).filter((n) => typeof n === 'string');
    if (['open', 'closed'].includes(pr.state)) rec.state = pr.state;
    return rec;
  }
  if (eventName === 'check_suite') {
    const s = payload.check_suite || {};
    return { ...base, prs: prNumbers(s.pull_requests), sha: s.head_sha || null, conclusion: s.conclusion || null, app: s.app?.slug || null };
  }
  if (eventName === 'check_run') {
    const r = payload.check_run || {};
    return { ...base, prs: prNumbers(r.pull_requests), sha: r.head_sha || null, conclusion: r.conclusion || null, name: r.name || null, app: r.app?.slug || null };
  }
  if (eventName === 'issue_comment') {
    const issue = payload.issue || {};
    if (!issue.pull_request || !Number.isInteger(issue.number)) return null;
    const kind = classifyPrComment(payload.comment?.body);
    return kind ? { ...base, prs: [issue.number], sha: null, kind } : null;
  }
  // pull_request_review
  const rv = payload.review || {};
  return { ...base, prs: prNumbers([payload.pull_request]), sha: rv.commit_id || null, state: rv.state ? String(rv.state).toLowerCase() : null };
}

/**
 * The `checks` projection key of one (repo-lowercased) check_run/check_suite observation. Exported so a reader-side
 * mirror of this projection (`we:scripts/lib/pr-facts.mjs`) keys its seeded rows exactly as later folds will.
 */
export function checkProjectionKey(event) {
  const { repo, sha, type } = event;
  return JSON.stringify([repo, sha, type, type === 'check_run' ? [event.name, event.app ?? null] : event.app,
    sha ? null : [...(event.prs || [])].sort((a, b) => a - b)]);
}

const isPrEvent = (e) => e.type === 'pull_request' || e.type === 'bootstrap';
const fieldDelivered = (e, row, field) => isPrEvent(e) && row.fields[field] === e.seq;
const checkKind = (field, type) => ({
  present: (row) => Array.isArray(row[field]) && row[field].length > 0,
  ids: (row) => row[field].map(checkProjectionKey),
  rehydrates: (e, _row, loss) => e.type === type && checkProjectionKey(e) === loss.id,
});

/** All evidence carried by a PR projection. Null/default placeholders are not received evidence.
 * Rehydration describes actual replacement, including bootstrap field-clock acceptance.
 */
export const EVIDENCE_KINDS = Object.freeze({
  checks: checkKind('checks', 'check_run'),
  suites: checkKind('suites', 'check_suite'),
  review: { present: (r) => r.review != null, rehydrates: (e) => e.type === 'pull_request_review' },
  labels: { present: (r) => Array.isArray(r.labels),
    rehydrates: (e, r) => Array.isArray(e.labels) && fieldDelivered(e, r, 'labels') },
  labelChanges: { present: (r) => Object.keys(r.labelChanges || {}).length > 0,
    ids: (r) => Object.keys(r.labelChanges),
    rehydrates: (e, r, loss) => isPrEvent(e) && ((Array.isArray(e.labels) && fieldDelivered(e, r, 'labels')) ||
      (e.label === loss.id && !e.labels && r.fields.labels === e.seq)) },
  draft: { present: (r) => typeof r.draft === 'boolean',
    rehydrates: (e, r) => fieldDelivered(e, r, 'draft') },
});
export const NON_EVIDENCE_FIELDS = Object.freeze([
  'repo', 'number', 'sha', 'state', 'merged', 'seq', 'fields', 'updatedAt', 'evidenceLost',
]);

const mergeLoss = (...lists) => [...new Map(lists.flat().map((loss) => [JSON.stringify(loss), loss])).values()];

/** The single coverage predicate for Worker and mirrors; malformed persisted markers fail closed too. */
export function evidenceCovered(row) {
  return row != null && (row.evidenceLost === undefined ||
    (Array.isArray(row.evidenceLost) && row.evidenceLost.length === 0));
}

/** Preserve existing losses as well as every kind of evidence about to be deleted. */
export function markPrunedEvidence(row) {
  const lost = [...(row.evidenceLost || [])];
  for (const [kind, rule] of Object.entries(EVIDENCE_KINDS)) {
    if (!rule.present(row)) continue;
    if (rule.ids) for (const id of rule.ids(row)) lost.push({ kind, id });
    else lost.push({ kind });
  }
  return mergeLoss(lost);
}

/** Resolve retained markers on reads too, including open rows persisted by older Worker versions. */
const evidenceLossIndex = (storage) => new Map(storage.listProjection('evidenceLoss', true).map(({ key, value }) => [key, value]));

function withEvidenceLoss(markers, row) {
  const losses = [
    markers.get(JSON.stringify([row.repo, row.number]))?.evidenceLost || [],
    row.sha ? markers.get(JSON.stringify([row.repo, row.sha]))?.evidenceLost || [] : [],
  ];
  if (losses.some((list) => list.length)) return { ...row, evidenceLost: mergeLoss(row.evidenceLost || [], ...losses) };
  return row;
}

/** Fold only received evidence. Field clocks protect concurrent bootstrap imports. */
export function foldObservation(storage, observed, now = Date.parse(observed.at)) {
  storage = storedView(storage);
  if (observed.evidenceLostByPr !== undefined && !dictionary(losses)(observed.evidenceLostByPr)) malformedStored();
  // GitHub spells a repo one way, an operator may type another: the projection identifies a repo case-insensitively.
  const event = { ...observed, repo: String(observed.repo).toLowerCase() };
  const { repo, seq, sha, type } = event;
  // Raw cursor-log records may lack a projectable repository identity.
  if (!isRepo(repo)) return {};
  const evidenceLostByPr = {};
  const key = (...parts) => JSON.stringify(parts);
  const put = (bucket, k, value) => storage.putProjection(bucket, k, value);
  const get = (bucket, k) => storage.getProjection(bucket, k);
  if (type === 'check_run' || type === 'check_suite') {
    // Preserve explicit attachment evidence across later empty-array deliveries.
    // A null SHA is not a join key: unrelated unknown-head observations stay separate.
    // A check run is identified by name AND app: two apps may report the same name for the same SHA.
    const checkKey = checkProjectionKey(event);
    const previous = get('checks', checkKey);
    // Redelivery repairs this exact check identity everywhere, including unopened tombstones.
    for (const bucket of ['evidenceLoss', 'tombstones']) {
      for (const { key: markerKey, value: marker } of storage.listProjection(bucket, true)) {
        if (marker.repo !== repo || !Array.isArray(marker.evidenceLost)) continue;
        const evidenceLost = marker.evidenceLost.filter((loss) =>
          !EVIDENCE_KINDS[loss.kind]?.rehydrates(event, {}, loss));
        if (bucket === 'evidenceLoss' && !evidenceLost.length) storage.deleteProjection(bucket, markerKey);
        else put(bucket, markerKey, { ...marker, evidenceLost });
      }
    }
    put('checks', checkKey, { ...event, prs: [...new Set([...(previous?.prs || []), ...(event.prs || [])])] });
  }
  const associated = sha ? get('shas', key(repo, sha)) || [] : [];
  const numbers = [...new Set([...(event.prs || []), ...((type === 'check_run' || type === 'check_suite') ? associated : [])])];
  for (const number of numbers) {
    const rowKey = key(repo, number);
    const tombstone = get('tombstones', rowKey);
    // Pruning must not erase the close clock that rejects a delayed listing, even across restarts.
    if (type === 'bootstrap' && tombstone && event.baseCursor < tombstone.closedSeq) continue;
    const row = get('prs', rowKey) || { repo, number, sha: null, draft: null, labels: null,
      state: tombstone ? 'closed' : null, merged: tombstone?.merged ?? null, review: null, checks: [], suites: [],
      seq: tombstone?.closedSeq ?? 0, fields: tombstone ? { state: tombstone.closedSeq, merged: tombstone.closedSeq } : {}, labelChanges: {} };
    // PR markers outlive close-clock tombstones; SHA markers also fence later PR associations.
    const inherited = mergeLoss(
      tombstone?.evidenceLost || [], get('evidenceLoss', rowKey)?.evidenceLost || [],
      sha ? get('evidenceLoss', key(repo, sha))?.evidenceLost || [] : [],
      observed.evidenceLostByPr?.[number] || []);
    if (inherited.length) {
      row.evidenceLost = mergeLoss(row.evidenceLost || [], inherited);
      // The append serializes this annotation after folding, so /events mirrors see the same loss.
      evidenceLostByPr[number] = row.evidenceLost;
    }
    const assign = (field, value) => {
      if (value !== undefined && (type !== 'bootstrap' || (row.fields[field] || 0) <= event.baseCursor)) {
        row[field] = value; row.fields[field] = seq;
      }
    };
    if (type === 'pull_request' || type === 'bootstrap') {
      if (sha) {
        assign('sha', sha);
        put('shas', key(repo, sha), [...new Set([...(get('shas', key(repo, sha)) || []), number])]);
      }
      assign('draft', event.draft);
      // Legacy events stored `draft` only when true, so these transitions carry no field: the action itself is the evidence.
      if (event.draft === undefined && event.action === 'ready_for_review') assign('draft', false);
      if (event.draft === undefined && event.action === 'converted_to_draft') assign('draft', true);
      assign('labels', event.labels);
      if (event.labels !== undefined && row.fields.labels === seq) row.labelChanges = {};
      if (event.label && !event.labels) {
        row.labelChanges = { ...row.labelChanges, [event.label]: event.action === 'labeled' };
        if (row.labels !== null) assign('labels', event.action === 'labeled'
          ? [...new Set([...row.labels, event.label])] : row.labels.filter((l) => l !== event.label));
        else row.fields.labels = seq;
      }
      if (event.action === 'closed') {
        assign('state', 'closed'); assign('merged', event.merged ?? null);
      } else if (['opened', 'reopened'].includes(event.action) || type === 'bootstrap') {
        assign('state', 'open'); assign('merged', false);
      } else assign('state', event.state);
    }
    if (type === 'pull_request_review') row.review = { sha, state: event.state, action: event.action, seq };
    if (Array.isArray(row.evidenceLost)) {
      row.evidenceLost = row.evidenceLost.filter((loss) => !EVIDENCE_KINDS[loss.kind]?.rehydrates(event, row, loss));
      if (get('evidenceLoss', rowKey)) {
        if (evidenceCovered(row)) storage.deleteProjection('evidenceLoss', rowKey);
        else put('evidenceLoss', rowKey, { repo, number, evidenceLost: row.evidenceLost });
      }
      if (tombstone) put('tombstones', rowKey, { ...tombstone, evidenceLost: row.evidenceLost });
    }
    row.seq = Math.max(row.seq, seq);
    if (Number.isFinite(now)) row.updatedAt = now;
    if (tombstone && row.state === 'open') storage.deleteProjection('tombstones', rowKey);
    put('prs', rowKey, row);
  }
  return evidenceLostByPr;
}

/** Remove expired closed rows and their exclusive evidence; shared SHA/check attachments survive. */
function pruneProjection(storage, now, retentionMs, tombstoneRetentionMs) {
  storage = storedView(storage);
  const last = numOrNull(storage.getMeta('lastProjectionPruneAt'));
  if (last != null && now >= last && now - last < PROJECTION_PRUNE_INTERVAL_MS) return;
  storage.setMeta('lastProjectionPruneAt', String(now));
  let horizon = storage.getMeta('tombstoneHorizonSeq') == null ? 0 : toSeq(storage.getMeta('tombstoneHorizonSeq'));
  if (horizon == null) malformedStored();
  const remember = (seq) => { if (Number.isSafeInteger(seq) && seq >= 0) horizon = Math.max(horizon, seq); };
  for (const { key, value: t } of storage.listProjection('tombstones', true)) {
    remember(t?.closedSeq);
    if (!Number.isFinite(t?.prunedAt) || t.prunedAt < now - tombstoneRetentionMs) storage.deleteProjection('tombstones', key);
  }
  const expired = new Map(), deadShas = new Set();
  for (const { key, value: row } of storage.listProjection('prs', true)) {
    if (row.state !== 'closed' || (Number.isFinite(row.updatedAt) && row.updatedAt >= now - retentionMs)) continue;
    if (!expired.has(row.repo)) expired.set(row.repo, new Set());
    expired.get(row.repo).add(row.number);
    if (row.sha) deadShas.add(JSON.stringify([row.repo, row.sha]));
    const evidenceLost = markPrunedEvidence(row);
    if (evidenceLost.length) storage.putProjection('evidenceLoss', key, { repo: row.repo, number: row.number, evidenceLost });
    storage.putProjection('tombstones', key, { repo: row.repo, number: row.number, state: 'closed', merged: row.merged ?? null,
      closedSeq: row.fields?.state ?? row.seq ?? 0, prunedAt: now, ...(evidenceLost.length ? { evidenceLost } : {}) });
    remember(row.fields?.state ?? row.seq ?? 0);
    storage.deleteProjection('prs', key);
  }
  // This small permanent fence survives expiry of every individual tombstone.
  storage.setMeta('tombstoneHorizonSeq', String(horizon));
  if (!expired.size) return;
  for (const { key, value: numbers } of storage.listProjection('shas', true)) {
    let repo;
    try { [repo] = JSON.parse(key); } catch { continue; }
    if (!expired.has(repo) || !Array.isArray(numbers)) continue;
    const kept = numbers.filter((n) => !expired.get(repo).has(n));
    if (kept.length === numbers.length) continue;
    if (kept.length) storage.putProjection('shas', key, kept);
    else { storage.deleteProjection('shas', key); deadShas.add(key); }
  }
  for (const { key, value: c } of storage.listProjection('checks', true)) {
    if (!isObject(c) || !expired.has(c.repo)) continue;
    const prs = Array.isArray(c.prs) ? c.prs : [];
    const kept = prs.filter((n) => !expired.get(c.repo).has(n));
    const shaKey = JSON.stringify([c.repo, c.sha]);
    if (kept.length === prs.length && !deadShas.has(shaKey)) continue;
    const associated = c.sha && storage.getProjection('shas', shaKey);
    if (!kept.length && !(Array.isArray(associated) && associated.length)) {
      // Deleting evidence must stay visible: a PR reopened on this SHA is not covered until the check is re-delivered.
      const evidenceLost = markPrunedEvidence({ [c.type === 'check_run' ? 'checks' : 'suites']: [c] });
      const mark = (markerKey, identity) => {
        const previous = storage.getProjection('evidenceLoss', markerKey);
        storage.putProjection('evidenceLoss', markerKey, { ...identity,
          evidenceLost: mergeLoss(previous?.evidenceLost || [], evidenceLost) });
        const tombstone = storage.getProjection('tombstones', markerKey);
        if (tombstone) storage.putProjection('tombstones', markerKey, { ...tombstone,
          evidenceLost: mergeLoss(tombstone.evidenceLost || [], evidenceLost) });
      };
      if (c.sha) mark(shaKey, { repo: c.repo, sha: c.sha });
      for (const number of prs) mark(JSON.stringify([c.repo, number]), { repo: c.repo, number });
      storage.deleteProjection('checks', key);
    }
    else storage.putProjection('checks', key, { ...c, prs: kept });
  }
}

/** Stored schemas: one trust boundary shared by the Worker and its disk mirrors.
 * Legacy projections omit fields that were never observed; present fields must always match their schema.
 * Sequence clocks alone also accept the historical digit-string representation.
 */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRepo = (v) => typeof v === 'string' && /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(v);
const toSeq = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : typeof v === 'string' && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null);
const sequence = (v) => toSeq(v) !== null;
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const time = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const string = (v) => typeof v === 'string';
const nonempty = (v) => string(v) && v.length > 0;
const boolean = (v) => typeof v === 'boolean';
const nullable = (rule) => (v) => v === null || rule(v);
const array = (rule) => (v) => Array.isArray(v) && v.every(rule);
const dictionary = (rule) => (v) => isObject(v) && Object.values(v).every(rule);
const shape = (required, fields) => (v) => isObject(v) && required.every((k) => Object.hasOwn(v, k)) &&
  Object.entries(fields).every(([k, rule]) => !Object.hasOwn(v, k) || rule(v[k]));
const loss = shape(['kind'], { kind: (v) => Object.hasOwn(EVIDENCE_KINDS, v), id: string });
const losses = array((v) => loss(v) && Object.keys(v).every((k) => ['kind', 'id'].includes(k)));
const reviewShape = shape(['sha', 'state', 'action', 'seq'], {
  sha: nullable(nonempty), state: nullable(nonempty), action: nonempty, seq: sequence,
});
const checkShape = shape(['repo', 'prs', 'type'], {
  repo: isRepo, prs: array(positive), type: (v) => ['check_run', 'check_suite'].includes(v),
  sha: nullable(nonempty), seq: sequence, name: nullable(string), app: nullable(string), conclusion: nullable(string),
  id: nullable(string), action: nonempty, at: (v) => string(v) && Number.isFinite(Date.parse(v)),
});
const bootShape = shape(['repo', 'status', 'baseCursor'], {
  repo: isRepo, status: (v) => ['complete', 'truncated', 'failed'].includes(v), baseCursor: sequence,
  cursor: sequence, importId: (v) => string(v) && /^[\w.-]{1,128}$/.test(v), at: time,
});
const prFields = {
  repo: isRepo, number: (v) => Number.isSafeInteger(v) && v >= 0, sha: nullable(nonempty),
  draft: nullable(boolean), labels: nullable(array(string)), labelChanges: dictionary(boolean),
  state: nullable((v) => ['open', 'closed'].includes(v)), merged: nullable(boolean), review: nullable(reviewShape),
  checks: array((v) => checkShape(v) && v.type === 'check_run'),
  suites: array((v) => checkShape(v) && v.type === 'check_suite'), seq: sequence,
  fields: dictionary(sequence), updatedAt: time, evidenceLost: losses,
};
const storedSchemas = {
  prs: shape(['repo', 'number'], prFields),
  servedPr: shape(['repo', 'number'], prFields),
  evidenceLost: losses,
  evidenceLoss: (v) => shape(['repo', 'evidenceLost'], { repo: isRepo, number: positive, sha: nonempty, evidenceLost: losses })(v) &&
    (Object.hasOwn(v, 'number') !== Object.hasOwn(v, 'sha')),
  tombstones: shape(['repo', 'number', 'closedSeq', 'prunedAt'], {
    repo: isRepo, number: positive, closedSeq: sequence, prunedAt: time,
    state: (v) => v === 'closed', merged: nullable(boolean), evidenceLost: losses,
  }),
  shas: array(positive), checks: checkShape,
  repoEvents: shape(['repo', 'lastEventAt'], { repo: isRepo, lastEventAt: time }),
  repoImports: shape(['repo', 'listed', 'others'], { repo: isRepo, listed: array(positive), others: array(sequence) }),
  bootstrap: bootShape,
  imports: shape(['input', 'result'], {
    input: (v) => { if (!string(v)) return false; try { validateBootstrap(JSON.parse(v)); return true; } catch { return false; } },
    result: bootShape,
  }),
  sequence,
  coverage: shape(['partial', 'observedSince', 'retainedReplayBoundary', 'historyComplete'], {
    partial: boolean, observedSince: sequence, retainedReplayBoundary: nullable(sequence), historyComplete: boolean,
  }),
  prunedEvidence: shape(['repo', 'sha'], { repo: isRepo, sha: nonempty }),
};
export function validateStored(kind, value) {
  try { return Object.hasOwn(storedSchemas, kind) && storedSchemas[kind](value); } catch { return false; }
}
const comparePrKey = (a, b) => a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.number - b.number;

// Cache a single validation pass. Attribution follows the value for rows and the key for SHA maps.
// Every invalid shape reaches projectPrRows' existing callback exactly once.
const STORED_VIEW = Symbol('validated stored projections');
const malformedStored = () => { throw new Error('malformed stored projection'); };
function storedView(storage, malformed = malformedStored) {
  if (storage[STORED_VIEW]) return storage;
  const cache = new Map();
  return { ...storage, [STORED_VIEW]: true,
    getProjection(bucket, key) {
      const value = storage.getProjection(bucket, key);
      if (value == null && !storage.listProjection(bucket, true).some((entry) => entry.key === key)) return null;
      if (validateStored(bucket, value)) return value;
      malformed(value);
      return null;
    },
    putProjection(bucket, key, value) { cache.delete(bucket); return storage.putProjection(bucket, key, value); },
    deleteProjection(bucket, key) { cache.delete(bucket); return storage.deleteProjection(bucket, key); },
    listProjection(bucket, withKeys = false) {
      if (!cache.has(bucket)) cache.set(bucket, storage.listProjection(bucket, true).filter(({ key, value }) => {
        let identity;
        if (bucket === 'shas') {
          try { identity = JSON.parse(key); } catch { /* Invalid identity below. */ }
        }
        const validKey = bucket !== 'shas' || (Array.isArray(identity) && identity.length === 2 && isRepo(identity[0]) && nonempty(identity[1]));
        if (validKey && validateStored(bucket, value)) return true;
        malformed(bucket === 'shas' ? { repo: identity?.[0] } : value);
        return false;
      }));
      return cache.get(bucket).map((entry) => withKeys ? entry : entry.value);
  } };
}

export function projectPrRows(storage, malformed = () => { throw new Error('malformed PR projection'); }) {
  storage = storedView(storage, malformed);
  // Validate even unattached evidence and historical metadata before any projection is trusted.
  for (const bucket of ['evidenceLoss', 'tombstones', 'shas', 'checks', 'prs', 'repoEvents', 'repoImports', 'bootstrap', 'imports', 'prunedEvidence'])
    storage.listProjection(bucket);
  const markers = evidenceLossIndex(storage);
  // One pass over checks, one SHA→PRs lookup per distinct (repo, sha): bounded by distinct SHAs, never PRs × checks.
  const byPr = new Map();
  const shaPrs = new Map();
  // Walking stored keys distinguishes an absent (unmatched check) map from an explicitly corrupt null map.
  for (const { key, value: numbers } of storage.listProjection('shas', true)) {
    shaPrs.set(key, numbers);
  }
  const attach = (c, number) => {
    const k = JSON.stringify([c.repo, number]);
    if (!byPr.has(k)) byPr.set(k, new Set());
    byPr.get(k).add(c);
  };
  for (const c of storage.listProjection('checks')) {
    for (const number of c.prs || []) attach(c, number);
    if (!c.sha) continue;
    const shaKey = JSON.stringify([c.repo, c.sha]);
    for (const number of shaPrs.get(shaKey) || []) attach(c, number);
  }
  return storage.listProjection('prs').flatMap((stored) => {
    const { fields, ...row } = withEvidenceLoss(markers, stored);
    const matches = [...(byPr.get(JSON.stringify([row.repo, row.number])) || [])];
    return [{ ...row, seq: matches.reduce((seq, c) => Math.max(seq, c.seq || 0), row.seq || 0),
      checks: matches.filter((c) => c.type === 'check_run'), suites: matches.filter((c) => c.type === 'check_suite') }];
  });
}

export function validateBootstrap(input) {
  if (!input || typeof input !== 'object' || !/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(input.repo || '') ||
      typeof input.importId !== 'string' || !/^[\w.-]{1,128}$/.test(input.importId) ||
      !Number.isSafeInteger(input.baseCursor) || input.baseCursor < 0 ||
      !['complete', 'truncated', 'failed'].includes(input.status) || !Array.isArray(input.prs)) throw new Error('invalid bootstrap');
  const prs = input.prs.map((p) => {
    if (!p || !Number.isSafeInteger(p.number) || p.number <= 0 || typeof p.sha !== 'string' || !p.sha ||
        typeof p.draft !== 'boolean' || p.state !== 'open' || !Array.isArray(p.labels) ||
        !p.labels.every((l) => typeof l === 'string')) throw new Error('invalid bootstrap PR');
    return { number: p.number, sha: p.sha, draft: p.draft, labels: [...new Set(p.labels)], state: 'open' };
  });
  if (new Set(prs.map((p) => p.number)).size !== prs.length || (input.status === 'failed' && prs.length)) throw new Error('invalid bootstrap PRs');
  return { repo: input.repo.toLowerCase(), importId: input.importId, baseCursor: input.baseCursor, status: input.status, prs };
}

/**
 * The event log over a tiny storage interface — ONE implementation of the cursor rules, shared by the Durable
 * Object (SQLite storage, `worker.mjs`) and the in-memory store the tests and local harness use.
 *
 * storage: { getMeta(k), setMeta(k, v), hasDelivery(id), insert(seq, id, at, json), range(afterSeq, limit),
 *            minSeq(), prune(throughSeq, olderThanMs), transaction(fn),
 *            getProjection(bucket, key), putProjection(bucket, key, value), deleteProjection(bucket, key),
 *            listProjection(bucket, withKeys = false) } // withKeys returns { key, value } entries for pruning
 */
export function createEventLog(storage, { maxEvents = DEFAULT_MAX_EVENTS, retentionMs = DEFAULT_RETENTION_MS,
  prsBudgetBytes = PRS_RESPONSE_BUDGET_BYTES, prRetentionMs = DEFAULT_PR_RETENTION_MS,
  tombstoneRetentionMs = DEFAULT_TOMBSTONE_RETENTION_MS } = {}) {
  const head = () => {
    const raw = storage.getMeta('head');
    return raw == null ? 0 : toSeq(raw);
  };
  storage.transaction(() => {
    for (const { key, value: legacy } of storage.listProjection('prunedEvidence', true)) {
      if (!validateStored('prunedEvidence', legacy)) continue;
      let identity;
      try { identity = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(identity) || !['check_run', 'check_suite'].includes(identity[2])) continue;
      const [, , type] = identity;
      const markerKey = JSON.stringify([legacy.repo, legacy.sha]);
      const previous = storedView(storage).getProjection('evidenceLoss', markerKey);
      storage.putProjection('evidenceLoss', markerKey, { repo: legacy.repo, sha: legacy.sha,
        evidenceLost: mergeLoss(previous?.evidenceLost || [], [{ kind: type === 'check_suite' ? 'suites' : 'checks', id: key }]) });
      storage.deleteProjection('prunedEvidence', key);
    }
    if (!storage.getMeta('projectionVersion')) {
      const boundary = storage.minSeq();
      for (const body of storage.range(0, Number.MAX_SAFE_INTEGER)) foldObservation(storage, JSON.parse(body));
      storage.setMeta('coverage', JSON.stringify({ partial: true, observedSince: boundary ?? head() + 1,
        retainedReplayBoundary: boundary, historyComplete: false }));
      storage.setMeta('projectionVersion', '1');
    }
  });
  const log = {
    /** Append one compact record. Returns `{ seq, duplicate }`. */
    append(record, now = Date.now()) { return storage.transaction(() => {
      storage.setMeta('lastDeliveryAt', String(now));
      if (record.id && storage.hasDelivery(record.id)) return { seq: null, duplicate: true };
      if (head() == null) malformedStored();
      const seq = head() + 1;
      const stored = { ...record, seq };
      storage.setMeta('head', String(seq));
      storage.setMeta('lastEventAt', String(now));
      // Per-repo clock: only this repo's own events ever move it (R417).
      if (typeof record.repo === 'string' && record.repo) storage.putProjection('repoEvents', record.repo.toLowerCase(), { repo: record.repo.toLowerCase(), lastEventAt: now });
      const evidenceLostByPr = foldObservation(storage, stored, now);
      if (Object.keys(evidenceLostByPr).length) stored.evidenceLostByPr = evidenceLostByPr;
      storage.insert(seq, record.id || null, now, JSON.stringify(stored));
      pruneProjection(storage, now, prRetentionMs, tombstoneRetentionMs);
      storage.prune(seq - maxEvents, now - retentionMs);
      return { seq, duplicate: false };
    }); },
    bootstrap(raw, now = Date.now()) { return storage.transaction(() => {
      const input = validateBootstrap(raw);
      const horizon = storage.getMeta('tombstoneHorizonSeq') == null ? 0 : toSeq(storage.getMeta('tombstoneHorizonSeq'));
      if (horizon == null || input.baseCursor < horizon) throw new Error('stale bootstrap');
      const importKey = JSON.stringify([input.repo, input.importId]);
      const view = storedView(storage);
      const previous = view.getProjection('imports', importKey);
      if (previous) {
        if (previous.input !== JSON.stringify(input)) throw new Error('import ID conflict');
        return { ...previous.result, duplicate: true };
      }
      if (input.baseCursor > head()) throw new Error('future bootstrap cursor');
      // Seeds fold straight into the projection: they are a baseline, not feed events, so they never enter the
      // replay ring, never advance `head`, and never refresh the feed-health clocks (a seed must not mask a dead
      // webhook). Their field clock is the cursor the listing was taken at, so any later delivery wins.
      for (const pr of input.prs) foldObservation(storage, { ...pr, number: undefined, prs: [pr.number], repo: input.repo,
        type: 'bootstrap', action: 'seed', baseCursor: input.baseCursor, seq: input.baseCursor }, now);
      const result = { repo: input.repo, status: input.status, baseCursor: input.baseCursor, cursor: head(), importId: input.importId, at: now };
      // Import history for the NEW per-repo coverage only (fail closed); it changes no seeding behaviour.
      const seen = view.getProjection('repoImports', input.repo) || { repo: input.repo, others: [] };
      const priorLatest = view.getProjection('bootstrap', input.repo);
      storage.putProjection('repoImports', input.repo, { repo: input.repo, listed: input.prs.map((p) => p.number),
        others: priorLatest ? [...seen.others, priorLatest.baseCursor] : seen.others });
      storage.putProjection('bootstrap', input.repo, result);
      storage.putProjection('imports', importKey, { input: JSON.stringify(input), result });
      return { ...result, duplicate: false };
    }); },
    readPrs(cursor, limit, now = Date.now(), { prsCursor = null, prsLimit = DEFAULT_PAGE_LIMIT, prsAfter = null, rejectMalformedCursor = false } = {}) { return storage.transaction(() => {
      const envelope = log.read(cursor, limit);
      const truncated = { rows: 0, repos: {}, malformed: 0, unattributed: 0 }, incomplete = new Set();
      // One canonical integer form: a safe integer or its canonical digit string; anything else is rejected, never coerced to a tie-breaker.
      const after = toSeq(prsCursor);
      let key = null;
      if (prsAfter != null) {
        try { key = JSON.parse(prsAfter); } catch { /* Rejected below, never restart an unreadable cursor. */ }
        if (after == null || !Array.isArray(key) || key.length !== 2 || typeof key[0] !== 'string' || !Number.isInteger(key[1]))
          throw new RangeError('invalid PR row cursor');
      }
      const pageSize = Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(Number(prsLimit) || DEFAULT_PAGE_LIMIT)));
      const malformed = (row) => {
        truncated.malformed += 1;
        if (isRepo(row?.repo)) incomplete.add(row.repo.toLowerCase());
        else truncated.unattributed += 1;
        if (rejectMalformedCursor && isObject(row) && Object.hasOwn(row, 'seq') && !validateStored('sequence', row.seq))
          throw new RangeError('invalid PR row cursor');
      };
      if (enc.encode(JSON.stringify(storage.listProjection('bootstrap'))).length > prsBudgetBytes)
        throw new RangeError(PRS_ENVELOPE_OVERFLOW);
      const view = storedView(storage, malformed);
      for (const name of ['head', 'tombstoneHorizonSeq']) {
        const value = storage.getMeta(name);
        if (value != null && !validateStored('sequence', value)) malformed(null);
      }
      const projected = projectPrRows(view, malformed).map((r) => {
        const seq = toSeq(r.seq);
        if (seq == null) throw new RangeError('invalid PR row cursor');
        return seq === r.seq ? r : { ...r, seq };
      }).sort((a, b) => a.seq - b.seq || comparePrKey(a, b));
      // Stable identity within a sequence survives earlier rows advancing during concurrent deliveries.
      const eligible = projected.filter((r) => after == null || r.seq > after ||
        (r.seq === after && key && comparePrKey(r, { repo: key[0], number: key[1] }) > 0));
      const rows = eligible.slice(0, pageSize);
      // Absent metadata is legacy; present-but-unreadable metadata is not evidence and fails every repo closed.
      let coverage, badCoverage = false;
      const rawCoverage = storage.getMeta('coverage');
      if (rawCoverage != null) {
        try { coverage = JSON.parse(rawCoverage); } catch { /* Counted below. */ }
        if (!validateStored('coverage', coverage)) { badCoverage = true; malformed(null); coverage = undefined; }
      }
      const response = { ...envelope, prs: [], stateCursor: envelope.head, repos: repoFreshness(view, envelope.head, now),
        coverage: { ...(isObject(coverage) ? coverage : {}), bootstrap: view.listProjection('bootstrap') }, truncated,
        prsCursor: rows.at(-1)?.seq ?? after ?? 0, prsMore: eligible.length > rows.length, prsAfter: null };
      const pagePosition = (kept) => {
        response.prsCursor = kept.at(-1)?.seq ?? after ?? 0;
        const last = kept.at(-1);
        response.prsAfter = last ? JSON.stringify([last.repo, last.number]) : key ? JSON.stringify(key) : null;
        response.prsMore = eligible.length > kept.length;
      };
      pagePosition(rows);
      const failClosed = (repo) => {
        response.repos[repo] ??= { bootstrapAt: null, lastEventAt: null, omittedOpen: [], coverage: false };
        response.repos[repo].coverage = false;
      };
      incomplete.forEach(failClosed);
      projected.filter((r) => r.state === 'open' && !evidenceCovered(r)).forEach((r) => failClosed(r.repo));
      if (truncated.unattributed || badCoverage) Object.keys(response.repos).forEach(failClosed);
      const drop = (row) => {
        truncated.rows += 1;
        truncated.repos[row.repo] = (truncated.repos[row.repo] || 0) + 1;
        if (row.state === 'open') failClosed(row.repo);
      };
      const size = (value) => enc.encode(JSON.stringify(value)).length;
      // Reserve the HTTP timestamp too, while preserving the existing internal snapshot shape.
      const baseBytes = size({ ...response, now }), sizes = [];
      let rowBytes = 0, exhausted = false;
      for (const row of rows) {
        // Serialize each candidate once; count UTF-8 bytes and array commas, not just UTF-16 characters.
        const bytes = exhausted ? 0 : size(row);
        if (exhausted || baseBytes + rowBytes + bytes + sizes.length > prsBudgetBytes) {
          exhausted = true; drop(row);
        } else {
          response.prs.push(row); sizes.push(bytes); rowBytes += bytes;
        }
      }
      pagePosition(response.prs);
      // Truncation counts and repo coverage can enlarge the envelope. Trim the retained prefix to fit them too.
      const envelopeBytes = () => size({ ...response, prs: [], now });
      while (sizes.length && envelopeBytes() + rowBytes + sizes.length - 1 > prsBudgetBytes) {
        rowBytes -= sizes.pop(); drop(response.prs.pop());
        pagePosition(response.prs);
      }
      // Replay and coverage metadata cannot be silently dropped. Reject before crossing the RPC boundary.
      if (envelopeBytes() > prsBudgetBytes) throw new RangeError(PRS_ENVELOPE_OVERFLOW);
      return response;
    }); },
    /** A verified delivery we chose not to store (ping, ignored action) still proves the pipe is alive. */
    touch(now = Date.now()) { storage.setMeta('lastDeliveryAt', String(now)); },
    read(cursor, limit = DEFAULT_PAGE_LIMIT) {
      const h = head();
      const lim = Math.max(1, Math.min(MAX_PAGE_LIMIT, Number(limit) || DEFAULT_PAGE_LIMIT));
      const meta = {
        head: h,
        lastEventAt: numOrNull(storage.getMeta('lastEventAt')),
        lastDeliveryAt: numOrNull(storage.getMeta('lastDeliveryAt')),
      };
      if (cursor == null || !Number.isInteger(cursor) || cursor < 0 || cursor > h) {
        return { cursor: h, events: [], reset: true, gap: false, more: false, ...meta };
      }
      const oldest = storage.minSeq();
      const gap = oldest != null && cursor < oldest - 1;
      const rows = storage.range(cursor, lim).map((j) => JSON.parse(j));
      const next = rows.length ? rows[rows.length - 1].seq : (gap ? h : cursor);
      return { cursor: next, events: rows, reset: false, gap, more: next < h, ...meta };
    },
  };
  return log;
}

const FUTURE_SKEW_MS = 60_000;
/** Per-repo `{ bootstrapAt, lastEventAt, coverage }`, each from that repo's OWN bootstrap/event rows. Times are the
 *  Worker's clock at write, beyond the reader's now + 60 s rejected as null with coverage false (never trust a future time). Coverage = bootstrap
 *  complete with a recorded time AND no events pruned since its base cursor (conservative: the ring is global). */
function repoFreshness(storage, head, now) {
  const clamp = (v) => (Number.isFinite(v) && v <= now + FUTURE_SKEW_MS ? v : null); // a future time is rejected, never shown as fresh
  const oldest = storage.minSeq();
  const boots = new Map(storage.listProjection('bootstrap').map((b) => [b.repo, b]));
  const imports = new Map(storage.listProjection('repoImports').map((i) => [i.repo, i]));
  const markers = evidenceLossIndex(storage);
  const openRows = storage.listProjection('prs').filter((r) => r.state === 'open').map((r) => withEvidenceLoss(markers, r));
  const lastEvent = new Map(storage.listProjection('repoEvents').map((e) => [e.repo, e.lastEventAt]));
  const out = {};
  for (const repo of [...new Set([...boots.keys(), ...lastEvent.keys(), ...openRows.map((r) => r.repo)])].sort()) {
    const b = boots.get(repo);
    const bootstrapAt = b ? clamp(b.at) : null;
    const gap = b ? head > b.baseCursor && (oldest == null || b.baseCursor < oldest - 1) : true;
    const lastEventAt = clamp(lastEvent.get(repo));
    const badEvent = lastEvent.has(repo) && lastEventAt == null; // an unreadable/future event time voids coverage
    // Open rows the Worker holds that the latest COMPLETE listing left out (rows a later event touched are newer, not omitted).
    const omittedOpen = b && b.status === 'complete' ? openRows.filter((r) => r.repo === repo && (r.fields?.state || 0) <= b.baseCursor &&
      !(imports.get(repo)?.listed || []).includes(r.number)).map((r) => r.number).sort((x, y) => x - y) : [];
    // Any lost evidence on an open row makes the repository incomplete.
    const lostEvidence = openRows.some((r) => r.repo === repo && !evidenceCovered(r));
    out[repo] = { bootstrapAt, lastEventAt, omittedOpen, coverage: !lostEvidence && !omittedOpen.length && !!b && b.status === 'complete' && bootstrapAt != null && !gap && !badEvent &&
      (imports.get(repo)?.others || []).every((c) => c < b.baseCursor) };
  }
  return out;
}

const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** The in-memory storage (tests + local harness). Same contract as the Durable Object's SQL storage.
 *  @test-only-export-ok: the Worker uses its SQL storage; this is the unit-test / local-replay backend by design. */
export function createMemoryStorage() {
  let meta = new Map();
  let projection = new Map();
  let rows = []; // { seq, id, at, json } ascending
  return {
    transaction(fn) {
      const saved = [new Map(meta), structuredClone(rows), structuredClone(projection)];
      try { return fn(); } catch (error) { [meta, rows, projection] = saved; throw error; }
    },
    getProjection: (bucket, key) => structuredClone(projection.get(JSON.stringify([bucket, key])) ?? null),
    putProjection: (bucket, key, value) => { projection.set(JSON.stringify([bucket, key]), structuredClone(value)); },
    deleteProjection: (bucket, key) => { projection.delete(JSON.stringify([bucket, key])); },
    listProjection: (bucket, withKeys = false) => [...projection].filter(([k]) => JSON.parse(k)[0] === bucket)
      .map(([k, v]) => withKeys ? { key: JSON.parse(k)[1], value: structuredClone(v) } : structuredClone(v)),
    getMeta: (k) => (meta.has(k) ? meta.get(k) : null),
    setMeta: (k, v) => { meta.set(k, v); },
    hasDelivery: (id) => rows.some((r) => r.id === id),
    insert: (seq, id, at, json) => { rows.push({ seq, id, at, json }); },
    range: (after, limit) => rows.filter((r) => r.seq > after).slice(0, limit).map((r) => r.json),
    minSeq: () => (rows.length ? rows[0].seq : null),
    prune: (throughSeq, olderThanMs) => { rows = rows.filter((r) => r.seq > throughSeq && r.at >= olderThanMs); },
    _rows: () => rows,
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * Route one request. `getLog()` returns the event log (sync or async; the Worker hands back a Durable Object
 * stub whose methods are async RPC, the tests a plain `createEventLog`).
 */
export async function handleRequest(request, env, { getLog, now = () => Date.now() }) {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') return json(200, { ok: true });

  if (url.pathname === '/github/webhook') {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
    if (!env.GITHUB_WEBHOOK_SECRET) return json(503, { error: 'webhook secret not configured' });
    const raw = new Uint8Array(await request.arrayBuffer());
    const ok = await verifySignature(env.GITHUB_WEBHOOK_SECRET, raw, request.headers.get('x-hub-signature-256'));
    if (!ok) return json(401, { error: 'bad signature' });
    const eventName = request.headers.get('x-github-event') || '';
    const deliveryId = request.headers.get('x-github-delivery') || null;
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { return json(400, { error: 'body is not JSON' }); }
    const t = now();
    const log = await getLog();
    const record = parseGithubEvent(eventName, payload, { deliveryId, receivedAt: t });
    if (!record) {
      await log.touch(t);
      return json(200, { stored: false, reason: eventName === 'ping' ? 'ping' : 'ignored event/action' });
    }
    const res = await log.append(record, t);
    return json(202, { stored: !res.duplicate, seq: res.seq, duplicate: res.duplicate });
  }

  if (url.pathname === '/prs/bootstrap') {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
    if (!env.PR_EVENTS_BOOTSTRAP_TOKEN) return json(503, { error: 'bootstrap token not configured' });
    if (!timingSafeEqual(request.headers.get('authorization') || '', `Bearer ${env.PR_EVENTS_BOOTSTRAP_TOKEN}`)) return json(401, { error: 'unauthorized' });
    let input;
    try { input = validateBootstrap(await request.json()); } catch { return json(400, { error: 'invalid bootstrap' }); }
    const log = await getLog();
    try { return json(200, await log.bootstrap(input, now())); }
    catch (error) { return json(409, { error: error?.message === 'stale bootstrap' ? 'stale bootstrap' : 'bootstrap rejected' }); }
  }

  if (url.pathname === '/events' || url.pathname === '/prs') {
    if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
    if (!env.PR_EVENTS_READ_TOKEN) return json(503, { error: 'read token not configured' });
    const auth = request.headers.get('authorization') || '';
    const m = /^Bearer (.+)$/.exec(auth);
    if (!m || !timingSafeEqual(m[1], env.PR_EVENTS_READ_TOKEN)) return json(401, { error: 'unauthorized' });
    const c = url.searchParams.get('cursor');
    const cursor = c == null || c === '' ? null : (/^\d+$/.test(c) ? Number(c) : null);
    const limit = Number(url.searchParams.get('limit')) || DEFAULT_PAGE_LIMIT;
    const log = await getLog();
    try {
      const timestamp = now(); // Use exactly the timestamp reserved by readPrs, even if the RPC takes time.
      const rowCursor = url.searchParams.get('prsCursor');
      const prsCursor = rowCursor != null && /^\d+$/.test(rowCursor) ? Number(rowCursor) : null;
      const rowPage = { prsCursor, prsLimit: Number(url.searchParams.get('prsLimit')) || DEFAULT_PAGE_LIMIT,
        prsAfter: url.searchParams.get('prsAfter'), rejectMalformedCursor: true };
      return json(200, { ...(await (url.pathname === '/prs' ? log.readPrs(cursor, limit, timestamp, rowPage) : log.read(cursor, limit))), now: timestamp });
    } catch (error) {
      // Match the message because Durable Object RPC preserves standard errors, not custom properties.
      if (url.pathname === '/prs' && error?.message === PRS_ENVELOPE_OVERFLOW) return json(503, { error: PRS_ENVELOPE_OVERFLOW });
      if (url.pathname === '/prs' && error?.message === 'invalid PR row cursor') return json(400, { error: error.message });
      throw error;
    }
  }

  return json(404, { error: 'not found' });
}
