/**
 * @file scripts/operations/record-referral-ruling-io.mjs
 * @description The io binding of `record-referral-ruling` (#4979): reads the PR thread through `gh`, resolves the
 *   `--card` reference in THIS checkout's backlog, and posts the one operator-ruling comment. The post re-reads the
 *   thread before and after: it never double-posts a byte-identical ruling, refuses when the head moved since the
 *   plan. Follow-up re-checks the head, delegates send-back to review-set-label, and clears the ruling-needed label.
 *   The post fails unless the gate's own reader sees the ruling it just wrote.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readOperatorRulings } from '../lib/jury-core.mjs';
import { currentActorId } from '../lib/review-independence.mjs';
import { referralCardReadable } from '../review-set-label.mjs';
import { CARD_REF_RE } from '../lib/referral-card-readable.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { EVENT_TYPES, appendVerdictAsync, buildLedgerEvent } from '../lib/verdict-ledger.mjs';
import '../lib/verdict-ledger-io.mjs'; // registers the `git` store `appendVerdictAsync` writes to
import { ledgerFindingKey } from '../lib/pr-state/referrals.mjs';
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

const git = (root, args) => execFileSync('git', ['-C', root, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });

/**
 * The backlog as it stands on the ruled PR's head, read-only (never a checkout): fetch `refs/pull/<N>/head` so the
 * head's objects are local, confirm the exact head sha the plan read is present, then list and `git show` the
 * `backlog/` files at THAT sha. Only the WE repo's PRs carry WE cards. Throws on any failure (the caller treats it
 * as "not found there").
 */
