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
export const DEFAULT_PAGE_LIMIT = 200;
export const MAX_PAGE_LIMIT = 500;

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

/** Fold only received evidence. Field clocks protect concurrent bootstrap imports. */
export function foldObservation(storage, observed) {
  // GitHub spells a repo one way, an operator may type another: the projection identifies a repo case-insensitively.
  const event = { ...observed, repo: String(observed.repo).toLowerCase() };
  const { repo, seq, sha, type } = event;
  const key = (...parts) => JSON.stringify(parts);
  const put = (bucket, k, value) => storage.putProjection(bucket, k, value);
  const get = (bucket, k) => storage.getProjection(bucket, k);
  if (type === 'check_run' || type === 'check_suite') {
    // Preserve explicit attachment evidence across later empty-array deliveries.
    // A null SHA is not a join key: unrelated unknown-head observations stay separate.
    // A check run is identified by name AND app: two apps may report the same name for the same SHA.
    const checkKey = checkProjectionKey(event);
    const previous = get('checks', checkKey);
    put('checks', checkKey, { ...event, prs: [...new Set([...(previous?.prs || []), ...(event.prs || [])])] });
  }
  const associated = sha ? get('shas', key(repo, sha)) || [] : [];
  const numbers = [...new Set([...(event.prs || []), ...((type === 'check_run' || type === 'check_suite') ? associated : [])])];
  for (const number of numbers) {
    const rowKey = key(repo, number);
    const row = get('prs', rowKey) || { repo, number, sha: null, draft: null, labels: null,
      state: null, merged: null, review: null, checks: [], suites: [], seq: 0, fields: {}, labelChanges: {} };
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
    row.seq = Math.max(row.seq, seq);
    put('prs', rowKey, row);
  }
}

/** The served per-PR rows (`GET /prs`'s `prs`) of a projection storage. Exported for the reader-side mirror. */
export function projectPrRows(storage) {
  // One pass over checks, one SHA→PRs lookup per distinct (repo, sha): bounded by distinct SHAs, never PRs × checks.
  const byPr = new Map();
  const shaPrs = new Map();
  const attach = (c, number) => {
    const k = JSON.stringify([c.repo, number]);
    if (!byPr.has(k)) byPr.set(k, new Set());
    byPr.get(k).add(c);
  };
  for (const c of storage.listProjection('checks')) {
    for (const number of c.prs || []) attach(c, number);
    if (!c.sha) continue;
    const shaKey = JSON.stringify([c.repo, c.sha]);
    if (!shaPrs.has(shaKey)) shaPrs.set(shaKey, storage.getProjection('shas', shaKey) || []);
    for (const number of shaPrs.get(shaKey)) attach(c, number);
  }
  return storage.listProjection('prs').map(({ fields, ...row }) => {
    const matches = [...(byPr.get(JSON.stringify([row.repo, row.number])) || [])];
    return { ...row, seq: Math.max(row.seq, ...matches.map((c) => c.seq)),
      checks: matches.filter((c) => c.type === 'check_run'), suites: matches.filter((c) => c.type === 'check_suite') };
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
 *            getProjection(bucket, key), putProjection(bucket, key, value), listProjection(bucket) }
 */
export function createEventLog(storage, { maxEvents = DEFAULT_MAX_EVENTS, retentionMs = DEFAULT_RETENTION_MS } = {}) {
  const head = () => Number(storage.getMeta('head') || 0);
  storage.transaction(() => {
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
      const seq = head() + 1;
      const stored = { ...record, seq };
      storage.insert(seq, record.id || null, now, JSON.stringify(stored));
      storage.setMeta('head', String(seq));
      storage.setMeta('lastEventAt', String(now));
      foldObservation(storage, stored);
      storage.prune(seq - maxEvents, now - retentionMs);
      return { seq, duplicate: false };
    }); },
    bootstrap(raw, now = Date.now()) { return storage.transaction(() => {
      const input = validateBootstrap(raw);
      const importKey = JSON.stringify([input.repo, input.importId]);
      const previous = storage.getProjection('imports', importKey);
      if (previous) {
        if (previous.input !== JSON.stringify(input)) throw new Error('import ID conflict');
        return { ...previous.result, duplicate: true };
      }
      if (input.baseCursor > head()) throw new Error('future bootstrap cursor');
      // Seeds fold straight into the projection: they are a baseline, not feed events, so they never enter the
      // replay ring, never advance `head`, and never refresh the feed-health clocks (a seed must not mask a dead
      // webhook). Their field clock is the cursor the listing was taken at, so any later delivery wins.
      for (const pr of input.prs) foldObservation(storage, { ...pr, number: undefined, prs: [pr.number], repo: input.repo,
        type: 'bootstrap', action: 'seed', baseCursor: input.baseCursor, seq: input.baseCursor });
      const result = { repo: input.repo, status: input.status, baseCursor: input.baseCursor, cursor: head(), importId: input.importId };
      storage.putProjection('bootstrap', input.repo, result);
      storage.putProjection('imports', importKey, { input: JSON.stringify(input), result });
      return { ...result, duplicate: false };
    }); },
    readPrs(cursor, limit) { return storage.transaction(() => {
      const envelope = log.read(cursor, limit);
      return { ...envelope, prs: projectPrRows(storage), stateCursor: envelope.head,
        coverage: { ...JSON.parse(storage.getMeta('coverage')), bootstrap: storage.listProjection('bootstrap') } };
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
    listProjection: (bucket) => [...projection].filter(([k]) => JSON.parse(k)[0] === bucket).map(([, v]) => structuredClone(v)),
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
    try { return json(200, await log.bootstrap(input, now())); } catch { return json(409, { error: 'bootstrap rejected' }); }
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
    return json(200, { ...(await (url.pathname === '/prs' ? log.readPrs(cursor, limit) : log.read(cursor, limit))), now: now() });
  }

  return json(404, { error: 'not found' });
}
