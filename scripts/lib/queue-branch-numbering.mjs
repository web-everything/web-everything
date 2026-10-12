/** Branch-only queue preparation. Number allocation and reservations share the drain numbering mutex. */
import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { isHash, isNum, idFromName } from '../backlog/id.mjs';
import { numberPendingHashes, resolveLandedItem } from '../lane-drain.mjs';
import { withNumberingLock } from '../readiness/drain-lock.mjs';
import { queueStatePath } from './drain-merge-strategy.mjs';

const SETTING = 'scripts/settings/merge-queue-numbering.json';
const ENV = 'WE_MQ_NUMBER_CARDS_BEFORE_ENQUEUE';
const lines = (value) => Array.isArray(value) ? value : String(value).split(/\r?\n/).filter(Boolean);
const cardId = (path) => idFromName(basename(path, '.md'));
export const hashBacklogFiles = (files) => lines(files).filter((p) => /^backlog\/[^/]+\.md$/.test(p) && isHash(cardId(p)));
export const isMergeGroupCiRun = (env = process.env) => env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'merge_group';
/** The drain's birth-hash stamp exempts queue-numbered cards from the hand-picked-id gate. */
export function exemptDrainNumberedItems(items, { enabled }) {
  return enabled ? items.filter((item) => !isHash(item.bornAs)) : items;
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
  try { apply(JSON.parse(readFile(new URL('../settings/merge-queue-numbering.json', import.meta.url), 'utf8'))?.mergeQueue?.numberCardsBeforeEnqueue, SETTING); }
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
  const mainIds = new Set(lines(mainFiles).map(cardId).filter(isNum).map(Number));
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

export function prepareBranchBeforeEnqueue({ c, traceHeadSha, cwd = process.cwd(), isLocal = true,
  isOpen = () => undefined, statePath = join(dirname(queueStatePath()), 'drain-merge-queue-numbering.json'),
  exec = execFileSync, fs = nodeFs, lock = withNumberingLock, number = numberPendingHashes,
  resolveItem = resolveLandedItem, now = () => new Date().toISOString() } = {}) {
  let temporary, pushedHead;
  const git = (args, root = cwd) => String(exec('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  const pinned = () => {
    if (git(['ls-remote', '--heads', 'origin', `refs/heads/${c.headRef}`]).split(/\s/)[0] !== traceHeadSha) throw new Error('remote branch head moved from judged head');
  };
  try {
    if (!c.headRef || c.headRef === 'main') throw new Error('refusing missing headRef or main');
    git(['check-ref-format', `refs/heads/${c.headRef}`]);
    pinned();
    git(['fetch', 'origin', `refs/heads/${c.headRef}`, '+refs/heads/main:refs/remotes/origin/main']);
    temporary = fs.mkdtempSync(join(tmpdir(), 'queue-numbering-'));
    // Resolve CLI dependencies through the worktree's parent, as the detached follow-up does.
    fs.symlinkSync(join(cwd, 'node_modules'), join(temporary, 'node_modules'), 'dir');
    const worktree = join(temporary, 'tree');
    git(['worktree', 'add', '--detach', worktree, traceHeadSha]);
    const tracked = () => lines(git(['ls-files', 'backlog/'], worktree));
    const files = tracked();
    const own = c.hasManifest && isLocal && c.item != null ? files.find((p) =>
      cardId(p) === String(c.item).padStart(isNum(c.item) ? 3 : 0, '0') ||
      (isHash(c.item) && new RegExp(`^bornAs:\\s*${c.item}\\s*$`, 'm').test(fs.readFileSync(join(worktree, p), 'utf8')))) : null;
    if (c.hasManifest && isLocal && c.item != null && !own) throw new Error(`candidate card ${c.item} not found on branch`);
    const needsResolve = own && !/^status:\s*['"]?resolved['"]?\s*$/m.test(fs.readFileSync(join(worktree, own), 'utf8').split('---')[1] || '');
    if (!hashBacklogFiles(files).length && !needsResolve) return { action: 'final' };
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
      const resolved = [];
      if (needsResolve) {
        const id = n.assigned?.find((a) => a.hash === cardId(own))?.nnn || cardId(own);
        const r = resolveItem(worktree, id, { sync: false, publish: false });
        if (!r.flipped && !r.alreadyResolved) throw new Error(`card ${id} resolve refused: ${r.reason || 'not resolved'}`);
        if (r.flipped) resolved.push(id);
      }
      const newHead = git(['rev-parse', 'HEAD'], worktree);
      // Persist BEFORE publication: a crash or an ambiguous push failure must never release allocated numbers.
      const nnns = (n.assigned || []).map((a) => Number(a.nnn));
      const reservations = [...plan.reservations, ...(nnns.length ? [{ repo: c.repo ?? null, num: Number(c.num), headRef: c.headRef, nnns, at: now() }] : [])];
      fs.mkdirSync(dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ reservations }, null, 2)}\n`);
      fs.renameSync(tmp, statePath);
      pinned();
      git(['push', 'origin', `HEAD:refs/heads/${c.headRef}`], worktree);
      pushedHead = newHead;
      return { action: 'numbered', newHead, assigned: n.assigned || [], resolved };
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
}

/** Keep the cascade hook small; never enqueue after a write or refusal. */
export function finishBranchPreparation(out, { c, revalidationAborted, needsAcceptanceRestamp, restampAcceptance, log = process.stderr }) {
  if (out.action === 'final') return true;
  let reason = out.reason;
  if (out.action === 'numbered') {
    reason = `merge-queue: numbered card(s) on branch before enqueue → ${out.newHead.slice(0, 9)}`;
    if (needsAcceptanceRestamp(c, { action: 'rebased' })) {
      const rs = restampAcceptance({ pr: c.num, repo: c.repo, newHead: out.newHead });
      if (!rs.ok) reason += `; acceptance re-stamp failed: ${String(rs.reason).slice(0, 200)}`;
    }
  }
  revalidationAborted.push({ num: c.num, repo: c.repo, reason });
  log.write(`  ↻ PR ${c.num} ${reason} — not enqueued this pass\n`);
  return false;
}

export function probeQueuedLand(cwd, { exec = execFileSync, log = process.stderr } = {}) {
  const assigned = [];
  try {
    const files = hashBacklogFiles(exec('git', ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'backlog/'], { cwd, encoding: 'utf8' }));
    if (!files.length) return { assigned, committed: false };
    const warning = `hash card(s) ${files.join(', ')} on main after a queued land — not pushed; the merge_group gate should have refused it`;
    log.write(`  ⚠ WARNING: ${warning}\n`);
    return { assigned, committed: false, warning };
  } catch (e) {
    const warning = `queued-land numbering probe failed — not pushed: ${e.message}`;
    log.write(`  ⚠ WARNING: ${warning}\n`);
    return { assigned, committed: false, warning };
  }
}
