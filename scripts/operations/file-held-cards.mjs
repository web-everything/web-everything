/** File held handoff cards through file-item in this checkout; never mutate the handoff. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync, unlinkSync, readFileSync, readdirSync, realpathSync, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { op, createRegistry } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
import { runOperationCli, parseOperationArgv } from './cli-adapter.mjs';
import { createMemoryRunStore, newRunId } from './run-store.mjs';
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

function assertLedgerIdentity(root, ledger, source) {
  try {
    const identity = statSync(ledger, { bigint: true, throwIfNoEntry: false });
    // New files and single-link files cannot already share an inode with another path.
    if (!identity || identity.nlink < 2n) return;
    const sameFile = path => {
      const candidate = lstatSync(path, { bigint: true });
      return candidate.dev === identity.dev && candidate.ino === identity.ino;
    };
    const containsIdentity = directory => readdirSync(directory, { withFileTypes: true }).some(entry => {
      const path = join(directory, entry.name);
      // Do not follow directory symlinks outside the repository or into cycles.
      return entry.isDirectory() ? containsIdentity(path) : sameFile(path);
    });
    if (sameFile(realpathSync(source)) || containsIdentity(root)) {
      throw new Error('ledger shares a file identity with the source or repository');
    }
  } catch (error) {
    throw new Error('--ledger identity is unsafe or could not be verified; choose a separate ledger outside the repository and distinct from --source', { cause: error });
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

function gitTrackedFiles(root) {
  // Not a git checkout (or git failing) means no qualification: bare paths are then simply refused as before.
  try { return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch { return []; }
}

export function composeFileItemInput(card) {
  // Whole text, cut at a word boundary: held cards often lead with a short ref ("#6381 slice 2") that is useless alone.
  const flat = card.text.replace(/\s+/g, ' ').trim();
  const title = flat.length <= 110 ? flat : flat.slice(0, 110).replace(/\s+\S*$/, '').replace(/[\s,;:—–-]+$/, '') + '…';
  const paths = [...card.text.matchAll(/\bwe:[A-Za-z0-9_./*-]+/g)].map(m => m[0].replace(/[.,;:!?]+$/, ''));
  return { title, digest: card.text, kind: 'task', size: '', queue: 'false',
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

async function fileInCheckout(input) {
  // This binding resolves file-item from script location, so every card lands in this lane.
  const { fileItemForPrevention } = await import('./review-loop-cli.mjs');
  // The shared argv builder expects scope, but unscoped cards must omit that flag.
  return fileItemForPrevention({ ...input, scope: input.scope ?? '' }, {
    run: args => runOperationCli({ ...args, argv: args.argv.filter(arg => arg !== '--scope=') }),
  });
}

async function runFileHeldCardsLocked({ source = join(homedir(), 'workspace', '.operations', 'handoff', 'cards-to-file.md'),
  ledger, dryRun = false, select, since, max = 10, deps = {} } = {}) {
  validateOptions({ max, since, select });
  const { root = REPO_ROOT, fileItem = fileInCheckout, log = console.log, now = () => new Date().toISOString() } = deps;
  source = resolve(expandHome(source));
  ledger = resolve(expandHome(ledger || join(dirname(source), 'cards-filed.jsonl')));
  const lexicalOutside = outsideRepository(resolve(root), ledger);
  ledger = resolveLedgerPath(ledger);
  if (!lexicalOutside || !outsideRepository(realpathSync(root), ledger) || ledger === realpathSync(source)) {
    throw new Error('--ledger must be outside the repository and distinct from --source');
  }
  assertLedgerIdentity(realpathSync(root), ledger, source);
  const tracked = deps.trackedFiles ? deps.trackedFiles() : gitTrackedFiles(root);
  const cards = selectUnfiled(parseCards(readFileSync(source, 'utf8')), readLedger(ledger), { select, since, max: Infinity });
  const titles = new Map();
  for (const name of readdirSync(join(root, 'backlog')).filter(name => name.endsWith('.md'))) {
    const content = readFileSync(join(root, 'backlog', name), 'utf8');
    const title = content.match(/^#\s+(.+)$/m)?.[1];
    if (!title) continue; // legacy untitled cards cannot be title-matched; they never block a run
    titles.set(titleKey(title), name);
  }
  const result = { planned: [], filed: [], duplicates: [], refused: [] };
  for (const card of cards) {
    // Refusals stay retryable but do not use the budget, so they cannot starve later valid cards.
    if (result.planned.length + result.filed.length + result.duplicates.length >= max) break;
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
    if (dryRun) { result.planned.push(summary); continue; }
    const row = { hash: card.hash, ...summary, card: null, filedAt: now() };
    // A truncated title is not a full identity: two distinct cards can share its first 110 chars.
    const duplicate = input.title.endsWith('…') ? undefined : titles.get(titleKey(input.title));
    if (duplicate) {
      Object.assign(row, { card: duplicate, status: 'duplicate' });
      result.duplicates.push(row);
      log(safeLog(`duplicate ${card.tag}: ${input.title}`));
    } else {
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
        result.refused.push(summary);
        log(safeLog(`refused ${card.tag}: correct the source card or inspect the file-item run before retrying`));
        continue;
      }
      result.filed.push(row);
      titles.set(titleKey(input.title), row.card);
      log(safeLog(`filed ${card.tag}: ${input.title}`));
    }
    // A ledger failure stops the batch: continuing could silently lose successful filing evidence.
    let separator = '';
    try {
      const existing = readFileSync(ledger, 'utf8');
      if (existing && !existing.endsWith('\n')) separator = '\n';
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    appendFileSync(ledger, `${separator}${JSON.stringify(row)}\n`);
  }
  return result;
}

export async function runFileHeldCards(options = {}) {
  if (options.dryRun) return runFileHeldCardsLocked(options);
  // Ledger-scoped lock held through select, filing and append, so overlapping runs cannot double-file a card.
  const source = resolve(expandHome(options.source || join(homedir(), 'workspace', '.operations', 'handoff', 'cards-to-file.md')));
  const lexical = resolve(expandHome(options.ledger || join(dirname(source), 'cards-filed.jsonl')));
  const canonical = resolveLedgerPath(lexical);
  const lock = `${canonical}.lock`;
  try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('another file-held-cards run holds the ledger lock; retry when it finishes');
    throw error;
  }
  try { return await runFileHeldCardsLocked(options); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}

export function fileHeldCardsOperation() {
  return op(FILE_HELD_CARDS_OP, {
    input: {
      source: { type: 'string', required: false, default: '' },
      ledger: { type: 'string', required: false, default: '' },
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
  return { [BATCH_EFFECT]: input => runFileHeldCards({ ...input, source: input.source || undefined,
    dryRun: input['dry-run'], deps: { ...deps, log: () => {} } }) };
}

export function finishFileHeldCards(outcome, json = false) {
  const result = outcome.run?.effects?.find(entry => entry.type === BATCH_EFFECT)?.result;
  if (!result) return outcome;
  const lines = json ? [JSON.stringify(result)] : Object.entries(result).flatMap(([status, cards]) => cards.map(card =>
    safeLog(`${status} ${card.tag} ${card.date}: ${card.title} [${card.scope || 'unscoped'}]`)));
  return { ...outcome, lines };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, ...deps } = {}) {
  try {
    const declaration = fileHeldCardsOperation();
    const parsed = parseOperationArgv(declaration, argv);
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    if (!parsed.control.help) validateOptions(parsed.input);
    const registry = createRegistry();
    registry.register(declaration);
    // Memory-only outer runs keep --dry-run free of even operation-store writes.
    const outcome = finishFileHeldCards(await runOperationCli({ declaration, argv, registry,
      store: createMemoryRunStore(), sinks: createFileHeldCardsSinks(deps), newRunId: () => newRunId(FILE_HELD_CARDS_OP),
    }), argv.includes('--json'));
    for (const line of outcome.lines) stdout.write(`${line}\n`);
    return outcome.code;
  } catch (error) { stderr.write(`${safeLog(error.message)}\n`); return 2; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
