/**
 * @file scripts/operations/record-referral-ruling-io.mjs
 * @description The io binding of `record-referral-ruling` (#4979): reads the PR thread through `gh`, resolves the
 *   `--card` reference in THIS checkout's backlog, and posts the one operator-ruling comment. The post re-reads the
 *   thread before and after: it never double-posts a byte-identical ruling, refuses when the head moved since the
 *   plan. Follow-up re-checks the head, delegates send-back to review-set-label, and clears the ruling-needed label.
 *   The post fails unless the gate's own reader sees the ruling it just wrote.
 */

import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readOperatorRulings } from '../lib/jury-core.mjs';
import { currentActorId } from '../lib/review-independence.mjs';
import { referralCardReadable } from '../review-set-label.mjs';
import { CARD_REF_RE } from '../lib/referral-card-readable.mjs';
import { EVENT_TYPES, buildLedgerEvent, serializeLedgerEvent, verdictLedgerPath } from '../lib/verdict-ledger.mjs';
import { assertOperatorCliFresh } from '../lib/main-staleness.mjs';
import { idFromName, normalizeId } from '../backlog/id.mjs';
import { openReferralFindings, OPERATOR_RULING_POST_EFFECT, OPERATOR_RULING_FOLLOW_UP_EFFECT, RULING_NEEDED_LABEL } from './record-referral-ruling.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ghJson = (args) => JSON.parse(execFileSyncThrottled('gh', args,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }));

/** The live PR fields the gate reads (`gh pr view` returns each comment's `author.login`). */
export function readPrThread(repo, pr, { readJson = ghJson } = {}) {
  const v = readJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,body,createdAt,comments']);
  if (!v || !Array.isArray(v.comments) || !/^[a-f0-9]{40}$/.test(v.headRefOid ?? '')) {
    throw new Error(`could not read PR #${pr}'s head and comments from ${repo}`);
  }
  return v;
}

/**
 * Resolve `--card` to a `we:backlog/<file>.md` reference: a full reference, a numeric id, or a provisional
 * `x…` id (also found through a landed card's `bornAs:`). Readability uses the gate's own check.
 */
export function resolveCardRef(requested, { root = REPO_ROOT, listFiles = (d) => readdirSync(d),
  readText = (p) => readFileSync(p, 'utf8'), readable = referralCardReadable } = {}) {
  if (requested === undefined || requested === null || requested === '') return null;
  const ask = String(requested).trim();
  let ref = null;
  if (CARD_REF_RE.test(ask)) ref = ask;
  else {
    const id = idFromName(ask);
    const files = (() => { try { return listFiles(join(root, 'backlog')).filter((f) => f.endsWith('.md')); } catch { return []; } })();
    if (id) {
      const padded = normalizeId(id);
      let hits = files.filter((f) => f.startsWith(`${padded}-`));
      if (!hits.length && /^x/.test(padded)) {
        hits = files.filter((f) => {
          try { return new RegExp(`^bornAs:[ \\t]*["']?${padded}["']?[ \\t]*$`, 'm').test(readText(join(root, 'backlog', f))); }
          catch { return false; }
        });
      }
      if (hits.length === 1) ref = `we:backlog/${hits[0]}`;
      else return { requested: ask, ref: null, readable: false, reason: hits.length ? 'ambiguous id' : 'no backlog card with that id (has it landed on main? fetch and retry)' };
    }
  }
  if (!ref) return { requested: ask, ref: null, readable: false, reason: 'not a card id or we:backlog/<file>.md[@pr<N>] reference' };
  const ok = readable(ref, root);
  return { requested: ask, ref, readable: ok, reason: ok ? 'readable' : 'card file is missing or has no frontmatter (a card only on an open PR: cite it as we:backlog/<file>.md@pr<N>)' };
}

export function createRecordReferralRulingReader({ root = REPO_ROOT, readJson = ghJson, now = () => new Date().toISOString(),
  env = process.env, readable = referralCardReadable,
  // Item 113 — the ruling is judged with THIS checkout's code; refuse from a stale one (see `assertOperatorCliFresh`).
  assertFresh = () => assertOperatorCliFresh(REPO_ROOT, { label: 'record-referral-ruling', env }) } = {}) {
  return ({ repo, pr, card }) => {
    assertFresh();
    const thread = readPrThread(repo, pr, { readJson });
    const cardReadable = (ref) => readable(ref, root);
    const open = openReferralFindings({ comments: thread.comments, repo, pr: Number(pr), head: thread.headRefOid,
      body: typeof thread.body === 'string' ? thread.body : '', createdAt: thread.createdAt, cardReadable });
    return {
      head: thread.headRefOid, open: open.open, malformed: open.malformed,
      card: resolveCardRef(card, { root, readable }),
      followUpEnabled: env.WE_REFERRAL_RULING_FOLLOW_UP !== '0',
      now: now(), clearerId: currentActorId(env),
    };
  };
}

/** Ruling results that CLEAR a finding's hold (`card`, `not-real`); `block` holds (statute F4, #verdict-ledger-pr-state-store). */
const clearsHold = (result) => result !== 'block';

/**
 * Default ledger writer for ruling / send-back events: appends to the machine-local ledger (same file and lock-free
 * line append as `appendVerdict`'s home store). Throws on an invalid event or a write error so the caller can apply
 * the F4 write-miss posture. The git-transport leg awaits an event-capable `appendLedgerRows`.
 */
