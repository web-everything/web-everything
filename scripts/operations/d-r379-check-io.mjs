/** Bounded, injectable Git/GitHub/filesystem readers for D-R379. No shell evaluation. */
import { defaultListPrComments } from '../conveyor/pr-comments-list.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { readRedTeamDisposition } from '../lib/red-team-gate.mjs';
import { runGhSync } from '../lib/gh-throttle.mjs';
import * as realFs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { readPlatformPreferences, resolveCascade, formatCascadeSourcesLine } from '../lib/policy-cascade.mjs';
import { resolveLedgerReadStore, resolveLedgerBoard, validateLedgerEvent, verdictLedgerPath,
  defaultVerdictLedgerDir } from '../lib/verdict-ledger.mjs';
import { readLedgerFromGit } from '../lib/verdict-ledger-io.mjs';
import { ledgerGitPath } from '../lib/verdict-ledger-path.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

const POLICY = new URL('../settings/d-r379-protected-paths.json', import.meta.url);
const AUDIT_SETTINGS = new URL('../settings/prototype-load.json', import.meta.url);
const DEFAULT_AUDIT_PATH = '~/workspace/.operations/coordination/audits.jsonl';
const SHA = /^[a-f\d]{40}$/i;
const MAX_BYTES = 8 * 1024 * 1024;
const safeLog = text => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

function realExec(bin, args, options) {
  if (bin === 'gh') {
    return runGhSync(args, options);
  }
  return execFileSync(bin, args, options);
}

