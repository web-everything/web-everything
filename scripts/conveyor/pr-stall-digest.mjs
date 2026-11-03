/**
 * @file scripts/conveyor/pr-stall-digest.mjs
 * @description THE PR STALL SWEEP'S OPERATOR DIGEST, slice 3 (operator OK 2026-10-21). After each stall pass, every
 *   `operator` item (a person must decide) is published to the needs-you feed as kind `stalled`, and ONE desktop alert
 *   per pass names the new ones through the shared quiet-hours gate (`gateAlert`, via `notifyDesktopChecked`): held
 *   22:00-07:00 ET and sent by `flushDigest` (which the health PR job runs at the start of every pass) once quiet ends.
 *
 *   Dedupe: one item per `repo#pr@head:state` (a new state on the same head is re-published), and nothing the feed
 *   already published for that PR head under another kind (operator-queue's items) is published again. Self-clearing:
 *   on a complete pass a `stalled` item no longer reported gets a `NEEDS-YOU-CLEARED` line; an incomplete pass clears
 *   nothing. Disabling the producer clears its published items and releases queue suppression under the feed lock.
 *   NEVER SUPPRESSED ON A FAILED READ: when the feed state cannot be read, the alert still goes out, undeduped.
 *   An alert that fails to send is retried next pass. Each item: reason, 1-3 evidence lines, one paste-ready command.
 *   Setting `prStallSweep.digest` (standard true) turns it off; the quiet hours are the shared `quietHours` settings.
 */
import { mkdirSync, readFileSync, realpathSync, readlinkSync, statSync } from 'node:fs';
import { dirname, join, resolve, basename, sep } from 'node:path';
import { writeJsonAtomic, withFileLock } from '../lib/atomic-json-file.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { diffFeed, appendLines, checkedFeedPath, sidecarsOf, REPORT_KINDS, resolveSettings as feedSettings } from '../operations/needs-you-feed.mjs';
import { notifyDesktopChecked } from './branch-sync.mjs';
import { repeatDue, labelNames } from './pr-sweep-core.mjs';
import { sortUnblockersFirst } from './pr-blocked-by.mjs';
import { isUnderTest } from '../lib/under-test.mjs';

export const STALLED_KIND = 'stalled';
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e?.code === 'ENOENT') return fallback; throw e; } };

// Resolve existing ancestors too: a new feed below a symlinked directory still targets that directory's real tree.
function canonicalPath(path) {
  path = resolve(path);
  try { return realpathSync(path); }
  catch (e) {
    if (e?.code !== 'ENOENT' || dirname(path) === path) throw e;
    // realpath cannot resolve a dangling symlink, but appendFileSync will follow it once its target is created.
    let link;
    try { link = readlinkSync(path); }
    catch (error) { if (!['ENOENT', 'EINVAL'].includes(error?.code)) throw error; }
    if (link !== undefined) return canonicalPath(resolve(dirname(path), link));
    return join(canonicalPath(dirname(path)), basename(path));
  }
}
function checkedDigestFeedPath(feedPath, env, stateDir) {
  const path = checkedFeedPath(feedPath ?? feedSettings({ env }).path.value);
  const target = canonicalPath(path), dir = canonicalPath(stateDir), lexicalDir = resolve(stateDir);
  // Compare case-folded and NFC-normalized: a case-insensitive or normalizing filesystem resolves spellings JS keeps apart.
  const fold = (file) => file.normalize('NFC').toLowerCase();
  const within = (file, root) => fold(file) === fold(root) || fold(file).startsWith(`${fold(root)}${sep}`);
  const names = ['digest-state.json', 'digest.lock'];
  const metadata = names.map(name => canonicalPath(join(stateDir, name)));
  // A hard link shares the inode with its metadata file and resolves to its own path: compare identity when both exist.
  const sameFile = (a, b) => { try { const x = statSync(a), y = statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; } };
  if (within(path, lexicalDir) || within(target, dir) || metadata.some(file => fold(file) === fold(target) || sameFile(file, target))) throw new Error('feed path is reserved for stall digest state');
  return path;
}

