/**
 * @file scripts/held-cards-io.mjs
 * @description IMPURE CLI for operator handoff rule 21 ("hold new cards while busy"): `add` appends to the held
 *   list (`~/workspace/.operations/handoff/cards-to-file.md`), `status` says whether the host is quiet (1-min load
 *   under the limit and the open-PR count not growing since the last status), and `file` files every un-filed
 *   item through the sanctioned `file-item` operation in ONE lane and ONE PR (`verify` + `open-pr`), marks them
 *   FILED in the list, and always releases the lane. All parsing/planning is pure in `we:scripts/held-cards.mjs`.
 *   Skill: `we:skills-src/held-cards/SKILL.md`.
 */
import { retryTransientGit } from './lib/git-fetch-retry.mjs';
import { parseSize } from './backlog/scaffold.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_REPOS } from './operations/free-scope.mjs';
import { withPathLock } from './readiness/with-lock.mjs';
import { assessItem, extractRefs, mergedSlices, overlap, prMentionsItem, wordStems, OVERLAP_MIN, OVERLAP_STRONG, HEURISTIC_NOTE } from './held-cards-check.mjs';
import { appendHeldCard, parseHeldCards, planFiling, quietVerdict, markFiled } from './held-cards.mjs';

/** A filing run holds its lock for minutes (verify + open-pr); a crashed one is reclaimed after this long untouched. */
const FILING_LOCK_LEASE_MINUTES = 30;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Commands can print progress before their JSON result. Keep the last complete
// outer object (not a nested verdict within it).
function lastJson(output) {
  const text = String(output);
  let result;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < text.length; end++) {
      const c = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { result = JSON.parse(text.slice(start, end + 1)); start = end; } catch { /* Try next opening brace. */ }
        break;
      }
    }
  }
  if (!result) throw new Error('command returned no JSON object');
  return result;
}

function prNumber(value) {
  if (value && typeof value === 'object') {
    if (/^\d+$/.test(String(value.number))) return Number(value.number);
    for (const child of Object.values(value)) {
      const number = prNumber(child);
      if (number) return number;
    }
  }
  return typeof value === 'string' ? Number(/\/pull\/(\d+)/.exec(value)?.[1]) || null : null;
}

function etTime(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** Write operator state atomically: temp file in the same directory, then rename, so a reader never sees a torn file. */
export function atomicWriteText(file, data, encoding = 'utf8') {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try { fs.writeFileSync(tmp, data, encoding); fs.renameSync(tmp, file); } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw error;
  }
}

const PR_LIST_LIMIT = 300;

