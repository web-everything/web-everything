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
  if (/^we:backlog\/[^/]+\.md$/.test(ask)) ref = ask;
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
  if (!ref) return { requested: ask, ref: null, readable: false, reason: 'not a card id or we:backlog/<file>.md reference' };
  const ok = readable(ref, root);
  return { requested: ask, ref, readable: ok, reason: ok ? 'readable' : 'card file is missing or has no frontmatter' };
}

export function createRecordReferralRulingReader({ root = REPO_ROOT, readJson = ghJson, now = () => new Date().toISOString(),
  env = process.env, readable = referralCardReadable } = {}) {
  return ({ repo, pr, card }) => {
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

export function createRecordReferralRulingSinks({ readJson = ghJson,
  readPr = (repo, pr) => readJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,labels']),
  runSetLabel = execFileSync,
  setLabels = (...args) => execFileSyncThrottled('gh', args,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }),
  post = (repo, pr, body) => execFileSyncThrottled('gh',
  ['pr', 'comment', String(pr), '--repo', repo, '--body', body], { encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }) } = {}) {
  return {
    [OPERATOR_RULING_FOLLOW_UP_EFFECT]: async ({ repo, pr, head, action, body, actor, channel }) => {
      const before = await readPr(repo, pr);
      if (before.headRefOid !== head) throw new Error(`PR #${pr}'s head moved to ${before.headRefOid} since the plan (${head}); nothing changed — re-run against the new head`);
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
      return { action, sentBack, labelCleared };
    },
    [OPERATOR_RULING_POST_EFFECT]: async ({ repo, pr, head, body }) => {
      const before = readPrThread(repo, pr, { readJson });
      if (before.headRefOid !== head) throw new Error(`PR #${pr}'s head moved to ${before.headRefOid} since the plan (${head}); nothing posted — re-run against the new head`);
      const already = before.comments.some((c) => String(c?.body ?? '').replace(/\r\n/g, '\n').trimEnd() === body);
      if (!already) post(repo, pr, body);
      const after = readPrThread(repo, pr, { readJson });
      const seen = after.comments.filter((c) => String(c?.body ?? '').replace(/\r\n/g, '\n').trimEnd() === body);
      if (!seen.length || !readOperatorRulings(seen, { head }).rulings.length) {
        throw new Error('the ruling comment is not readable by the gate after posting (untrusted author or altered body); the hold remains — inspect the thread before retrying');
      }
      return { posted: !already, head, url: seen.at(-1)?.url ?? null };
    },
  };
}
