/** File held handoff cards through file-item in this checkout; never mutate the handoff. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readGit } from '../lib/proc-read.mjs';
import { appendFileSync, writeFileSync, unlinkSync, readFileSync, readdirSync, realpathSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
import { runOperationCli } from './cli-adapter.mjs';
import { REPO_ROOT } from './scaffold-io.mjs';
import { assertPublishableContent } from '../backlog/guarded-write.mjs';
import { PATH_PATTERNS } from '../lib/secret-scrub.mjs';

export const FILE_HELD_CARDS_OP = 'file-held-cards';
const BATCH_EFFECT = 'file-held-cards.file';
const normalize = text => text.trim().replace(/\s+/g, ' ');
const titleKey = title => normalize(title).toLowerCase();
const safeLog = text => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const expandHome = path => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;

function outsideRepository(root, path) {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function resolveLedgerPath(path) {
  try {
    try { lstatSync(path); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A new file is permitted only within an existing, fully resolved parent directory.
      return join(realpathSync(dirname(path)), basename(path));
    }
    // A dangling symlink exists to lstat, so realpath refuses it rather than treating it as a new file.
    return realpathSync(path);
  } catch (error) {
    throw new Error('--ledger cannot be resolved; repair its symlink or choose an existing accessible directory', { cause: error });
  }
}

export function hashLine(line) {
  return createHash('sha256').update(normalize(line)).digest('hex');
}

export function parseCards(source) {
  return source.split(/\r?\n/).flatMap(raw => {
    const match = raw.match(/^\s*-\s+((?:\[R\d+(?:[ ,]+R\d+)*\]\s*)+)(\d{4}-\d{2}-\d{2})(?:\s+\d{2}:\d{2}\s+ET)?:\s*(\S.*)$/);
    if (!match) return [];
    return [{ raw, hash: hashLine(raw), tag: match[1].match(/R\d+/g).join(','), date: match[2], text: match[3] }];
  });
}

export function selectUnfiled(cards, ledger, { select, since, max = 10 } = {}) {
  const filed = new Set(ledger.map(row => row.hash));
  const regex = select ? new RegExp(select) : null;
  return cards.filter(card => {
    if (filed.has(card.hash) || (since && card.date < since) || (regex && !regex.test(card.raw))) return false;
    filed.add(card.hash);
    return true;
  }).slice(0, max);
}

const BARE_FILE = /(?<![\w./:~@-])([\w][\w.-]*\.(?:mjs|cjs|js|ts|json|md|css|html|yml|yaml))(?![\w/-])/g;

/** A bare basename matching exactly ONE tracked file becomes `we:<path>`; zero or several matches stay bare
 *  (the scrub then refuses them) and the several-match candidates are returned so the caller can list them. */
export function qualifyBareBasenames(text, trackedFiles) {
  const byBase = new Map();
  for (const file of trackedFiles) {
    const base = file.slice(file.lastIndexOf('/') + 1);
    byBase.set(base, [...(byBase.get(base) ?? []), file]);
  }
  const ambiguous = {};
  const out = text.replace(BARE_FILE, (match, name) => {
    const found = byBase.get(name) ?? [];
    if (found.length === 1) return `we:${found[0]}`;
    if (found.length > 1) ambiguous[name] = found;
    return match;
  });
  return { text: out, ambiguous };
}

// A filed card keeps its birth hash as `bornAs` when the drain renumbers it, so a ledgered hash id must also
// resolve through that front-matter line, here and on origin/main.
const BIRTH_HASH = /^x[0-9a-z]{6}$/;

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** A card's leading front-matter block (between the first two `---` lines), or null; body lines never count. */
function frontMatterBlock(text) {
  return text.match(FRONT_MATTER)?.[1] ?? null;
}

/** Offset where the body starts: 0 when the card has no front matter. */
function frontMatterEnd(text) {
  return text.match(FRONT_MATTER)?.[0].length ?? 0;
}