/** Clear a disabled producer's events before relinquishing suppression, under both publishers' shared feed lock. */
function releaseStalledSuppression({ feedPath, env, stateDir, errors, now }) {
  let lines = [];
  try {
    const path = checkedDigestFeedPath(feedPath, env, stateDir);
    const sidecar = sidecarsOf(path).state;
    mkdirSync(dirname(sidecar), { recursive: true });
    withFileLock(`${sidecar}.lock`, () => {
      const prev = readJson(sidecar, { openKeys: [] });
      if (!Array.isArray(prev?.openKeys)) throw new Error('feed state has no openKeys');
      const cleared = diffFeed(prev.openKeys, [], now, { clearKinds: new Set([STALLED_KIND]) });
      // Append first: if publication fails, keep the keys so the next disabled pass retries the clear.
      appendLines(path, cleared.lines);
      lines = cleared.lines;
      if (cleared.openKeys.length !== prev.openKeys.length) writeJsonAtomic(sidecar, { ...prev, openKeys: cleared.openKeys });
    });
  } catch (e) { errors.push(`stalled feed: ${String(e?.message ?? e).split('\n')[0]}`); }
  return { lines, fresh: [], notified: false, errors, skipped: 'digest off' };
}

/** The one paste-ready command: the sweep's next action with the operator's login and this channel filled in. PURE. */
export function pasteReady(item) {
  const login = OPERATOR_LOGINS[0] ?? 'operator';
  const view = `gh pr view ${item.pr} --repo ${item.repo} --comments`;
  const cmd = (typeof item.command === 'string' && item.command.trim() ? item.command : view).replace(/<your login>/g, login).replace(/<where you ruled>|<where>/g, 'needs-you-feed');
  // A command still holding a choice (`<block|not-real>`, `<fix-list.md>`) is not paste-ready: the inspection command is.
  return /<[^>]*>/.test(cmd) ? view : cmd;
}

/** A sweep item as a feed item. PURE. */
export function feedItem(i) {
  const ev = (Array.isArray(i.evidence) ? i.evidence : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 3).map((x) => x.slice(0, 160));
  const command = pasteReady(i);
  const relations = [...(i.blockedBy ?? []).map(n => `blocked-by #${n}`), ...(i.unblocks ?? []).map(n => `unblocks #${n}`)].join('; ');
  return { pr: i.pr, repo: i.repo, head: String(i.head ?? '').toLowerCase(), kind: STALLED_KIND, state: i.state,
    reason: `${relations ? `${relations}; ` : ''}${i.state}: ${String(i.reason ?? '').replace(/\s+/g, ' ')}`, title: i.title ?? '', command,
    ...(command !== i.command && typeof i.command === 'string' ? { template: i.command.slice(0, 400) } : {}),
    ...(i.labels !== undefined ? { labels: labelNames(i) } : {}),
    ...(i.blockedBy !== undefined ? { blockedBy: i.blockedBy } : {}),
    ...(i.unblocks !== undefined ? { unblocks: i.unblocks } : {}),
    ...(i.owner !== undefined ? { owner: i.owner } : {}),
    ...(i.nextAction !== undefined ? { nextAction: i.nextAction } : {}),
    ...(i.deadline !== undefined ? { deadline: i.deadline } : {}),
    ...(i.violation !== undefined ? { violation: i.violation } : {}),
    evidence: ev.length ? ev : [`waiting state ${i.state}; next: ${i.action ?? 'a person decides'}`] };
}
const feedKey = (f) => `${f.repo}#${f.pr}@${f.head}:${STALLED_KIND}`;
/** `repo#pr@head:state` -> the feed key of that head's `stalled` item (the state may itself contain `:`). */
const feedKeyOfId = (x) => { const at = x.lastIndexOf('@'); return `${x.slice(0, at)}@${x.slice(at + 1).split(':')[0]}:${STALLED_KIND}`; };

// Keep legacy state strings (and their persisted repeat fingerprints) unchanged.
// Deadline timestamps may move each tick; only crossing the deadline changes identity.
function updateIdentity(f, now) {
  if (['violation', 'nextAction', 'blockedBy', 'unblocks', 'deadline'].every(k => f[k] === undefined)) return f.state;
  const deadline = Date.parse(f.deadline);
  const bucket = Number.isFinite(deadline) ? (now > deadline ? 'passed' : 'pending') : 'unknown';
  return JSON.stringify([f.state, f.violation, f.nextAction, f.blockedBy, f.unblocks, bucket]);
}

/**
 * Publish one pass's operator items. Returns `{lines, fresh, notified, errors}`. Never throws.
 * @param {{items:object[], incomplete:boolean, settingsUnreadable?:boolean}} pass  the `runStallSweep` result
 * @param {{now?:number, env?:object, feedPath?:string, stateDir:string, notify?:Function, enabled?:boolean}} o
 */