export function openPrHeadBacklog({ repo, pr, head, root = REPO_ROOT, run = git } = {}) {
  if (repo !== CONSTELLATION_REPOS.we.slug) throw new Error(`${repo} is not the backlog repo`);
  if (!/^[1-9]\d{0,8}$/.test(String(pr)) || !/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('needs a PR number and a head sha');
  run(root, ['fetch', '--no-tags', '--quiet', 'origin', `refs/pull/${pr}/head`]);
  run(root, ['cat-file', '-e', `${head}^{commit}`]);
  return {
    list: () => run(root, ['ls-tree', '--name-only', `${head}:backlog`]).split('\n').filter(Boolean),
    read: (file) => run(root, ['show', `${head}:backlog/${file}`]),
  };
}

const findCard = (padded, files, readText) => {
  let hits = files.filter((f) => f.startsWith(`${padded}-`));
  if (!hits.length && /^x/.test(padded)) {
    hits = files.filter((f) => {
      try { return new RegExp(`^bornAs:[ \\t]*["']?${padded}["']?[ \\t]*$`, 'm').test(readText(f)); }
      catch { return false; }
    });
  }
  return hits;
};

/**
 * Resolve `--card` to a `we:backlog/<file>.md` reference: a full reference, a numeric id, or a provisional
 * `x…` id (also found through a landed card's `bornAs:`). Readability uses the gate's own check.
 * A card the ruled PR files for its own follow-up is not on main yet: when `pr` + `prHead` are given and the card
 * is not in this checkout, it is looked up on that PR's head the same way and cited `we:backlog/<file>.md@pr<N>`
 * (the form the gate reads at the PR's head). `foundIn` records where it was found: `main` or `pr-head`.
 */
export function resolveCardRef(requested, { root = REPO_ROOT, listFiles = (d) => readdirSync(d),
  readText = (p) => readFileSync(p, 'utf8'), readable = referralCardReadable, pr = null, prHead = null } = {}) {
  if (requested === undefined || requested === null || requested === '') return null;
  const ask = String(requested).trim();
  const onPr = pr !== null && pr !== undefined && prHead ? String(pr) : null;
  const prFiles = () => { try { return prHead.list().filter((f) => f.endsWith('.md')); } catch { return []; } };
  const prRead = (f) => prHead.read(f) ?? '';
  let ref = null;
  let foundIn = 'main';
  if (CARD_REF_RE.test(ask)) {
    ref = ask;
    if (/@pr\d+$/.test(ask)) foundIn = 'pr-head';
    else if (onPr && !readable(ask, root)) {
      const file = ask.slice('we:backlog/'.length);
      if (prFiles().includes(file)) { ref = `${ask}@pr${onPr}`; foundIn = 'pr-head'; }
    }
  } else {
    const id = idFromName(ask);
    const files = (() => { try { return listFiles(join(root, 'backlog')).filter((f) => f.endsWith('.md')); } catch { return []; } })();
    if (id) {
      const padded = normalizeId(id);
      let hits = findCard(padded, files, (f) => readText(join(root, 'backlog', f)));
      if (!hits.length && onPr) {
        hits = findCard(padded, prFiles(), prRead).map((f) => `${f}@pr${onPr}`);
        if (hits.length) foundIn = 'pr-head';
      }
      if (hits.length === 1) ref = `we:backlog/${hits[0]}`;
      else return { requested: ask, ref: null, readable: false, reason: hits.length ? 'ambiguous id' : `no backlog card with that id on main${onPr ? ` or on PR #${onPr}'s head` : ''} (has it landed on main? fetch and retry)` };
    }
  }
  if (!ref) return { requested: ask, ref: null, readable: false, reason: 'not a card id or we:backlog/<file>.md[@pr<N>] reference' };
  const ok = readable(ref, root);
  return { requested: ask, ref, readable: ok, foundIn, reason: ok ? 'readable' : 'card file is missing or has no frontmatter (a card only on an open PR: cite it as we:backlog/<file>.md@pr<N>)' };
}

/** Opens the PR head (a fetch) only when the card is not on main, and at most once. */
const lazyPrHead = (open) => {
  let h;
  const get = () => (h ??= open());
  return { list: () => get().list(), read: (f) => get().read(f) };
};

export function createRecordReferralRulingReader({ root = REPO_ROOT, readJson = ghJson, now = () => new Date().toISOString(),
  env = process.env, readable = referralCardReadable, openPrHead = openPrHeadBacklog,
  // Item 113 — the ruling is judged with THIS checkout's code; refuse from a stale one (see `assertOperatorCliFresh`).
  assertFresh = () => assertOperatorCliFresh(REPO_ROOT, { label: 'record-referral-ruling', env }) } = {}) {
  return ({ repo, pr, card }) => {
    assertFresh();
    const thread = readPrThread(repo, pr, { readJson });
    const cardReadable = (ref) => readable(ref, root);
    const open = openReferralFindings({ comments: thread.comments, repo, pr: Number(pr), head: thread.headRefOid,
      body: typeof thread.body === 'string' ? thread.body : '', createdAt: thread.createdAt, cardReadable });
    return {
      head: thread.headRefOid, open: open.open, ruled: open.ruled, disputed: open.disputed, malformed: open.malformed,
      card: resolveCardRef(card, { root, readable, pr, prHead: lazyPrHead(() => openPrHead({ repo, pr, head: thread.headRefOid })) }),
      followUpEnabled: env.WE_REFERRAL_RULING_FOLLOW_UP !== '0',
      now: now(), clearerId: currentActorId(env),
    };
  };
}

/** Ruling results that CLEAR a finding's hold (`card`, `not-real`); `block` holds (statute F4, #verdict-ledger-pr-state-store). */
const clearsHold = (result) => result !== 'block';

/**
 * Default ledger writer for ruling / send-back events: the ONE sanctioned append, `appendVerdictAsync`, with its default
 * store (`dual`: the machine-local file AND the shared git store on `ops/review-requests`, in the F4 order for a
 * clearing vs a holding row). Before this, the default wrote the home file only, so no ruling or send-back row ever
 * reached the git store the shared readers fold (slice H shadow: 7 block + 8 ordinary rulings missing). Throws when
 * a row is refused or missed git, so the caller applies the F4 write-miss posture. Every event is attempted: one
 * failure never skips the rest of the batch (each holding ruling keeps its home row), and the failures come back as
 * ONE aggregate error. `opts` is passed through to `appendVerdictAsync`, which has the same F4 policy as the sync
 * `appendVerdict` but also writes through a plugged async store (test seams: store, board, env, gitAppend, homeAppend).
 */
export async function appendLedgerEvents(events, opts = {}) {
  const misses = [];
  for (const e of events) {
    try {
      const res = await appendVerdictAsync(e, opts);
      const detail = res?.git?.error || res?.error || (res?.errors ?? []).join('; ') || 'unknown';
      if (res?.ledgerWriteMiss) misses.push(`git store write missed${res.ok ? ' (the home row stands)' : ''}: ${detail}`);
      else if (!res?.ok) misses.push(`ledger append refused: ${detail}`);
    } catch (error) {
      misses.push(`ledger append failed: ${String(error?.message ?? error).split('\n')[0]}`);
    }
  }
  if (misses.length) throw new Error(events.length === 1 ? misses[0] : `${misses.length} of ${events.length} ledger events failed: ${misses.join('; ')}`);
}

export function createRecordReferralRulingSinks({ readJson = ghJson,
  appendEvents = appendLedgerEvents,
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
          await appendEvents([buildLedgerEvent({ type: EVENT_TYPES.SEND_BACK, repo, pr, at: now(),
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
        // Hash the FULL key, the form the referral row names (`review-pr-io`); a raw key never closes its referral.
        source: 'record-referral-ruling', declaredActor: actor, channel, findingKey: ledgerFindingKey(r.key), ruling: r.result }));
      const tryAppend = async (list) => { try { await appendEvents(list); return null; } catch (e) { return String(e?.message ?? e); } };
      // F4: a CLEARING ruling (card / not-real) that cannot be recorded does not clear: nothing is posted, the
      // operation stays resumable. A HOLDING ruling (block) is still posted and raises ledger-write-miss.
      const clearing = events.filter((e) => clearsHold(e.ruling));
      // A clearing row recorded without its comment is live and closes its referral. The ledger is append-only, so it is
      // reverted by a LATER holding `block` row for the same finding: the derive folds in append order, so the finding
      // ends `blocking` (a `ruled` key ignores a later referral, so no other row can reopen it for a ruling). Returns the
      // keys whose revert could not be recorded either, which may still be live. The revert is unconditional: a row
      // another writer appended for the same finding in between is overridden by the hold (the fail-safe side).
      const RERUN = 're-run the same ruling once the ledger is writable to record the rest and post the comment';
      const revertToHold = async (rows) => {
        const stillLive = [];
        for (const e of rows) {
          const hold = buildLedgerEvent({ type: EVENT_TYPES.RULING, repo, pr, at: now(), source: 'record-referral-ruling',
            declaredActor: actor, channel, findingKey: e.findingKey, ruling: 'block' });
          if (await tryAppend([hold])) stillLive.push(e.findingKey);
        }
        return stillLive;
      };
      const revertNote = (rows, stillLive) => stillLive.length
        ? `${stillLive.join(', ')} ${stillLive.length === 1 ? 'may be' : 'may each be'} LIVE in the ledger and clear${stillLive.length === 1 ? 's' : ''} without a comment (the revert to a holding block ruling was not recorded either)`
        : `${rows.map((e) => e.findingKey).join(', ')} reverted to a holding block ruling, so the finding is blocking (not cleared) until the ruling is re-run`;
      if (clearing.length) {
        // One at a time, stopping at the first miss, so no further clearing row is written once the ledger is failing
        // (holding rulings below are the opposite: attempt them all). The ledger is append-only, so a row recorded
        // BEFORE the miss is already live and closes its referral with no comment posted. It cannot be deleted, so it is
        // reverted by a LATER holding `block` row for the same finding (the derive folds in append order, so the finding
        // ends held again). If that revert cannot be recorded either, the rows still live are named in the error. Either
        // way a re-run finishes the batch: the plan reads only the PR thread, so it plans every finding again, records
        // the clearing rows after the revert (the latest row wins) and posts the comment.
        let miss = null, missed = null;
        const recorded = [];
        for (const e of clearing) {
          miss = await tryAppend([e]);
          if (miss) { missed = e; break; }
          recorded.push(e);
        }
        if (miss && recorded.length) {
          // The row that missed is reverted too: a failed append can still have landed (a push whose reply was lost).
          const touched = [...recorded, missed];
          throw new Error(`ledger-write-miss: ${recorded.length} of ${clearing.length} clearing rulings were recorded before the ledger failed (${miss}); `
            + `${revertNote(touched, await revertToHold(touched))}, and nothing was posted; ${RERUN}`);
        }
        if (miss) throw new Error(`ledger-write-miss: the ruling was not recorded in the verdict ledger, so it does not clear and nothing was posted (${miss}); retry once the ledger is writable`);
      }
      const already = before.comments.some((c) => String(c?.body ?? '').replace(/\r\n/g, '\n').trimEnd() === body);
      let seen;
      try {
        if (!already) post(repo, pr, body);
        const after = readPrThread(repo, pr, { readJson });
        seen = after.comments.filter((c) => String(c?.body ?? '').replace(/\r\n/g, '\n').trimEnd() === body);
        if (!seen.length || !readOperatorRulings(seen, { head }).rulings.length) {
          throw new Error('the ruling comment is not readable by the gate after posting (untrusted author or altered body); the hold remains — inspect the thread before retrying');
        }
      } catch (error) {
        // Clearing rows are already recorded (the F4 order) but the comment did not land readable: they must not stay live.
        if (!clearing.length) throw error;
        throw new Error(`${String(error?.message ?? error)} [${revertNote(clearing, await revertToHold(clearing))}; ${RERUN}]`);
      }
      const holding = events.filter((e) => !clearsHold(e.ruling));
      const holdMiss = holding.length ? await tryAppend(holding) : null;
      if (holdMiss) warn(`ledger-write-miss: block ruling on ${repo}#${pr} was posted but not recorded in the verdict ledger: ${holdMiss}`);
      return { posted: !already, head, url: seen.at(-1)?.url ?? null, ...(holdMiss ? { ledgerWriteMiss: true } : {}) };
    },
  };
}