export function appendLedgerEventsHome(events) {
  for (const e of events) {
    const s = serializeLedgerEvent(e);
    if (!s.ok) throw new Error(`invalid ledger event refused: ${s.errors.join('; ')}`);
    const path = verdictLedgerPath(e.repo);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${s.line}\n`, 'utf8');
  }
}

export function createRecordReferralRulingSinks({ readJson = ghJson,
  appendEvents = appendLedgerEventsHome,
  warn = (m) => process.stderr.write(`${m}\n`),
  now = () => new Date().toISOString(),
  readPr = (repo, pr) => readJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,labels']),
  runSetLabel = execFileSync,
  setLabels = (...args) => execFileSyncThrottled('gh', args,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }),
  post = (repo, pr, body) => execFileSyncThrottled('gh',
  ['pr', 'comment', String(pr), '--repo', repo, '--body', body], { encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }) } = {}) {
  return {
    [OPERATOR_RULING_FOLLOW_UP_EFFECT]: async ({ repo, pr, head, action, body, actor, channel, remaining = [] }) => {
      const before = await readPr(repo, pr);
      if (before.headRefOid !== head) throw new Error(`PR #${pr}'s head moved to ${before.headRefOid} since the plan (${head}); nothing changed — re-run against the new head`);
      // Others still wait: the ruling comment woke the paused review (a fresh advisory follows on this head); the
      // label stays because the gate still holds them. Report the exact set that remains.
      if (action === 'rearm') return { action, sentBack: false, labelCleared: false, rearmed: true, remaining };
      const labels = before.labels.map((l) => typeof l === 'string' ? l : l.name);
      let sentBack = false;
      if (action === 'send-back' && !labels.includes('review:changes')) {
        const dir = mkdtempSync(join(tmpdir(), 'operator-referral-ruling-'));
        try {
          const path = join(dir, 'body.md');
          writeFileSync(path, body, 'utf8');
          let stdout;
          try {
            stdout = await runSetLabel(process.execPath, [join(REPO_ROOT, 'scripts/review-set-label.mjs'), String(pr),
              `--repo=${repo}`, '--to=changes', `--body-file=${path}`, `--actor=${actor}`, `--channel=${channel}`],
            { encoding: 'utf8', timeout: 120_000 });
          } catch (error) {
            let message;
            try { message = JSON.parse(String(error.stdout)).error; } catch { /* Keep the process error when stdout is not JSON. */ }
            throw new Error(message || error.message);
          }
          const result = JSON.parse(String(stdout).trim().split('\n').filter(Boolean).at(-1) ?? '{}');
          if (result.error || result.ok !== true) throw new Error(result.error || 'review-set-label did not confirm send-back');
          sentBack = true;
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }
      const labelCleared = labels.includes(RULING_NEEDED_LABEL);
      if (labelCleared) await setLabels('pr', 'edit', String(pr), '--repo', repo, '--remove-label', RULING_NEEDED_LABEL);
      let ledgerWriteMiss = false;
      if (sentBack) {
        // A send-back is a HOLDING event: its label hold already applied, so a miss only raises the smell.
        try {
          appendEvents([buildLedgerEvent({ type: EVENT_TYPES.SEND_BACK, repo, pr, at: now(),
            source: 'record-referral-ruling', declaredActor: actor, channel, cause: 'block-ruling' })]);
        } catch (e) {
          ledgerWriteMiss = true;
          warn(`ledger-write-miss: send-back of ${repo}#${pr} was applied but not recorded in the verdict ledger: ${String(e?.message ?? e)}`);
        }
      }
      return { action, sentBack, labelCleared, ...(ledgerWriteMiss ? { ledgerWriteMiss } : {}) };
    },
    [OPERATOR_RULING_POST_EFFECT]: async ({ repo, pr, head, body, rulings = [], actor = '', channel = '' }) => {
      const before = readPrThread(repo, pr, { readJson });
      if (before.headRefOid !== head) throw new Error(`PR #${pr}'s head moved to ${before.headRefOid} since the plan (${head}); nothing posted — re-run against the new head`);
      const events = rulings.map((r) => buildLedgerEvent({ type: EVENT_TYPES.RULING, repo, pr, at: now(),
        source: 'record-referral-ruling', declaredActor: actor, channel, findingKey: r.key, ruling: r.result }));
      const tryAppend = (list) => { try { appendEvents(list); return null; } catch (e) { return String(e?.message ?? e); } };
      // F4: a CLEARING ruling (card / not-real) that cannot be recorded does not clear: nothing is posted, the
      // operation stays resumable. A HOLDING ruling (block) is still posted and raises ledger-write-miss.
      const clearing = events.filter((e) => clearsHold(e.ruling));
      if (clearing.length) {
        const miss = tryAppend(clearing);
        if (miss) throw new Error(`ledger-write-miss: the ruling was not recorded in the verdict ledger, so it does not clear and nothing was posted (${miss}); retry once the ledger is writable`);
      }
      const already = before.comments.some((c) => String(c?.body ?? '').replace(/\r\n/g, '\n').trimEnd() === body);
      if (!already) post(repo, pr, body);
      const after = readPrThread(repo, pr, { readJson });
      const seen = after.comments.filter((c) => String(c?.body ?? '').replace(/\r\n/g, '\n').trimEnd() === body);
      if (!seen.length || !readOperatorRulings(seen, { head }).rulings.length) {
        throw new Error('the ruling comment is not readable by the gate after posting (untrusted author or altered body); the hold remains — inspect the thread before retrying');
      }
      const holding = events.filter((e) => !clearsHold(e.ruling));
      const holdMiss = holding.length ? tryAppend(holding) : null;
      if (holdMiss) warn(`ledger-write-miss: block ruling on ${repo}#${pr} was posted but not recorded in the verdict ledger: ${holdMiss}`);
      return { posted: !already, head, url: seen.at(-1)?.url ?? null, ...(holdMiss ? { ledgerWriteMiss: true } : {}) };
    },
  };
}