export async function main(argv, deps = {}) {
  const { env = process.env, stdout = process.stdout, stderr = process.stderr,
    exec = (bin, args, options) => execFileSync(bin, args, { ...options, encoding: 'utf8' }),
    readFile = fs.readFileSync, writeFile = atomicWriteText, loadavg = os.loadavg,
    now = () => new Date() } = deps;
  const flags = Object.fromEntries(argv.slice(1).map(arg => {
    const equal = arg.indexOf('=');
    return equal < 0 ? [arg.replace(/^--/, ''), true] : [arg.slice(2, equal), arg.slice(equal + 1)];
  }));
  const list = env.WE_HELD_CARDS_PATH || path.join(os.homedir(), 'workspace/.operations/handoff/cards-to-file.md');
  const state = env.WE_HELD_CARDS_STATE || path.join(os.homedir(), 'workspace/.operations/handoff/.held-cards-state.json');
  const root = flags['repo-root'] || repoRoot;
  const say = value => stdout.write(`${value}\n`);
  const read = (file, fallback) => {
    try { return String(readFile(file, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  };
  // Every subprocess first refreshes the filing lock (a no-op outside a filing run), so a long run is never "stale".
  let beat = () => {}, holdsFiling = false;
  // A run whose lock was lost stops before its next step; the lane release passes `alive = false` so it still runs.
  const command = (bin, args, cwd = root, alive = true) => {
    if (alive) beat();
    try { return exec(bin, args, { cwd, encoding: 'utf8' }); } finally { if (alive) beat(); } // refresh after a long run too
  };
  const verdict = () => {
    const previous = JSON.parse(read(state, 'null'));
    let truncated = false;
    const openPrs = DEFAULT_REPOS.reduce((count, repo) => {
      const prs = JSON.parse(command(env.WE_HELD_CARDS_GH_BIN || 'gh',
        ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', 'number']));
      if (!Array.isArray(prs)) throw new Error('gh returned an invalid PR list');
      if (prs.length >= PR_LIST_LIMIT) truncated = true;
      return count + prs.length;
    }, 0);
    const thresholds = {};
    for (const [key, flag, variable] of [['maxLoad', 'max-load', 'WE_HELD_CARDS_MAX_LOAD'],
      ['maxPrGrowth', 'max-pr-growth', 'WE_HELD_CARDS_MAX_PR_GROWTH']]) {
      const value = flags[flag] ?? env[variable];
      if (value !== undefined) {
        if (value === true || String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error(`invalid ${flag}`);
        thresholds[key] = Number(value);
      }
    }
    const result = quietVerdict({ load1: loadavg()[0], openPrs, previous, ...thresholds });
    // A cut-off PR list is a lower bound: a flat count then does not prove the queue stopped growing.
    if (truncated) { result.quiet = false; result.reasons.unshift(`PR list truncated at ${PR_LIST_LIMIT}; count unreliable`); }
    return result;
  };
  try {
    const md = read(list, '');
    const { items } = parseHeldCards(md);
    if (argv[0] === 'add') {
      const meta = {};
      for (const key of ['kind', 'size', 'scope', 'parent']) {
        // An empty `--size=` is absent (never 0) and a non-number is refused, not nulled (#x0h3pe4: the shared rule).
        if (key === 'size') {
          const size = parseSize(flags.size);
          if (size !== undefined && !Number.isFinite(size)) throw new Error(`--size must be a number (got ${JSON.stringify(flags.size)})`);
          if (size !== undefined) meta.size = size;
          continue;
        }
        if (flags[key] !== undefined) meta[key] =
          key === 'scope' ? String(flags[key]).split(',').map(s => s.trim()).filter(Boolean) : flags[key];
      }
      // Read, number and write under the list lock: two workers adding at once must not allocate one number.
      const appended = withPathLock(list, ({ touch }) => {
        const result = appendHeldCard(read(list, ''), { title: flags.title, body: flags.body || '',
          nowEt: etTime(now()), meta: Object.keys(meta).length ? meta : null });
        touch(); // still the holder? Then commit.
        writeFile(list, result.md, 'utf8');
        return result;
      });
      say(`held as item ${appended.num}`);
      return 0;
    }
    if (argv[0] === 'list') {
      const selected = items.filter(item => flags.all || !item.done);
      say(flags.json ? JSON.stringify(selected) : selected.map(item => `${item.num}. ${item.title}${item.done ? ` — ${item.doneReason}` : ''}`).join('\n'));
      return 0;
    }
    if (argv[0] === 'status') {
      const result = verdict();
      say(flags.json ? JSON.stringify(result) : result.quiet ? `QUIET — ok to file ${items.filter(item => !item.done).length} held cards` : `BUSY — ${result.reasons.join('; ')}`);
      writeFile(state, JSON.stringify({ at: now().toISOString(), openPrs: result.openPrs }), 'utf8');
      return result.quiet ? 0 : 1;
    }
    if (argv[0] === 'check') {
      // Read-only staleness guess: is a held item already on origin/main? Run before dispatching it.
      const ref = flags.ref || 'origin/main';
      const git = (...args) => command('git', ['-C', root, ...args]);
      const tryGit = (...args) => { try { return git(...args); } catch { return null; } };
      if (!flags['no-fetch']) { try { retryTransientGit(() => git('fetch', '-q', 'origin', 'main')); } catch { /* best-effort */ } }
      const wanted = flags.item ? new Set(String(flags.item).split(',').map(Number)) : null;
      const selected = items.filter(item => wanted ? wanted.has(item.num) : flags.all || !item.done);
      const gh = env.WE_HELD_CARDS_GH_BIN || 'gh';
      const repo = DEFAULT_REPOS[0];
      const mergedPrs = JSON.parse(command(gh, ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '500', '--json', 'number,title,body']));
      const tracked = String(git('ls-tree', '-r', '--name-only', ref)).split('\n').filter(Boolean);
      const results = selected.map(item => {
        const refs = extractRefs(item.text);
        const itemStems = wordStems(item.text);
        const paths = [...refs.paths, ...refs.bareFiles.flatMap(f => tracked.filter(t => t.endsWith(`/${f}`)).slice(0, 2))]
          .map(file => ({ path: file, exists: tracked.some(t => t === file || (/[*<>]/.test(file) && t.startsWith(file.split(/[*<>]/)[0]))) }));
        const symbols = refs.symbols.map(name => ({ name, found: tryGit('grep', '-qF', '-e', name, ref) !== null }));
        const prs = refs.prs.map(number => {
          const hit = mergedPrs.find(pr => pr.number === number);
          if (hit) return { number, state: 'MERGED' };
          try { return { number, state: JSON.parse(command(gh, ['pr', 'view', String(number), '--repo', repo, '--json', 'state'])).state }; } catch { return { number, state: 'UNKNOWN' }; }
        });
        const mentions = mergedPrs.filter(pr => pr.number !== item.num).map(pr => ({ number: pr.number, title: pr.title, why: prMentionsItem(item.num, pr) })).filter(m => m.why);
        // A PR the item merely waits on ("starts after #4016") is a dependency, not the PR that fixed it.
        const followUps = refs.prs.filter(n => !new RegExp(`(?:after|needs|depends on|blocked by|once|before)[^.#]{0,25}#${n}`, 'i').test(item.text));
        const commits = [];
        for (const { path: file, exists } of paths.filter(p => p.exists && !/[*<>]/.test(p.path)).slice(0, 6)) {
          for (const subject of String(tryGit('log', '-n', '40', '--no-merges', '--format=%s', ref, '--', file) ?? '').split('\n').filter(Boolean)) {
            const shared = overlap(itemStems, subject);
            if (exists && shared.length >= OVERLAP_MIN) commits.push({ path: file, subject, shared,
              strong: shared.length >= OVERLAP_STRONG || followUps.some(n => subject.includes(`#${n}`)) });
          }
        }
        return assessItem(item, refs, { paths, symbols, prs, mentions, slicesDone: mergedSlices(item.num, mergedPrs), commits });
      });
      if (flags.json) { say(JSON.stringify({ note: HEURISTIC_NOTE, ref, results })); return 0; }
      say(`${HEURISTIC_NOTE}\nchecked against ${ref} @ ${String(tryGit('rev-parse', '--short', ref) ?? '?').trim()}`);
      for (const r of results) say(`\n${r.num}. ${r.verdict.toUpperCase()} — ${r.title.length > 90 ? `${r.title.slice(0, 87)}...` : r.title}\n${r.evidence.map(e => `     ${e}`).join('\n')}`);
      const count = v => results.filter(r => r.verdict === v).length;
      say(`\n${count('likely-done')} likely-done, ${count('partly-done')} partly-done, ${count('not-started')} not-started`);
      return 0;
    }
    if (argv[0] !== 'file') throw new Error('usage: held-cards-io.mjs add|list|status|check|file');
    const plan = planFiling(items);
    if (!plan.length) { say('nothing to file'); return 0; }
    if (flags['dry-run']) {
      say(flags.json ? JSON.stringify(plan) : plan.map(item => `${item.num}. ${item.kind} ${item.size ?? '-'} ${item.title}`).join('\n'));
      return 0;
    }
    // ONE filing run at a time. The list lock only covers a single read-modify-write, but a run spends minutes
    // between planning and marking FILED: two runs would plan the same pending items and open two PRs for them.
    // So the whole run (plan → file → PR → mark) holds this lock and plans from a list read under it. A second
    // run fails fast. The lease is 30 min, and the holder refreshes it (heartbeat) before every subprocess.
    const filing = withPathLock(`${list}.filing`, ({ touch }) => {
    beat = touch;
    holdsFiling = true;
    const pending = planFiling(parseHeldCards(read(list, '')).items);
    if (!pending.length) { say('nothing to file'); return 0; }
    if (!flags.blocking) {
      const result = verdict();
      if (!result.quiet) { say(flags.json ? JSON.stringify(result) : `BUSY — ${result.reasons.join('; ')}`); return 1; }
    }
    const dateEt = etTime(now());
    const stamp = dateEt.replaceAll('-', '').replace(' ', '-').replace(':', '');
    const lane = lastJson(command('node', [path.join(root, 'scripts/lane-pool.mjs'), 'acquire',
      `--purpose=held-cards-${stamp}`, '--adopt', '--json']));
    const filed = [], failed = [];
    try {
      if (!lane.lane || !lane.path || !lane.holder) throw new Error('invalid lane acquisition result');
      const operation = args => command('node', [path.join(lane.path, 'scripts/operations/run.mjs'), ...args, '--json'], lane.path);
      for (const item of pending) {
        try {
          const result = lastJson(operation(['file-item', `--title=${item.title}`, `--kind=${item.kind}`,
            ...(item.size != null ? [`--size=${item.size}`] : []), `--digest=${item.digest}`, ...(item.scope.length ? [`--scope=${item.scope.join(',')}`] : []),
            ...(item.parent !== null ? [`--parent=${item.parent}`] : [])]));
          const card = result.run?.verdict ?? result.verdict;
          const id = card?.num ?? card?.id;
          if (id == null || !card?.rel || path.isAbsolute(card.rel) || card.rel.split(/[\\/]/).includes('..')) throw new Error('invalid file-item verdict');
          filed.push({ ...item, id, rel: card.rel });
        } catch (error) {
          failed.push({ num: item.num, error: error.message });
          stderr.write(`NOT FILED ${item.num}: ${error.message}\n`);
        }
      }
      if (!filed.length) { say('no held cards filed'); return 1; }
      const rels = filed.map(item => item.rel);
      command('git', ['-C', lane.path, 'add', '--', ...rels], lane.path);
      command('git', ['-C', lane.path, 'commit', '-m', `backlog: file ${filed.length} held cards (rule 21)`, '--', ...rels], lane.path);
      operation(['verify', `--checkout=${lane.path}`]);
      const bodyFile = path.join(lane.path, '.git', `held-cards-${stamp}.md`);
      writeFile(bodyFile, filed.map(item => `- Held item ${item.num} → ${item.id}: ${item.title}`).join('\n') + '\n', 'utf8');
      const output = operation(['open-pr', `--ref=lane/held-cards-${stamp}`,
        `--title=backlog: file ${filed.length} held cards`, `--bodyFile=${bodyFile}`]);
      // Prefer the PR URL (unambiguous); fall back to a `number` field in the JSON envelope.
      let pr = prNumber(String(output));
      if (!pr) { try { pr = prNumber(lastJson(output)); } catch { /* no JSON either — refused below */ } }
      if (!pr) throw new Error('open-pr returned no PR number');
      // Re-read under the lock so an `add` that landed during filing is kept, not overwritten.
      // The PR exists now, so wait generously: failing here would leave its cards unmarked and refile them.
      beat();
      withPathLock(list, ({ touch }) => {
        const marked = markFiled(read(list, ''), filed, { dateEt, pr });
        touch(); // still the holder? Then commit.
        writeFile(list, marked, 'utf8');
      }, { timeoutMs: 60000 });
      say(flags.json ? JSON.stringify({ filed, failed, pr }) : filed.map(item => `FILED ${item.num} as ${item.id}, PR #${pr}`).join('\n'));
      return 0;
    } finally {
      // A malformed acquisition has nothing to release; releasing with undefined args would mask the real error.
      if (lane.lane && lane.holder) command('node', [path.join(root, 'scripts/lane-pool.mjs'), 'release', `--lane=${lane.lane}`, `--session=${lane.holder}`], root, false);
    }
    }, { timeoutMs: 0, leaseMinutes: FILING_LOCK_LEASE_MINUTES });
    return filing;
  } catch (error) {
    // Only a wait on the FILING lock means "another run is filing"; the inner list lock's timeout is its own error.
    if (error.code === 'ELOCKTIMEOUT' && argv[0] === 'file' && !holdsFiling) {
      stderr.write('another held-cards filing run is in progress; not filing the same cards twice\n');
      return 1;
    }
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