export function publishStalledDigest(pass, { now = Date.now(), env = process.env, feedPath, stateDir, notify = notifyDesktopChecked, enabled = true, alertBackoffMinutes } = {}) {
  const errors = [];
  if (isUnderTest(env) && !feedPath) return { lines: [], fresh: [], notified: false, errors, skipped: 'under-test' }; // never the real feed
  // Unknown policy is not an explicit disable: preserve open items, suppression and alert obligations until recovery.
  if (pass?.settingsUnreadable) return { lines: [], fresh: [], notified: false, errors, skipped: 'settings unreadable' };
  if (!enabled) return releaseStalledSuppression({ feedPath, env, stateDir, errors, now });
  if (!Array.isArray(pass?.items)) return { lines: [], fresh: [], notified: false, errors, skipped: 'no pass' };
  const items = sortUnblockersFirst(pass.items.filter((i) => i.lane === 'operator').map(feedItem));
  // A feed configured as digest.lock may already contain events. Reject it before lock recovery can reclaim it.
  try { checkedDigestFeedPath(feedPath, env, stateDir); }
  catch { return deliver(items, pass, { now, env, feedPath, stateDir, notify, errors, alertBackoffMinutes, unlocked: true }); }
  // One delivery at a time: selection, sending and confirmation run under one lock, so two overlapping passes can never
  // both send the same owed alert. If the lock cannot be taken, every item is alerted (a repeat, never a drop).
  try { mkdirSync(stateDir, { recursive: true }); return withFileLock(join(stateDir, 'digest.lock'), () => deliver(items, pass, { now, env, feedPath, stateDir, notify, errors, alertBackoffMinutes })); }
  catch (e) { errors.push(`digest lock: ${String(e?.message ?? e).split('\n')[0]}`); return deliver(items, pass, { now, env, feedPath, stateDir, notify, errors, alertBackoffMinutes, unlocked: true }); }
}