/** The finished-card `status:` inside the leading front-matter block only; a body example never counts. */
function isFinishedCard(text) {
  const block = frontMatterBlock(text);
  return block !== null && /^status:\s*["']?(resolved|closed|dropped|rejected|superseded|wontfix)/m.test(block);
}

/** The `bornAs` value inside a card's leading front-matter block only; a body line quoting one never counts. */
function frontMatterBornAs(text) {
  const block = frontMatterBlock(text);
  if (block === null) return null;
  const line = block.split(/\r?\n/).find(text => /^bornAs:/.test(text));
  return line ? line.replace(/^bornAs:\s*/, '').trim().replace(/^["']|["']$/g, '') : null;
}

const FRONT_MATTER_BYTES = 16 * 1024;

function readHead(path) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(FRONT_MATTER_BYTES);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, FRONT_MATTER_BYTES, 0));
  } finally { closeSync(fd); }
}

function bornAsLocally(root, hash) {
  try {
    for (const name of readdirSync(join(root, 'backlog')).filter(name => name.endsWith('.md'))) {
      if (frontMatterBornAs(readHead(join(root, 'backlog', name))) === hash) return true;
    }
  } catch { /* no backlog dir */ }
  return false;
}

function bornAsOnMain(root, hash) {
  const opts = { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    // The hash is shape-checked to [x0-9a-z]{7}, so it is safe inside the pattern; grep only narrows candidates,
    // the front-matter parse below decides.
    const hits = readGit(['grep', '-l', '-E', `^bornAs:[[:space:]]*["']?${hash}["']?[[:space:]]*$`, 'origin/main', '--', 'backlog/'], opts)
      .split('\n').filter(line => line.startsWith('origin/main:backlog/')).slice(0, 20);
    return hits.some(hit => frontMatterBornAs(readGit(['show', hit], opts).slice(0, FRONT_MATTER_BYTES)) === hash);
  } catch { return false; } // exit 1 (no match) and any git failure both fail closed
}