const RED_TEAM_LIMIT = 1024 * 1024;
/** Shared trusted, current-head red-team evidence reader; unknown evidence requires operator review. */
export function readRedTeam(pr, head, { cwd = process.cwd(), env = process.env, exec = realExec } = {}) {
  const LIMIT = RED_TEAM_LIMIT;
  const requireFact = (ok, reason) => { if (!ok) throw Error(reason); };
  requireFact(Number.isSafeInteger(pr) && pr > 0 && /^[a-f\d]{40}$/i.test(head), 'invalid red-team scope');
  let bytes = 0;
  const comments = defaultListPrComments({ number: pr, repo: CONSTELLATION_REPOS.we.slug, maxPages: 10, gh: args => {
    const output = exec('gh', args, { cwd, env, encoding: 'utf8', timeout: 60_000,
      maxBuffer: LIMIT, stdio: ['ignore', 'pipe', 'pipe'] });
    requireFact(typeof output === 'string' || Buffer.isBuffer(output), 'invalid comment output; operator review required');
    bytes += Buffer.byteLength(output);
    requireFact(bytes <= LIMIT, 'comment byte bound exceeded; operator review required');
    return JSON.parse(String(output));
  } });
  let newest = null, latestMention = null;
  for (const [index, comment] of comments.entries()) {
    requireFact(typeof comment.body === 'string', 'incomplete comment evidence; operator review required');
    const at = typeof comment.createdAt === 'string' ? Date.parse(comment.createdAt) : NaN;
    requireFact(Number.isFinite(at), 'comment timestamp unknown; operator review required');
    // Restrictive evidence need not be a well-formed marker or a trusted author.
    // Include other-head mentions too: an unparsed comment cannot prove its scope.
    if (/red-team|we:red-team|send-back|block/i.test(comment.body)
      && (!latestMention || at >= latestMention.at)) latestMention = { at, index };
    if (!isTrustedMarkerAuthor(comment)) continue;
    const marker = /^<!-- we:red-team-advisory pr=(\d+) rev=([a-f\d]{40}) -->/i.exec(comment.body.trimStart());
    if (!marker || Number(marker[1]) !== pr || marker[2] !== head) continue;
    // Read the producer's recorded verdict, never infer clear from an empty parse.
    const verdict = /^Advisory only:.* · recorded verdict `([^`]+)`\.$/m.exec(comment.body)?.[1];
    if (!newest || at >= newest.at) newest = { at, index, head: marker[2], result: verdict === 'accept' ? 'clear' : (verdict ?? 'unknown') };
  }
  if (!newest) return null;
  const disposition = readRedTeamDisposition({ comments, pr, head, repo: CONSTELLATION_REPOS.we.slug, env });
  // Empty finding arrays are not an explicit resolution: the parser can drop
  // malformed findings and their later rulings. Without aggregate clearance,
  // require a fresh advisory after any later relevant comment (ties use order).
  const laterMention = latestMention && (latestMention.at > newest.at
    || (latestMention.at === newest.at && latestMention.index > newest.index));
  const result = disposition.sendBack.length || disposition.held.length ? 'blocked'
    : !disposition.result || (newest.result === 'clear' && laterMention) ? 'unknown' : newest.result;
  return { head: newest.head, result };
}

/** exec(bin, argv, options), fs, home, env, cwd and output streams are hermetically replaceable. */
export function createCheckDeps({ cwd = process.cwd(), home = homedir(), env = process.env,
  fs = realFs, exec = realExec, readLedger, readGitLedger = readLedgerFromGit, stdout = text => process.stdout.write(text),
  stderr = text => process.stderr.write(text) } = {}) {
  const options = { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'] };
  // Name-only rename output otherwise omits the protected source of a move. Disable
  // rename folding so both the deleted source and added destination are classified.
  const gitEnv = { ...env };
  const configCount = Number(gitEnv.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(configCount) || configCount < 0 || configCount > 1000) throw new Error('invalid Git configuration count');
  gitEnv.GIT_CONFIG_COUNT = String(configCount + 1);
  gitEnv[`GIT_CONFIG_KEY_${configCount}`] = 'diff.renames';
  gitEnv[`GIT_CONFIG_VALUE_${configCount}`] = 'false';
  const run = async (bin, args, strictUtf8 = false) => {
    const execOptions = { ...options, ...(bin === 'git' ? { env: gitEnv } : {}),
      ...(strictUtf8 ? { encoding: null } : {}) };
    const output = await exec(bin, args, execOptions);
    if (typeof output !== 'string' && !Buffer.isBuffer(output)) throw new Error('incomplete command output');
    if (Buffer.byteLength(output) > MAX_BYTES) throw new Error('output bound exceeded; human review required');
    return strictUtf8 && Buffer.isBuffer(output) ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output) : String(output);
  };
  const read = path => {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error('not a regular evidence file');
      if (stat.size > MAX_BYTES) throw new Error('file bound exceeded; human review required');
      // One descriptor binds all reads to the opened file even if the path is replaced.
      // The extra byte detects growth without ever reading the unbounded remainder.
      const buffer = Buffer.allocUnsafe(MAX_BYTES + 1);
      let consumed = 0;
      while (consumed < buffer.length) {
        const count = fs.readSync(fd, buffer, consumed, buffer.length - consumed, null);
        if (count === 0) break;
        consumed += count;
      }
      if (consumed > MAX_BYTES) throw new Error('file grew beyond bound; human review required');
      return buffer.toString('utf8', 0, consumed);
    } finally {
      fs.closeSync(fd);
    }
  };
  const configuredPolicy = (name, tool, standard) => {
    const platform = readPlatformPreferences({ env, readFile: read, warn: text => stderr(`${safeLog(text)}\n`) });
    if (platform.errors.length) throw new Error('unreadable platform preferences');
    const resolved = resolveCascade({ standard, platform: platform.prefs[name], tool });
    stderr(`${safeLog(formatCascadeSourcesLine(name, resolved))}\n`);
    return resolved.value;
  };
  const checkPrNumber = pr => {
    if (!Number.isSafeInteger(pr) || pr < 1) throw new Error('invalid PR number');
  };
  const checkSha = head => {
    if (typeof head !== 'string' || !SHA.test(head)) throw new Error('invalid commit');
  };
  return {
    readRedTeam: (pr, head) => readRedTeam(pr, head, { cwd, env, exec }),
    async readPr(pr) {
      checkPrNumber(pr);
      return JSON.parse(await run('gh', ['pr', 'view', String(pr), '--repo', CONSTELLATION_REPOS.we.slug, '--json', 'title,body,headRefOid,baseRefName']));
    },
    async readLabels(pr, head) {
      checkPrNumber(pr);
      const snapshot = JSON.parse(await run('gh', ['pr', 'view', String(pr), '--repo', CONSTELLATION_REPOS.we.slug, '--json', 'labels,headRefOid,baseRefName']));
      if (snapshot.headRefOid !== head) throw new Error('PR head moved; retry');
      if (snapshot.baseRefName !== 'main') throw new Error('PR target is not main or is unavailable; human review required');
      return snapshot.labels;
    },
    async readLabelEvents(pr) {
      checkPrNumber(pr);
      const events = [];
      let bytes = 0;
      // At most ten calls / 1000 issue events; a full final page cannot prove completeness.
      for (let page = 1; page <= 10; page++) {
        const text = await run('gh', ['api',
          `repos/${CONSTELLATION_REPOS.we.slug}/issues/${pr}/events?per_page=100&page=${page}`]);
        bytes += Buffer.byteLength(text);
        if (bytes > MAX_BYTES) throw new Error('label timeline byte bound exceeded; human review required');
        const rows = JSON.parse(text);
        if (!Array.isArray(rows) || rows.length > 100) throw new Error('invalid label timeline page; human review required');
        for (const row of rows) {
          if (!row || typeof row.event !== 'string') throw new Error('invalid issue event; human review required');
          if (!['labeled', 'unlabeled'].includes(row.event)) continue;
          if (typeof row.label?.name !== 'string') throw new Error('invalid label event; human review required');
          if (['review:human', 'review:pending'].includes(row.label.name)) events.push(row);
        }
        if (rows.length < 100) return events;
      }
      throw new Error('label timeline page bound exceeded; human review required');
    },
    async readReviewLedger(pr) {
      checkPrNumber(pr);
      const repo = CONSTELLATION_REPOS.we.slug;
      const ledgerOptions = { env, log: text => stderr(`${safeLog(text)}\n`) };
      let result;
      if (readLedger) result = await readLedger(repo, ledgerOptions);
      else {
        // The shared rows-only reader drops invalid lines. Inspect the raw snapshot
        // from the same configured store instead; never downgrade to another store.
        const store = resolveLedgerReadStore(undefined, env);
        const explicit = env.WE_VERDICT_LEDGER_READ_STORE?.trim().toLowerCase();
        if (explicit && !['home', 'git'].includes(explicit)) throw new Error('unsupported strict ledger store');
        if (store === 'git') {
          const board = resolveLedgerBoard(repo, {}, env);
          if (!board) throw new Error('verdict ledger board unavailable');
          result = await readGitLedger({ ...ledgerOptions, board, repo });
        } else if (store === 'home') {
          const path = env === process.env ? verdictLedgerPath(repo)
            : join(env.WE_VERDICT_LEDGER_DIR?.trim() || defaultVerdictLedgerDir(home), ledgerGitPath(repo).split('/').at(-1));
          result = { status: 'ok', text: read(path) };
        } else throw new Error('unsupported strict ledger store');
      }
      if (result?.status !== 'ok' || typeof result.text !== 'string') {
        throw new Error('raw verdict ledger unavailable; human review required');
      }
      if (Buffer.byteLength(result.text) > MAX_BYTES) throw new Error('ledger bound exceeded; human review required');
      const lines = result.text.split(/\r?\n/).filter(line => line.trim());
      if (lines.length > 100_000) throw new Error('ledger row bound exceeded; human review required');
      const rows = [];
      for (const line of lines) {
        // An unparseable line has unknown scope and cannot be safely discarded.
        const raw = JSON.parse(line);
        if (!Number.isSafeInteger(raw?.pr) || raw.pr < 1) throw new Error('unknown ledger PR; human review required');
        if (raw.pr !== pr) continue;
        const { valid, record } = validateLedgerEvent(raw);
        if (!valid) throw new Error('invalid ledger event; human review required');
        if (record.repo.toLowerCase() === repo.toLowerCase()) rows.push(record);
      }
      return rows;
    },
    async fetchNetDiff(pr, head) {
      checkPrNumber(pr);
      checkSha(head);
      await run('git', ['fetch', 'origin', 'main']);
      await run('git', ['fetch', 'origin', `pull/${pr}/head`]);
      const fetched = (await run('git', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
      if (fetched !== head) throw new Error('fetched head differs from PR head; retry');
      const base = (await run('git', ['merge-base', 'origin/main', head])).trim();
      checkSha(base);
      const text = await run('git', ['diff', '--no-relative', '--no-ext-diff', '--no-renames', base, head, '--name-only', '-z'], true);
      if (!text) return {paths: [], base};
      if (!text.endsWith('\0')) throw new Error('incomplete NUL-delimited diff');
      const paths = text.slice(0, -1).split('\0');
      if (paths.length > 10_000) throw new Error('diff bound exceeded; human review required');
      return {paths, base};
    },
    readRulingNumstat(base, head, paths) {
      checkSha(base);
      checkSha(head);
      if (!Array.isArray(paths) || !paths.length || paths.length > 1000
        || paths.some(path => typeof path !== 'string' || !path || path.length > 4096
          || path.startsWith('/') || path.includes('\\') || path.includes('\0')
          || path.split('/').some(part => !part || part === '.' || part === '..'))) {
        throw new Error('invalid ruling paths; human review required');
      }
      return run('git', ['--literal-pathspecs', 'diff', '--no-relative', '--no-ext-diff', '--no-renames', '--numstat', '-z', base, head, '--', ...paths]);
    },
    readRulingDiff(base, head, paths) {
      checkSha(base);
      checkSha(head);
      if (!Array.isArray(paths) || !paths.length || paths.length > 1000
        || paths.some(path => typeof path !== 'string' || !path || path.length > 4096
          || path.startsWith('/') || path.includes('\\') || path.includes('\0')
          || path.split('/').some(part => !part || part === '.' || part === '..'))) {
        throw new Error('invalid ruling paths; human review required');
      }
      return run('git', ['--literal-pathspecs', 'diff', '--no-relative', '--no-ext-diff', '--no-renames', '--no-textconv', '--unified=0', base, head, '--', ...paths]);
    },
    readRulingFile(sha, path) {
      checkSha(sha);
      if (typeof path !== 'string' || !path || path.length > 4096
        || path.startsWith('/') || path.includes('\\') || path.includes('\0')
        || path.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('invalid ruling path; human review required');
      }
      return run('git', ['show', `${sha}:${path}`]);
    },
    readHeadFile(head, path) {
      checkSha(head);
      if (typeof path !== 'string' || !/^backlog\/[^/]+\.md$/.test(path) || path.includes('\0')) throw new Error('invalid card path');
      return run('git', ['show', `${head}:${path}`]);
    },
    async readBaseFile(base, path) {
      checkSha(base);
      if (typeof path !== 'string' || !/^backlog\/[^/]+\.md$/.test(path) || path.includes('\0')) throw new Error('invalid card path');
      try { return await run('git', ['show', `${base}:${path}`]); }
      catch (error) {
        // A failed show alone cannot distinguish a new card from corrupt/missing Git
        // evidence. Only a successful, empty exact-path tree lookup proves absence.
        const entry = await run('git', ['ls-tree', '-z', base, '--', path]);
        if (entry === '') return null;
        throw error;
      }
    },
    readSettings() {
      return configuredPolicy('d-r379-protected-paths', JSON.parse(read(POLICY)), {});
    },
    readAudits() {
      let tool;
      try { tool = JSON.parse(read(AUDIT_SETTINGS)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; tool = {}; }
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new Error('invalid audit settings');
      const { auditRecordPath: configured } = configuredPolicy('d-r379-audit',
        { ...(Object.hasOwn(tool, 'auditRecordPath') ? { auditRecordPath: tool.auditRecordPath } : {}) },
        { auditRecordPath: DEFAULT_AUDIT_PATH });
      if (typeof configured !== 'string' || !configured.trim()) throw new Error('invalid auditRecordPath');
      const path = configured.startsWith('~/') ? join(home, configured.slice(2))
        : configured === '~' ? home : resolve(cwd, configured);
      const lines = read(path).split(/\r?\n/).filter(line => line.trim());
      if (lines.length > 100_000) throw new Error('audit record bound exceeded; human review required');
      return lines.map(line => {
        const record = JSON.parse(line);
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid audit record');
        return record;
      });
    },
    stdout,
    stderr,
  };
}