function deliver(items, pass, { now, env, feedPath, stateDir, notify, errors, alertBackoffMinutes, unlocked = false }) {
  let lines = []; let fresh = items; let lock = null;
  const id = (f) => `${f.repo}#${f.pr}@${f.head}:${f.state}`;
  const mine = join(stateDir, 'digest-state.json');
  try {
    // Validate before assigning the confirmation lock: a rejected feed must never mutate our state, even after an alert.
    const path = checkedDigestFeedPath(feedPath, env, stateDir);
    if (unlocked) throw new Error('delivery lock unavailable');
    const sidecar = sidecarsOf(path).state;
    mkdirSync(dirname(sidecar), { recursive: true }); mkdirSync(stateDir, { recursive: true });
    lock = `${sidecar}.lock`;
    ({ lines, fresh } = withFileLock(lock, () => {
      const prev = readJson(sidecar, { openKeys: [] });
      const saved = readJson(mine, { published: [], unnotified: [] });
      if (!Array.isArray(prev?.openKeys)) throw new Error('feed state has no openKeys');
      // Already published for this PR head under another kind (operator-queue's item): not published twice.
      // Only operator-queue's report kinds count: an event-only key (review-no-verdict, disk-space) asks something else.
      const other = prev.openKeys.filter((k) => REPORT_KINDS.has(k.slice(k.lastIndexOf(':') + 1)));
      const mineNow = items.filter((f) => !other.some((k) => k.startsWith(`${f.repo}#${f.pr}@${f.head}:`)));
      // The FEED shows each open head's current state and invariant/dependency identity. A change drops the
      // old key so the diff re-publishes the head with the current reason and command. The ALERT identity is
      // repo#pr@head:state. Legacy consumers alert once (A -> B -> A alerts A once); configured sweeps repeat with backoff and reset on movement.
      const shown = Object.fromEntries(Object.entries(saved.current ?? {}).filter(([k]) => prev.openKeys.includes(k)));
      const alerted = new Set((saved.published ?? []).filter((x) => prev.openKeys.includes(feedKeyOfId(x))));
      const changed = new Set(mineNow.filter((f) => prev.openKeys.includes(feedKey(f)) && shown[feedKey(f)] !== updateIdentity(f, now)).map(feedKey));
      const r = diffFeed(prev.openKeys.filter((k) => !changed.has(k)), mineNow, now, { incomplete: !!pass.incomplete, clearKinds: new Set([STALLED_KIND]) });
      const open = new Set(r.openKeys);
      const written = mineNow.filter((f) => r.lines.some((l) => l.startsWith(`NEEDS-YOU ${f.repo}#${f.pr} ${STALLED_KIND}:`)));
      const newly = written.filter((f) => !alerted.has(id(f)));
      const repeats = Object.fromEntries(Object.entries(saved.repeats ?? {}).filter(([k]) => open.has(feedKeyOfId(k))));
      const fingerprint = f => JSON.stringify([updateIdentity(f, now), f.labels]);
      // Persisted one-shot ids carry no send time. Start a bounded clock on migration instead of flooding.
      if (alertBackoffMinutes) for (const f of mineNow) {
        if (changed.has(feedKey(f))) {
          for (const key of Object.keys(repeats)) if (feedKeyOfId(key) === feedKey(f)) delete repeats[key];
        }
        if (!changed.has(feedKey(f)) && alerted.has(id(f)) && !(saved.unnotified ?? []).includes(id(f)) && !repeats[id(f)]) repeats[id(f)] = { lastAlertAt: now, alertCount: 1, fingerprint: fingerprint(f) };
      }
      const due = mineNow.filter(f => alertBackoffMinutes && repeats[id(f)] &&
        (repeats[id(f)].fingerprint !== fingerprint(f) || repeatDue(repeats[id(f)], now, alertBackoffMinutes)));
      // State transitions reset repeats, including a return to a previously seen state.
      for (const f of mineNow) {
        if (changed.has(feedKey(f)) && (alertBackoffMinutes || updateIdentity(f, now) !== f.state
          || shown[feedKey(f)]?.startsWith('['))) due.push(f);
      }
      // Owed alerts from a failed send are retried until delivered or resolved, even across an incomplete pass.
      const pending = new Set((saved.unnotified ?? []).filter((x) => open.has(feedKeyOfId(x))));
      const toAlert = mineNow.filter((f) => newly.includes(f) || pending.has(id(f)) || due.includes(f));
      const unnotified = [...new Set([...pending, ...toAlert.map(id)])];
      // Our own record goes first, marking every alert owed until confirmed; what the feed shows is recorded only once
      // its line is written. A failed save can repeat a line or an alert, never drop one.
      writeJsonAtomic(mine, { published: [...alerted], current: shown, unnotified, repeats });
      appendLines(path, r.lines);
      writeJsonAtomic(sidecar, { ...prev, openKeys: r.openKeys });
      for (const f of newly) alerted.add(id(f));
      for (const f of written) shown[feedKey(f)] = updateIdentity(f, now);
      const keep = (k) => open.has(k);
      writeJsonAtomic(mine, { published: [...alerted].filter((x) => keep(feedKeyOfId(x))), current: Object.fromEntries(Object.entries(shown).filter(([k]) => keep(k))), unnotified, repeats });
      return { lines: r.lines, fresh: toAlert };
    }));
  } catch (e) {
    // Never suppressed on a failed read: without the feed state there is no dedupe, so every item is alerted.
    errors.push(`stalled feed: ${String(e?.message ?? e).split('\n')[0]}`);
    fresh = items;
  }
  let notified = false;
  if (fresh.length) {
    const body = fresh.slice(0, 5).map((f) => `${f.repo.split('/').pop()}#${f.pr} ${f.state} ${(f.blockedBy ?? []).map(n => `blocked-by #${n}`).join(' ')} ${(f.unblocks ?? []).map(n => `unblocks #${n}`).join(' ')}`).join(' | ') + (fresh.length > 5 ? ` (+${fresh.length - 5} more)` : '');
    let out = null;
    try { out = notify({ title: `PR stall sweep: ${fresh.length} need you`, body }); } catch (e) { out = { ok: false, error: e?.message }; }
    notified = out?.ok === true;
    if (!notified) errors.push(`stalled alert: ${out?.error ?? 'not sent'}`);
    // Delivered: no longer owed (best effort; a failed save only repeats the alert next pass).
    // Under the same lock, re-read: another pass may have saved newer state meanwhile; only the delivered ids are removed.
    else if (lock) {
      try { withFileLock(lock, () => { const cur = readJson(mine, { published: [], unnotified: [] });
        const repeats = { ...cur.repeats };
        if (alertBackoffMinutes) for (const f of fresh) {
          const fingerprint = JSON.stringify([updateIdentity(f, now), f.labels]);
          const prior = repeats[id(f)];
          repeats[id(f)] = { fingerprint, lastAlertAt: now, alertCount: (prior?.fingerprint === fingerprint ? prior.alertCount : 0) + 1 };
        }
        writeJsonAtomic(mine, { ...cur, repeats, unnotified: (cur.unnotified ?? []).filter((x) => !fresh.some((f) => id(f) === x)) }); }); }
      catch (e) { errors.push(`digest state: ${e.message}`); }
    }
  }
  return { lines, fresh, notified, errors };
}
