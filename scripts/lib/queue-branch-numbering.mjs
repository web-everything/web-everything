/** Queue numbering: post-land batches and legacy branch preparation share one numbering mutex. */
import { isTransientReadFailure } from './drain-api-reads.mjs';
import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, relative, isAbsolute } from 'node:path';
import { isHash, isNum, idFromName, applyLedger, mapHashReferences } from '../backlog/id.mjs';
import { numberPendingHashes, normalizeFlowAckCardRefs, rewriteSoakCardCitation } from '../lane-drain.mjs';
import { withNumberingLock } from '../readiness/drain-lock.mjs';
import { queueStatePath } from './drain-merge-strategy.mjs';
import { workflowEditHold } from './merge-queue-enqueue.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';
import { cascadePolicy, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { SETTINGS_DIR } from './settings-files.mjs';

const SETTING = 'scripts/settings/merge-queue-numbering.json';
const ENV = 'WE_MQ_NUMBER_CARDS_BEFORE_ENQUEUE';
const lines = (value) => Array.isArray(value) ? value : String(value).split(/\r?\n/).filter(Boolean);
const cardId = (path) => idFromName(basename(path, '.md'));
const jitSubject = /^drain: JIT-number (.+) at land \(#2288\)$/;
/**
 * Identity allowlist comes only from already accepted main, never from the PR.
 * Do not cap the commit count: newer assignments by another author must not expire
 * an established drain identity. Bound the read by time and output size instead.
 */
export function trustedDrainAuthors({ cwd = process.cwd(), exec = execFileSync } = {}) {
  try {
    // A recent-commit cutoff would revoke an established author when another drain
    // identity numbers 100 cards. Bound the read by time and bytes instead.
    const history = exec('git', ['log', '--grep=^drain: JIT-number ', '--format=%an%x00%ae%x00%s', 'origin/main'], { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return new Set(lines(history).flatMap(line => {
      const [name, email, subject] = line.split('\0');
      return name && email && jitSubject.test(subject ?? '') ? [`${name}\0${email}`] : [];
    }));
  } catch { return new Set(); }
}

export function trustedDrainSubject(commit, authors) {
  return commit && authors?.has(`${commit.author?.name}\0${commit.author?.email}`)
    && jitSubject.test(commit.subject ?? '') ? commit.subject : null;
}
export const hashBacklogFiles = (files) => lines(files).filter((p) => /^backlog\/[^/]+\.md$/.test(p) && isHash(cardId(p)));
export const isMergeGroupCiRun = (env = process.env) => env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'merge_group';
/** Temporary ids are unconditionally refused in merge-group CI, independent of drain settings. */
export function mergeGroupHashRefusals({ env = process.env, files, numberCardsBeforeEnqueue = resolveQueueNumbering({ env }).value }) {
  if (!isMergeGroupCiRun(env)) return [];
  // Post-merge numbering: with numberCardsBeforeEnqueue off, hash cards land under their temporary id and the
  // drain numbers them on main afterwards, so the group may carry them. Any other state fails closed.
  if (numberCardsBeforeEnqueue === false) return [];
  return hashBacklogFiles(files).map((file) => `Backlog file "${file}" would land on main with a NON-NUMERIC leading id — a temporary (hash) id can never enter main through the merge queue while the drain numbers cards on the PR branch before enqueue. This merge group is refused`);
}

export const BRANCH_NUMBERING_CI_CONTRACT = 'drain-branch-numbering-ci-v1';

export function mainAcceptsBranchNumbering({ cwd = process.cwd(), exec = execFileSync } = {}) {
  try {
    return String(exec('git', ['show', 'origin/main:scripts/lib/queue-branch-numbering.mjs'], { cwd, encoding: 'utf8', stdio: 'pipe' })).includes(BRANCH_NUMBERING_CI_CONTRACT);
  } catch { return false; }
}

/**
 * Birth hash → number pairs the drain assigned on this branch. A later collision-heal commit that moves a
 * drain-assigned number (`#5979→#5321`) carries the pair to the new number; a heal never exempts a number
 * the drain did not assign first (PR #5042: xaxezem→#5979 by the drain, then #5979→#5321 by the heal).
 * Heal subjects: nnn-collision-heal.mjs / pr-land.mjs (`(#a→#b, #c→#d)`) and rebase-drop-manifest.mjs
 * (`, renumber #a→#b/#c→#d`). Walked parents-first (`--topo-order --reverse`), never by commit date.
 */
export function drainNumberedPairs({ cwd, exec = execFileSync, base = 'origin/main' }) {
  try {
    const authors = trustedDrainAuthors({ cwd, exec });
    const subjects = exec('git', ['log', '--topo-order', '--reverse', '--format=%an%x00%ae%x00%s', `${base}..HEAD`], { cwd, encoding: 'utf8', stdio: 'pipe' });
    let pairs = new Set();
    for (const line of lines(subjects)) {
      const [name, email, text = ''] = line.split('\0');
      // Only a drain commit by an author accepted `main` already trusts can ASSIGN a pair. A heal subject only
      // moves a pair that assignment already produced, so it can never exempt a number the drain did not hand out.
      const subject = trustedDrainSubject({ author: { name, email }, subject: text }, authors);
      const match = subject?.match(/^drain: JIT-number (.+) at land \(#2288\)$/);
      if (match) {
        for (const assignment of match[1].split(', ')) {
          const pair = assignment.match(/^(x[0-9a-z]{6})→#(\d+)$/);
          if (pair) pairs.add(`${pair[1]}→${Number(pair[2])}`);
        }
        continue;
      }
      const heal = text.match(/^backlog: heal new-item id collision\(s\) (?:pre-check|on land) \((.+)\) \(#(?:2222|2071)\)$/)
        || text.match(/^drain: rebase .+, renumber (#\d+→#\d+(?:\/#\d+→#\d+)*)$/);
      if (!heal) continue;
      const moves = new Map();
      for (const move of heal[1].split(/, |\//)) {
        const m = move.match(/^#(\d+)→#(\d+)$/);
        if (m) moves.set(Number(m[1]), Number(m[2]));
      }
      pairs = new Set([...pairs].map((pair) => {
        const [hash, num] = pair.split('→');
        return moves.has(Number(num)) ? `${hash}→${moves.get(Number(num))}` : pair;
      }));
    }
    return pairs;
  } catch { return new Set(); }
}

/** drain-branch-numbering-ci-v1: exempt only birth hashes paired with their drain-recorded number. */
export function exemptDrainNumberedItems(items, { drainNumbered }) {
  return items.filter((item) => !(isHash(item.bornAs) && drainNumbered.has(`${item.bornAs}→${Number(item.num)}`)));
}

const boolean = (v) => ({ on: true, true: true, 1: true, off: false, false: false, 0: false })[String(v).toLowerCase()];

export function resolveQueueNumbering({ env = process.env, readFile = nodeFs.readFileSync } = {}) {
  let value = true, source = 'default';
  const invalid = [];
  const apply = (raw, from) => {
    if (raw === undefined) return;
    const parsed = boolean(raw);
    if (typeof parsed !== 'boolean') invalid.push(`${from}=${String(raw)} ignored (expected on/off/true/false/1/0)`);
    else { value = parsed; source = from; }
  };
  try { apply(JSON.parse(readFile(join(SETTINGS_DIR, 'merge-queue-numbering.json'), 'utf8'))?.mergeQueue?.numberCardsBeforeEnqueue, SETTING); }
  catch (e) { if (e.code !== 'ENOENT') invalid.push(`${SETTING} unreadable: ${e.message}`); }
  apply(env[ENV], ENV);
  return { value, source, invalid };
}

export function logQueueNumbering(setting = resolveQueueNumbering(), log = process.stderr) {
  log.write(`merge-queue: numberCardsBeforeEnqueue=${setting.value ? 'on' : 'off'} (${setting.source})\n`);
  for (const message of setting.invalid) log.write(`  ⚠ ${message}\n`);
  return setting.value;
}

export function reservationPlan(mainFiles, reservations, isOpen) {
  const mainIds = new Set(lines(mainFiles).filter((p) => /^backlog\/[^/]+\.md$/.test(p)).map(cardId).filter(isNum).map(Number));
  const kept = reservations.filter((r) => !r.nnns.every((n) => mainIds.has(Number(n))) && isOpen(r.repo, r.num) !== false);
  const max = [...mainIds, ...kept.flatMap((r) => r.nnns.map(Number))].reduce((m, n) => Math.max(m, n), 0);
  return { reservations: kept, minNext: max + 1 };
}

function readReservations(fs, path) {
  try {
    const state = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!Array.isArray(state?.reservations) || state.reservations.some((r) => !r || !Number.isInteger(r.num) || r.num <= 0 ||
      !(r.repo === null || typeof r.repo === 'string') || typeof r.headRef !== 'string' || typeof r.at !== 'string' ||
      !Array.isArray(r.nnns) || r.nnns.some((n) => !/^\d+$/.test(String(n)) || !Number.isSafeInteger(Number(n)) || Number(n) < 1))) throw new Error('invalid reservation schema');
    return state.reservations;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`reservation state unreadable (${path}): ${e.message}; left untouched`);
  }
}

/** Unknown/missing repo listings retain reservations; a narrowed --only listing is not proof of closure. */
export function openReservationPr(context, repo, num) {
  const prs = context?.prsByRepo?.get(repo);
  if (!prs) return undefined;
  if (prs.some((p) => Number(p.number) === Number(num))) return true;
  return context.contextComplete ? false : undefined;
}

const hooksDisabledEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' };

/** Synchronous scope: imported numbering helpers spawn git with the inherited environment. */
export function withHooksDisabled(fn) {
  const previous = Object.fromEntries(Object.keys(hooksDisabledEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, hooksDisabledEnv);
  try { return fn(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const numberingStatePath = () => join(dirname(queueStatePath()), 'drain-merge-queue-numbering.json');
const safeGit = (exec, cwd, trim = true) => (args, root = cwd, env = {}) => {
  const out = String(exec('git', args, {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...env, ...hooksDisabledEnv },
}));
  return trim ? out.trim() : out;
};

/** Caller holds the numbering mutex and has refreshed origin/main. Unknown PRs retain reservations. */
export function fallbackMinNext({ cwd = process.cwd(), exec = execFileSync, fs = nodeFs, statePath = numberingStatePath() } = {}) {
  const files = safeGit(exec, cwd)(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'backlog/']);
  return reservationPlan(files, readReservations(fs, statePath), () => undefined).minNext;
}

/** Reject both a symlinked card and a symlinked parent before any PR-content IO. */
export function assertWorktreeCard(worktree, path, fs = nodeFs) {
  const allowed = /^backlog\/[^/]+\.md$/.test(path) || /^backlog\/raised-by\/\d+\/[A-Za-z0-9._-]+\.md$/.test(path);
  if (!allowed || path.includes('..') || path.includes('\0')) throw new Error('unsafe backlog card path');
  if (fs.lstatSync(join(worktree, 'backlog')).isSymbolicLink() || fs.lstatSync(join(worktree, path)).isSymbolicLink()) throw new Error(`symlinked backlog card refused: ${path}`);
  assertWorktreeFile(worktree, path, fs);
}

function assertWorktreeFile(worktree, path, fs) {
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.includes('\0')) || path.startsWith('/')) throw new Error('unsafe tracked path');
  for (let i = 1; i <= parts.length; i++) {
    const target = join(worktree, ...parts.slice(0, i));
    let stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      // WE tracks convenience directory links (.claude/skills and agent-memory).
      // Only those directory links may survive; their full resolved target is confined.
      const directoryLink = ['.claude/skills', '.claude/agent-memory'].includes(parts.slice(0, i).join('/'));
      if (!directoryLink) throw new Error(`symlinked tracked path refused: ${path}`);
      const rel = relative(fs.realpathSync(worktree), fs.realpathSync(target));
      if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`symlinked path escapes worktree: ${path}`);
      stat = fs.statSync(target);
      if (!stat.isDirectory()) throw new Error(`symlinked non-directory refused: ${path}`);
      if (i === parts.length) continue;
    }
    if (i === parts.length ? !stat.isFile() : !stat.isDirectory()) throw new Error(`non-regular tracked path refused: ${path}`);
  }
}

const numberingFailures = new Map();

export function resolvePostMergeNumbering({ env = process.env, readFile = nodeFs.readFileSync, platform } = {}) {
  let tool;
  try { tool = JSON.parse(readFile(join(SETTINGS_DIR, 'merge-queue-numbering.json'), 'utf8'))?.mergeQueue; }
  catch { /* Invalid or missing tool settings retain the bounded standard defaults. */ }
  const maxPending = env.WE_MQ_POST_MERGE_MAX_PENDING;
  const maxAge = env.WE_MQ_POST_MERGE_MAX_AGE_MINUTES;
  const idle = env.WE_MQ_POST_MERGE_WHEN_QUEUE_IDLE;
  return cascadePolicy('postMergeNumbering', tool?.postMergeNumbering, {
    standard: { maxPending: 5, maxAgeMinutes: 10, whenQueueIdle: true },
    platform, env,
    envValues: Object.fromEntries([
      ['maxPending', maxPending === undefined ? undefined : Number(maxPending)],
      ['maxAgeMinutes', maxAge === undefined ? undefined : Number(maxAge)],
      ['whenQueueIdle', idle === undefined ? undefined : (boolean(idle) ?? idle)],
    ].filter(([, v]) => v !== undefined)),
    valid: { maxPending: v => Number.isInteger(v) && v > 0 && v <= 1000,
      maxAgeMinutes: v => Number.isFinite(v) && v > 0 && v < 30, whenQueueIdle: v => typeof v === 'boolean' },
  });
}

export function logPostMergeNumbering(setting = resolvePostMergeNumbering(), log = process.stderr) {
  log.write(`${formatCascadeSourcesLine('mergeQueue.postMergeNumbering', setting)}\n`);
  return setting.value;
}

export function shouldNumberLandedHashes({ pending, queueIdle, now = Date.now(), settings }) {
  if (!Array.isArray(pending) || !pending.length) return false;
  if (settings.whenQueueIdle && queueIdle === true) return true;
  if (pending.length >= settings.maxPending) return true;
  return pending.some(p => Number.isFinite(p.landedAt) && now - p.landedAt >= settings.maxAgeMinutes * 60_000);
}

/** First appearance in first-parent history, including additions in merge commits. */
function landedHashes(git, files) {
  const history = git(['log', '--first-parent', '--reverse', '--diff-merges=first-parent', '--diff-filter=A',
    '--format=@%ct', '--name-only', 'origin/main', '--', 'backlog/']);
  const wanted = new Set(files.map(cardId)), seen = new Set(), pending = [];
  let landedAt;
  for (const line of lines(history)) {
    if (/^@\d+$/.test(line)) { landedAt = Number(line.slice(1)) * 1000; continue; }
    const hash = cardId(line);
    if (wanted.has(hash) && !seen.has(hash)) { seen.add(hash); pending.push({ hash, landedAt }); }
  }
  if (seen.size !== wanted.size) throw new Error('incomplete first-parent landing history; retry or inspect main history');
  return pending;
}

/** Only the shared numberer's documented rename/reference homes may be published. */
function assertNumberingDiff(git, worktree, assigned, rawGit, droppedDuplicates = []) {
  const changes = lines(git(['diff', '--name-status', '--no-renames', 'origin/main', 'HEAD', '--'], worktree));
  if (changes.length > 1024) throw new Error('numbering diff exceeds 1024 paths; inspect the full batch manually');
  const referencePath = /^(?:docs\/agent\/[^/]+\.md|agent-memory-src\/[^/]+\.md|scripts\/conveyor\/flows\/[^/]+\.flow\.json|scripts\/conveyor\/soak\/breaks\/(?!.*\.test\.mjs$)[^/]+\.mjs)$/;
  const ledger = {};
  for (const { hash, nnn } of assigned ?? []) {
    if (!isHash(hash) || !/^\d+$/.test(nnn)) throw new Error('invalid numbering assignment evidence');
    ledger[hash] = nnn;
  }
  // Verify historical reference rewrites against the durable main-tree birth record, never a local ledger.
  const historical = new Map();
  const resolve = hash => {
    if (ledger[hash] !== undefined) return ledger[hash];
    if (!historical.has(hash)) {
      if (historical.size >= 1024) throw new Error('numbering reference lookup limit exceeded; inspect the full batch manually');
      let matches;
      try { matches = lines(git(['grep', '-l', '-E', `^bornAs: ${hash}$`, 'origin/main', '--', 'backlog/'])); }
      catch (e) {
        if (e.status === 1 && !String(e.stderr ?? '').trim()) matches = [];
        else throw e;
      }
      if (matches.length > 1) throw new Error(`ambiguous birth record: ${hash}`);
      const num = matches[0]?.match(/^origin\/main:backlog\/(\d+)-[^/]+\.md$/)?.[1];
      if (matches.length && !num) throw new Error(`unreadable birth record: ${hash}`);
      historical.set(hash, num ?? hash);
    }
    return historical.get(hash);
  };
  const parsed = changes.map(line => {
    const [status, path, extra] = line.split('\t');
    if (!/^[AMD]$/.test(status) || !path || extra || path.split('/').some(p => p === '.' || p === '..'))
      throw new Error('unreadable numbering diff evidence');
    if (!/^backlog\/[^/]+\.md$/.test(path) && !referencePath.test(path))
      throw new Error(`numbering path outside rewrite scope: ${path}`);
    return { status, path };
  });
  const additions = new Set(parsed.filter(p => p.status === 'A').map(p => p.path));
  for (const { status, path } of parsed) {
    if (status === 'A') {
      const hash = Object.keys(ledger).find(h => ledger[h] === cardId(path));
      const old = hash && path.replace(/^(backlog\/)\d+/, `$1${hash}`);
      if (!old || !parsed.some(p => p.status === 'D' && p.path === old))
        throw new Error(`numbering addition is not a backlog rename: ${path}`);
      continue;
    }
    const before = rawGit(['show', `origin/main:${path}`], worktree);
    const backlog = path.startsWith('backlog/');
    const duplicate = droppedDuplicates.find(d => `backlog/${d.stem}.md` === path);
    if (status === 'D' && duplicate) {
      if (!/^backlog\/\d+-[^/]+\.md$/.test(duplicate.existing) || !isHash(duplicate.hash) ||
          cardId(path) !== duplicate.hash || resolve(duplicate.hash) !== cardId(duplicate.existing))
        throw new Error(`unverified duplicate deletion: ${path}`);
      const original = rawGit(['show', `origin/main:${duplicate.existing}`], worktree);
      const body = text => text.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      if (body(before) !== body(original)) throw new Error(`different duplicate body: ${path}`);
      continue;
    }
    const name = backlog ? basename(path, '.md') : path;
    let expected;
    if (path.startsWith('scripts/conveyor/soak/breaks/')) expected = rewriteSoakCardCitation(before, resolve);
    else {
      const resolved = mapHashReferences(before, resolve);
      const plan = applyLedger([{ name, content: resolved }], ledger);
      expected = plan.rewrites[0]?.content ?? resolved;
      if (path.endsWith('.flow.json')) expected = normalizeFlowAckCardRefs(expected);
    }
    let target = path;
    if (status === 'D') {
      const hash = cardId(path);
      if (!backlog || ledger[hash] === undefined) throw new Error(`unexpected numbering deletion: ${path}`);
      target = path.replace(/^(backlog\/)x[0-9a-z]{6}/, `$1${ledger[hash]}`);
      if (!additions.has(target)) throw new Error(`incomplete numbering rename: ${path}`);
    }
    if (expected !== rawGit(['show', `HEAD:${target}`], worktree))
      throw new Error(`non-reference numbering change: ${path}; inspect rewrite before retrying`);
  }
}

/** Serialized, best-effort post-land writer. A rejected stale base is rebuilt, never force-pushed. */
export function numberLandedHashesOnMain({ cwd = process.cwd(), exec = execFileSync, fs = nodeFs,
  statePath = numberingStatePath(), lock = withNumberingLock, number = numberPendingHashes, log = process.stderr,
  failureState = numberingFailures.get(cwd) ?? { consecutiveFailures: 0 }, maxConsecutiveFailures = 3,
  maxPushAttempts = 3, settings, queueIdle = false, now = Date.now(), emit = appendDaemonEvent } = {}) {
  numberingFailures.set(cwd, failureState);
  return withHooksDisabled(() => {
    const git = safeGit(exec, cwd);
    let temporary;
    const cleanup = () => {
      if (!temporary) return;
      try { git(['worktree', 'remove', '--force', join(temporary, 'tree')]); }
      finally { fs.rmSync(temporary, { recursive: true, force: true }); temporary = undefined; }
    };
    try {
      const outcome = lock(() => {
        const attempts = Math.min(3, Math.max(1, Number.isInteger(maxPushAttempts) ? maxPushAttempts : 3));
        for (let attempt = 0; attempt < attempts; attempt++) {
          git(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
          const files = hashBacklogFiles(git(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'backlog/']));
          if (!files.length) return { assigned: [], committed: false, pushed: false, files };
          const pending = landedHashes(git, files);
          if (settings && !shouldNumberLandedHashes({ pending, queueIdle, now, settings })) {
            if (pending.some(p => !Number.isFinite(p.landedAt))) throw new Error('landing age evidence unreadable');
            return { assigned: [], committed: false, pushed: false, deferred: true, files };
          }
          const minNext = fallbackMinNext({ cwd, exec, fs, statePath });
          temporary = fs.mkdtempSync(join(tmpdir(), 'queue-main-numbering-'));
          const worktree = join(temporary, 'tree');
          git(['worktree', 'add', '--detach', worktree, 'origin/main']);
          fs.mkdirSync(join(worktree, '.claude/skills/batch-backlog-items'), { recursive: true });
          const n = number(worktree, { minNext, order: pending.map(p => p.hash) });
          if (n.error || !n.committed || hashBacklogFiles(git(['ls-files', 'backlog/'], worktree)).length)
            throw new Error(n.error || 'hash numbering did not commit a complete batch');
          assertNumberingDiff(git, worktree, n.assigned, safeGit(exec, cwd, false), n.droppedDuplicates);
          try { git(['push', '--no-verify', 'origin', 'HEAD:refs/heads/main'], worktree, { MAIN_PUSH_OK: '1' }); }
          catch (e) {
            const evidence = [e.message, e.stderr, e.stdout].join(' ');
            if (!/non-fast-forward|fetch first|stale info/i.test(evidence) || attempt + 1 === attempts) throw e;
            cleanup();
            continue;
          }
          log.write(`  ✓ numbered landed hash card(s) ${files.join(', ')} and pushed to main\n`);
          return { ...n, pushed: true, files };
        }
      }, { runUnlockedOnContention: false });
      if (outcome.ran === false) throw new Error('numbering mutex refused — retry next pass');
      failureState.consecutiveFailures = 0;
      return outcome.result;
    } catch (e) {
      const warning = `main hash numbering failed: ${e.message}; retry next pass or inspect numbering on main`;
      log.write(`  ⚠ WARNING: ${warning}\n`);
      failureState.consecutiveFailures++;
      if (failureState.consecutiveFailures >= maxConsecutiveFailures) {
        try { void Promise.resolve(emit({ kind: 'needs-you', daemon: 'drain', detail: warning })).catch(() => {}); }
        catch { /* Attention storage never gates a merge. */ }
      }
      return { assigned: [], committed: false, pushed: false, warning };
    } finally {
      try { cleanup(); }
      catch (e) { log.write(`  ⚠ main numbering worktree cleanup failed: ${e.message}\n`); }
    }
  });
}

export const repairHashOnMain = numberLandedHashesOnMain;

export function prepareBranchBeforeEnqueue({ c, traceHeadSha, cwd = process.cwd(), isLocal = true,
  isOpen = () => undefined, statePath = numberingStatePath(),
  exec = execFileSync, fs = nodeFs, lock = withNumberingLock, number = numberPendingHashes,
  now = () => new Date().toISOString() } = {}) {
  return withHooksDisabled(() => {
    let temporary, pushedHead;
    const git = safeGit(exec, cwd);
    const pinned = () => {
      if (git(['ls-remote', '--heads', 'origin', `refs/heads/${c.headRef}`]).split(/\s/)[0] !== traceHeadSha) throw new Error('remote branch head moved from judged head');
    };
    try {
      if (!c.headRef || c.headRef === 'main') throw new Error('refusing missing headRef or main');
      git(['check-ref-format', `refs/heads/${c.headRef}`]);
      pinned();
      git(['fetch', 'origin', `refs/heads/${c.headRef}`, '+refs/heads/main:refs/remotes/origin/main']);
      temporary = fs.mkdtempSync(join(tmpdir(), 'queue-numbering-'));
      const worktree = join(temporary, 'tree');
      git(['worktree', 'add', '--detach', worktree, traceHeadSha]);
      const tracked = () => lines(git(['ls-files', 'backlog/'], worktree));
      const files = tracked();
      // A hash-free pinned tree needs no numbering writes. Ordinary tracked symlinks
      // must not block enqueue just because serial mode always requests preparation.
      if (!hashBacklogFiles(files).length) return { action: 'final' };
      for (const path of files) assertWorktreeCard(worktree, path, fs);
      // Numbering also rewrites references in docs, memory, flows and soak files.
      // Validate the entire tracked tree, including ledger parents, before calling it.
      for (const path of lines(git(['ls-files'], worktree))) assertWorktreeFile(worktree, path, fs);
      const outcome = lock(() => {
        pinned();
        const state = readReservations(fs, statePath);
        // Refresh the main floor while holding the same mutex as every allocation writer.
        git(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
        const plan = reservationPlan(git(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'backlog/']), state, isOpen);
        // The drain ledger is local-only; fresh worktrees need its directory even when skills are untracked.
        fs.mkdirSync(join(worktree, '.claude/skills/batch-backlog-items'), { recursive: true });
        const n = number(worktree, { minNext: plan.minNext });
        if (n.error || hashBacklogFiles(tracked()).length) throw new Error(n.error || 'hash card(s) still pending after numbering');
        if ((n.assigned?.length || n.droppedDuplicates?.length) && !n.committed) throw new Error('numbering commit failed');
        const newHead = git(['rev-parse', 'HEAD'], worktree);
        // Persist BEFORE publication: a crash or an ambiguous push failure must never release allocated numbers.
        const nnns = (n.assigned || []).map((a) => Number(a.nnn));
        const reservations = [...plan.reservations, ...(nnns.length ? [{ repo: c.repo ?? null, num: Number(c.num), headRef: c.headRef, nnns, at: now() }] : [])];
        fs.mkdirSync(dirname(statePath), { recursive: true });
        const tmp = `${statePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify({ reservations }, null, 2)}\n`);
        fs.renameSync(tmp, statePath);
        pinned();
        git(['push', '--no-verify', 'origin', `HEAD:refs/heads/${c.headRef}`], worktree);
        pushedHead = newHead;
        return { action: 'numbered', newHead, assigned: n.assigned || [] };
      }, { runUnlockedOnContention: false });
      if (outcome.ran === false) throw new Error('numbering mutex refused — retry next pass');
      return outcome.result;
    } catch (e) { return { action: 'skip', reason: `merge-queue: branch numbering refused: ${String(e.message || e)}` }; }
    finally {
      if (temporary) {
        try {
          try { git(['worktree', 'remove', '--force', join(temporary, 'tree')]); }
          finally { fs.rmSync(temporary, { recursive: true, force: true }); }
        } catch (e) { return { action: 'skip', reason: `merge-queue: worktree cleanup failed: ${e.message}${pushedHead ? `; push already happened at ${pushedHead}` : ''}` }; }
      }
    }
  });
}

/** Keep the cascade hook small; never enqueue after a write or refusal. */
export function finishBranchPreparation(out, { c, revalidationAborted, needsAcceptanceRestamp, restampAcceptance, log = process.stderr, emit = appendDaemonEvent }) {
  if (out.action === 'final') return true;
  let reason = out.reason;
  if (out.action === 'numbered') {
    reason = `merge-queue: numbered card(s) on branch before enqueue → ${out.newHead.slice(0, 9)}`;
    if (needsAcceptanceRestamp(c, { action: 'rebased' })) {
      const rs = restampAcceptance({ pr: c.num, repo: c.repo, newHead: out.newHead });
      if (!rs.ok) reason += `; acceptance re-stamp failed: ${String(rs.reason).slice(0, 200)}`;
    }
  } else if (out.action === 'skip') {
    try {
      void Promise.resolve(emit({ kind: 'needs-you', pr: c.num, daemon: 'drain',
        detail: isTransientReadFailure(reason)
          ? `PR #${c.num}: branch numbering read failed transiently (${reason}) - the PR was not enqueued; retry note: the next pass re-reads it, nothing to do`
          : `PR #${c.num}: branch numbering refused (${reason}) - the PR was not enqueued; fix the cause or number it by hand` })).catch(() => {});
    } catch { /* Coordination events must never interrupt branch preparation. */ }
  }
  revalidationAborted.push({ num: c.num, repo: c.repo, reason });
  log.write(`  ↻ PR ${c.num} ${reason} — not enqueued this pass\n`);
  return false;
}

/** Number only drain-eligible queue entries; alert humans to dequeue held hash cards for branch numbering. */
export function sweepQueuedHashCards({ repo, cwd = process.cwd(), exec = execFileSync, log = process.stderr,
  prepare = prepareBranchBeforeEnqueue, isOpen, emit = appendDaemonEvent, numberCardsBeforeEnqueue = resolveQueueNumbering().value } = {}) {
  const result = { dequeued: [], numbered: [], skipped: [], errors: [] };
  if (!numberCardsBeforeEnqueue) return result;
  const event = (kind, pr, detail) => {
    try { void Promise.resolve(emit({ kind, pr, daemon: 'drain', detail })).catch(() => {}); }
    catch { /* Coordination events must never interrupt the sweep. */ }
  };
  const skip = (num, reason, files = []) => {
    result.skipped.push({ num, reason });
    event('queue-dequeue-skipped', num, { reason });
    if ((reason === 'human-only' || reason === 'human-enqueued') && files.length) {
      event('needs-you', num, `PR #${num} was queued by a human while its backlog card(s) ${files.join(', ')} are still unnumbered; it will fail the merge group. Dequeue and re-queue it after the drain numbers its branch.`);
    }
    log.write(`  ⇠ PR ${num} dequeue skipped: ${reason} — left queued${reason === 'changed-files-unreadable' ? '; retry on next pass' : ''}\n`);
  };
  const fail = (num, e) => {
    const reason = String(e.message || e);
    result.errors.push({ num, reason });
    log.write(`  ⚠ merge-queue sweep${num == null ? '' : ` PR ${num}`}: ${reason}\n`);
  };
  const run = (cmd, args) => exec(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const graphql = (query, fields) => {
    const response = JSON.parse(run('gh', ['api', 'graphql', '-f', `query=${query}`, ...fields.flatMap((field) => ['-f', field])]));
    if (response.errors?.length) throw new Error(response.errors.map((e) => e.message).join('; '));
    return response;
  };
  try {
    const [owner, name] = repo.split('/');
    const queue = graphql('query($owner:String!,$name:String!){repository(owner:$owner,name:$name){mergeQueue(branch:"main"){entries(first:100){nodes{id state enqueuer{login} pullRequest{id number headRefName headRefOid isCrossRepository}}}}}}', [`owner=${owner}`, `name=${name}`]);
    for (const { pullRequest: pr, enqueuer } of queue.data.repository.mergeQueue?.entries.nodes || []) {
      if (pr.isCrossRepository) continue;
      try {
        run('git', ['fetch', 'origin', `refs/heads/${pr.headRefName}`]);
        const files = hashBacklogFiles(run('git', ['ls-tree', '-r', '--name-only', pr.headRefOid, '--', 'backlog/']));
        if (!files.length) continue;
        let changedFiles;
        try {
          // NUL delimiters preserve unusual paths; disabling renames exposes both old and new workflow paths.
          changedFiles = run('git', ['diff', '--name-only', '--no-renames', '-z', `origin/main...${pr.headRefOid}`]).split('\0').filter(Boolean);
        } catch {
          skip(pr.number, 'changed-files-unreadable');
          continue;
        }
        const hold = workflowEditHold({ files: changedFiles, expectedCount: changedFiles.length });
        if (hold.hold) {
          skip(pr.number, hold.humanOnly ? 'human-only' : 'changed-files-unreadable', files);
          continue;
        }
        const login = enqueuer?.login;
        if (typeof login !== 'string' || !login) {
          skip(pr.number, 'enqueuer-unknown');
          continue;
        }
        if (login !== 'plateau-merger' && !login.endsWith('[bot]')) {
          skip(pr.number, 'human-enqueued', files);
          continue;
        }
        graphql('mutation($id:ID!){dequeuePullRequest(input:{id:$id}){mergeQueueEntry{id}}}', [`id=${pr.id}`]);
        result.dequeued.push(pr.number);
        event('queue-dequeued', pr.number, { reason: 'hash-cards-numbering', files });
        log.write(`  ⇠ PR ${pr.number} DEQUEUED: carries hash card(s) ${files.join(', ')} — numbering on its branch, re-enqueued after CI\n`);
        const out = prepare({ c: { num: pr.number, repo: null, headRef: pr.headRefName, item: null, hasManifest: false }, traceHeadSha: pr.headRefOid, cwd, isLocal: true, isOpen });
        log.write(`  ↻ PR ${pr.number} queue branch preparation: ${out.action}${out.reason ? ` — ${out.reason}` : ''}${out.newHead ? ` → ${out.newHead}` : ''}\n`);
        if (out.action === 'numbered') result.numbered.push(pr.number);
        else if (out.action === 'skip') fail(pr.number, out.reason);
      } catch (e) { fail(pr.number, e); }
    }
  } catch (e) { fail(null, e); }
  return result;
}

export function probeQueuedLand(cwd, { exec = execFileSync, log = process.stderr } = {}) {
  const assigned = [];
  try {
    exec('git', ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const files = hashBacklogFiles(exec('git', ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'backlog/'], { cwd, encoding: 'utf8' }));
    if (!files.length) return { assigned, committed: false, files };
    log.write(`  · ${files.length} landed hash card(s) pending batch numbering\n`);
    return { assigned, committed: false, files };
  } catch (e) {
    const warning = `queued-land numbering probe failed — not pushed: ${e.message}`;
    log.write(`  ⚠ WARNING: ${warning}\n`);
    return { assigned, committed: false, warning };
  }
}