function cardExists(root, num) {
  const matches = name => name === `${num}.md` || name.startsWith(`${num}-`);
  try { if (readdirSync(join(root, 'backlog')).some(matches)) return true; } catch { /* no backlog dir */ }
  try {
    if (execFileSync('git', ['ls-tree', '--name-only', 'origin/main', 'backlog/'], { cwd: root, encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').some(line => matches(line.replace(/^backlog\//, '')))) return true;
  } catch { /* fall through to the bornAs lookup */ }
  if (!BIRTH_HASH.test(String(num))) return false;
  return bornAsLocally(root, num) || bornAsOnMain(root, num);
}

function gitTrackedFiles(root) {
  // Not a git checkout (or git failing) means no qualification: bare paths are then simply refused as before.
  try { return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch { return []; }
}

export function composeFileItemInput(card) {
  // Whole text, cut at a word boundary: held cards often lead with a short ref ("#6381 slice 2") that is useless alone.
  const flat = card.text.replace(/\s+/g, ' ').trim();
  const title = flat.length <= 110 ? flat : flat.slice(0, 110).replace(/\s+\S*$/, '').replace(/[\s,;:—–-]+$/, '') + '…';
  const paths = [...card.text.matchAll(/\bwe:[A-Za-z0-9_./*-]+/g)].map(m => m[0].replace(/[.,;:!?]+$/, ''));
  return { title, digest: card.text, kind: 'task', queue: 'false',
    ...(paths.length ? { scope: [...new Set(paths)].join(',') } : {}) };
}

function validateOptions({ max = 10, since, select } = {}) {
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('--max must be a positive whole number; use --max=10 or a smaller batch');
  // utc-day-slice-ok: round-trip a UTC-anchored input date to reject impossible calendar dates, never read today's day.
  if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since)) {
    throw new Error('--since must be a valid YYYY-MM-DD date');
  }
  if (select) new RegExp(select);
}

function readLedger(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    let row;
    try { row = JSON.parse(line); } catch { /* Refuse partial evidence below. */ }
    if (!row || !/^[a-f0-9]{64}$/.test(row.hash) || !row.card || !row.title || !row.tag || !row.date || !row.filedAt) {
      throw new Error(`ledger line ${index + 1} is incomplete; repair the ledger before retrying`);
    }
    return row;
  });
}

export async function fileInCheckout(input, run = runOperationCli) {
  // This binding resolves file-item from script location, so every card lands in this lane.
  const { fileItemForPrevention } = await import('./review-loop-cli.mjs');
  // The shared argv builder expects scope, but unscoped cards must omit that flag.
  // size is never set for a held card; an omitted one must reach file-item as absent, not as the string 'undefined'.
  return fileItemForPrevention({ ...input, scope: input.scope ?? '', size: input.size ?? '' }, {
    // file-item's own duplicate search includes closed cards; a closed twin the caller already vetted is declared
    // through file-item's own --notDuplicateReason, so preflight and filing agree.
    run: args => run({ ...args, argv: [...args.argv.filter(arg => arg !== '--scope=' && arg !== '--size='),
      ...(input.notDuplicateReason ? [`--notDuplicateReason=${input.notDuplicateReason}`] : [])] }),
  });
}

async function runFileHeldCardsLocked({ source = join(homedir(), 'workspace', '.operations', 'handoff', 'cards-to-file.md'),
  dryRun = false, select, since, max = 10, deps = {} } = {}) {
  validateOptions({ max, since, select });
  const { root = REPO_ROOT, fileItem = fileInCheckout, log = console.log, now = () => new Date().toISOString(),
    appendFile = appendFileSync } = deps;
  source = resolve(expandHome(source));
  // The ledger path is fixed beside the source; it is not an input.
  let ledger = resolve(join(dirname(source), 'cards-filed.jsonl'));
  const lexicalOutside = outsideRepository(resolve(root), ledger);
  ledger = resolveLedgerPath(ledger);
  if (!lexicalOutside || !outsideRepository(realpathSync(root), ledger) || ledger === realpathSync(source)) {
    throw new Error('--ledger must be outside the repository and distinct from --source');
  }
  // A hard-linked ledger could be a repository file under another name; a one-link ledger cannot be.
  let linked = false;
  try { linked = lstatSync(ledger).nlink > 1; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (linked) throw new Error('ledger has more than one hard link; use a plain ledger file outside the repository');
  const tracked = deps.trackedFiles ? deps.trackedFiles() : gitTrackedFiles(root);
  const ledgerRows = readLedger(ledger);
  // A ledger row is only trusted while its card still exists here or on main; a discarded lane must not hide the card.
  const missing = ledgerRows.filter(row => !cardExists(root, row.card));
  if (missing.length) {
    throw new Error(`${missing.length} ledgered card(s) are in neither this checkout nor origin/main (unmerged or discarded lane); land that PR or remove those ledger rows before filing more`);
  }
  const cards = selectUnfiled(parseCards(readFileSync(source, 'utf8')), ledgerRows, { select, since, max: Infinity });
  const titles = new Map();
  const closedTitles = new Map(); // finished cards: never a duplicate here, but file-item's own search still sees them
  for (const name of readdirSync(join(root, 'backlog')).filter(name => name.endsWith('.md'))) {
    const content = readFileSync(join(root, 'backlog', name), 'utf8');
    // The title is the first heading AFTER the front matter: a `# comment` line inside it is not a title.
    const title = content.slice(frontMatterEnd(content)).match(/^#\s+(.+)$/m)?.[1];
    if (!title) continue; // legacy untitled cards cannot be title-matched; they never block a run
    // A finished card does not cover a fresh handoff: only live cards suppress a same-titled line.
    if (isFinishedCard(content)) { closedTitles.set(titleKey(title), name); continue; }
    titles.set(titleKey(title), name);
  }
  const result = { planned: [], filed: [], duplicates: [], refused: [], failed: [] };
  for (const card of cards) {
    // Refusals stay retryable but do not use the budget, so they cannot starve later valid cards.
    if (result.planned.length + result.filed.length >= max) break;
    const qualified = qualifyBareBasenames(card.text, tracked);
    for (const [name, found] of Object.entries(qualified.ambiguous)) {
      log(safeLog(`ambiguous ${card.tag}: ${name} matches ${found.slice(0, 5).map(f => `we:${f}`).join(', ')}${found.length > 5 ? ', ...' : ''}`));
    }
    const input = composeFileItemInput({ ...card, text: qualified.text });
    const summary = { tag: card.tag, date: card.date, title: input.title, ...(input.scope ? { scope: input.scope } : {}) };
    try {
      // Reuse file-item's own content guard; never rewrite a bare path into an approved one.
      assertPublishableContent('backlog/held-card.md', `# ${input.title}\n\n${input.digest}`);
      // Publish guards intentionally allow local paths. Held handoffs require a stricter scrub,
      // including extensionless home paths and single-component absolute paths.
      if (PATH_PATTERNS.some(([pattern]) => pattern.test(input.digest))
        || /(?:^|[\s`"'(=])\/\S/.test(input.digest)
        || /(?:^|[\s`"'(=])(?:[\w.-]+\/)*scripts\/\S/.test(input.digest)) {
        throw new Error('local path in held card');
      }
    } catch {
      // Sanitized: a refused card's title may carry the very secret or path that got it refused.
      result.refused.push({ tag: card.tag, date: card.date });
      log(safeLog(`refused ${card.tag}: remove secrets and use explicit WE path prefixes before retrying`));
      continue;
    }
    // A truncated title is not a full identity: two distinct cards can share its first 110 chars.
    const duplicate = input.title.endsWith('…') ? undefined : titles.get(titleKey(input.title));
    if (duplicate) {
      // Never ledgered: the twin may close later, and then this handoff must be filed on a re-run.
      // A dry run reports it too, so the plan never lists a card the real run would skip.
      result.duplicates.push({ ...summary, card: duplicate });
      log(safeLog(`duplicate ${card.tag}: ${input.title}`));
      continue;
    }
    if (dryRun) { result.planned.push(summary); continue; }
    const row = { hash: card.hash, ...summary, card: null, filedAt: now() };
    // A truncated title gets the same closed-twin handling as a short one: a closed card carrying the identical
    // generated title cannot cover a fresh handoff either. A live card with that title still blocks (never declared away).
    const closed = titles.has(titleKey(input.title)) ? undefined : closedTitles.get(titleKey(input.title));
    if (closed) input.notDuplicateReason = safeLog(`${closed} is closed and does not cover this fresh handoff`);
    try {
      const response = await fileItem(input);
      const { parseFiledPayload } = await import('./review-loop-cli.mjs');
      const payload = parseFiledPayload(response?.lines);
      if (response?.code !== 0 || !payload.verdict?.num || !payload.verdict?.rel) {
        // Do not echo file-item output: it can contain the rejected secret itself.
        throw new Error('file-item refused or returned incomplete filing evidence; inspect its run before retrying');
      }
      row.card = payload.verdict.num;
      if (payload.pr != null) row.pr = payload.pr;
    } catch {
      result.failed.push(summary);
      log(safeLog(`failed ${card.tag}: file-item did not file this card; inspect its run before retrying`));
      continue;
    }
    result.filed.push(row);
    titles.set(titleKey(input.title), row.card);
    log(safeLog(`filed ${card.tag}: ${input.title}`));
    // A ledger failure stops the batch: continuing could silently lose successful filing evidence.
    let separator = '';
    try {
      const existing = readFileSync(ledger, 'utf8');
      if (existing && !existing.endsWith('\n')) separator = '\n';
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { appendFile(ledger, `${separator}${JSON.stringify(row)}\n`); } catch (error) {
      // The card is already filed: name every filed-but-unledgered number so the operator can add the rows.
      const filed = result.filed.map(filedRow => `${filedRow.card} (${filedRow.tag})`).join(', ');
      throw new Error(safeLog(`ledger append failed (${error.code ?? error.message}); filed but not ledgered: ${filed}`), { cause: error });
    }
  }
  return result;
}

export async function runFileHeldCards(options = {}) {
  if (options.dryRun) return runFileHeldCardsLocked(options);
  // Ledger-scoped lock held through select, filing and append, so overlapping runs cannot double-file a card.
  const source = resolve(expandHome(options.source || join(homedir(), 'workspace', '.operations', 'handoff', 'cards-to-file.md')));
  const lexical = resolve(expandHome(join(dirname(source), 'cards-filed.jsonl')));
  const canonical = resolveLedgerPath(lexical);
  // One lock by canonical ledger path (exists from the first run, even before the ledger does), held through select, filing and append.
  const ids = [createHash('sha256').update(canonical).digest('hex').slice(0, 24)];
  const held = [];
  // Release only a lock that still names this process, so a lock reclaimed and retaken by another run survives.
  const release = () => { for (const lock of held) {
    try { if (readFileSync(lock, 'utf8').trim() === String(process.pid)) unlinkSync(lock); } catch { /* already gone */ }
  } };
  for (const id of ids) {
    const lock = join(tmpdir(), `file-held-cards-${id}.lock`);
    try { acquireLock(lock); held.push(lock); } catch (error) { release(); throw error; }
  }
  try { return await runFileHeldCardsLocked(options); } finally { release(); }
}

// Only "no such process" proves a dead owner; EPERM and any invalid-pid error stay live (fail closed).
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

/** Take the lock file; a lock whose recorded owner is a dead process is reclaimed once. An unreadable or
 *  unparseable owner counts as live (fail closed), and the refusal names the file so an operator can clear it. */
function acquireLock(lock) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); return; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let text;
    try { text = readFileSync(lock, 'utf8').trim(); } catch (error) {
      if (error.code === 'ENOENT') continue; // released between our create and read: try again
      throw error;
    }
    const owner = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(owner) || owner < 1 || pidAlive(owner)) {
      throw new Error(`another file-held-cards run holds the ledger lock (${lock}${Number.isSafeInteger(owner) ? `, pid ${owner}` : ''}); retry when it finishes, or delete that file if no such run is alive`);
    }
    // Dead owner: only one reclaimer at a time (an exclusive guard file), and the lock is re-read under the guard,
    // so a fresh lock another run just created is never removed. The lock itself is never renamed or moved.
    const guard = `${lock}.reclaim`;
    try { writeFileSync(guard, String(process.pid), { flag: 'wx' }); } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`another file-held-cards run is reclaiming the ledger lock (${guard}); retry when it finishes, or delete that file if no such run is alive`);
      throw error;
    }
    try {
      let again = null;
      try { again = readFileSync(lock, 'utf8').trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (again === text) unlinkSync(lock);
    } finally { try { unlinkSync(guard); } catch { /* already gone */ } }
  }
  throw new Error(`could not take the ledger lock (${lock}); retry when other file-held-cards runs finish`);
}

export function fileHeldCardsOperation() {
  return op(FILE_HELD_CARDS_OP, {
    input: {
      source: { type: 'string', required: false, default: '' },
      select: { type: 'string', required: false, default: '' },
      since: { type: 'string', required: false, default: '' },
      max: { type: 'number', required: false, default: 10 },
      'dry-run': { type: 'boolean', required: false, default: false },
    },
    verdictFrom: 'options',
    options: compute({ reads: ['input'], fn: ({ input }) => {
      validateOptions(input);
      return input;
    } }),
    file: effect({ reads: ['verdict'], effects: ({ verdict }) => [{ type: BATCH_EFFECT, payload: verdict }] }),
  });
}

export function createFileHeldCardsSinks(deps) {
  return { [BATCH_EFFECT]: async input => {
    const result = await runFileHeldCards({ ...input, source: input.source || undefined,
      dryRun: input['dry-run'], deps: { ...deps, log: () => {} } });
    // A failed or refused card must fail a real run itself (CLI exit and HTTP status alike), not only the CLI
    // finisher. The message carries the filed card numbers: the thrown error is all that reaches the operator.
    // A dry run files nothing; its plan, refusals and duplicates ARE the product, so it returns them (the
    // finisher still exits non-zero on a refusal).
    if (!input['dry-run'] && (result.failed.length || result.refused.length)) {
      const tags = [...result.failed, ...result.refused].map(card => card.tag).join(', ');
      const filed = result.filed.map(row => `${row.card} (${row.tag})`).join(', ');
      throw new Error(safeLog(`file-held-cards: ${result.failed.length} failed and ${result.refused.length} refused card(s) (${tags}); ${result.filed.length} filed${filed ? `: ${filed}` : ''}`));
    }
    return result;
  } };
}

export function finishFileHeldCards(outcome, json = false) {
  const result = outcome.run?.effects?.find(entry => entry.type === BATCH_EFFECT)?.result;
  if (!result) return outcome;
  const lines = json ? [JSON.stringify(result)] : Object.entries(result).flatMap(([status, cards]) => cards.map(card =>
    // A refused card carries no title on purpose (it may hold the secret that got it refused).
    safeLog(`${status} ${card.tag} ${card.date}: ${card.title ?? '(withheld)'} [${card.scope || 'unscoped'}]`)));
  // A file-item failure must not look like success to automated callers.
  return { ...outcome, lines, ...(result.failed?.length || result.refused?.length ? { code: 1 } : {}) };
}
