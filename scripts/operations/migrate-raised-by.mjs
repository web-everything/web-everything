#!/usr/bin/env node
/** Move append-only raised-by PRs to per-note files; dry-run unless --apply. */
import { execFileSync, spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseRaisedBy, raisedByKey, raisedByFile, readRaisedBy } from '../lib/raised-by.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { ghRepoSlug } from '../lib/constellation-repos.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = ghRepoSlug('we');
const FIELDS = 'number,headRefName,headRefOid,labels,isDraft,baseRefName,headRepositoryOwner,isCrossRepository';
const positive = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const safeError = error => String(error?.message ?? error).replace(/\/\/[^/\s]+@/g, '//[redacted]@');

export function parseArgs(argv) {
  const options = { apply: false, json: false };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('--max=') && positive(arg.slice(6))) options.max = Number(arg.slice(6));
    else if (arg.startsWith('--pr=') && arg.slice(5).split(',').every(positive)) options.prs = arg.slice(5).split(',').map(Number);
    else throw new Error(`Invalid argument: ${arg}`);
  }
  return options;
}

export function resolveMax(options = {}, { env = process.env, settings = readSettings } = {}) {
  if (options.max !== undefined) {
    if (!positive(options.max)) throw new Error('--max must be a positive integer');
    return { value: Number(options.max), source: '--max' };
  }
  const override = env.WE_RAISED_BY_MIGRATE_MAX_PRS;
  if (override !== undefined && override !== '') {
    if (!positive(override)) throw new Error('WE_RAISED_BY_MIGRATE_MAX_PRS must be a positive integer');
    return { value: Number(override), source: 'env' };
  }
  const configured = settings()?.raisedByMigrate?.maxPrsPerRun;
  if (configured !== undefined) {
    if (!positive(configured)) throw new Error('raisedByMigrate.maxPrsPerRun must be a positive integer');
    return { value: Number(configured), source: 'settings' };
  }
  return { value: 10, source: 'default' };
}

function inspect(git, main, head, snapshot, fs, readRaises) {
  const basis = `${main}...${head}`;
  const changes = git(['diff', '--name-status', '-z', '--no-renames', basis]).split('\0').filter(Boolean);
  const reasons = new Set(), moved = [], files = new Map(), known = new Map();
  for (let i = 0; i < changes.length; i += 2) {
    const status = changes[i], card = changes[i + 1];
    if (status !== 'M' || !/^backlog\/[^/]+\.md$/.test(card)) { reasons.add('other-files'); continue; }
    // Check the current main, not the PR's merge-base copy of the card.
    const disk = join(snapshot, card);
    if (!fs.existsSync(disk)) { reasons.add('card-missing-on-main'); continue; }
    if (!fs.lstatSync(disk).isFile()) { reasons.add('other-files'); continue; }
    const body = fs.readFileSync(disk, 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1] ?? '';
    if (!/^status:[ \t]*(["']?)open\1[ \t]*\r?$/m.test(frontmatter)) { reasons.add('card-not-open'); continue; }
    const cardId = card.slice('backlog/'.length).split('-')[0];
    if (!known.has(cardId)) known.set(cardId, new Set(readRaises(cardId, snapshot).map(raisedByKey)));
    const keys = known.get(cardId);
    const diff = git(['diff', '--unified=0', '--no-ext-diff', '--no-textconv', basis, '--', card]);
    if (/^(?:old|new) mode /m.test(diff)) reasons.add('other-files');
    // Binary differences (and any other hunkless change) cannot be proven append-only.
    if (!/^@@ /m.test(diff)) { reasons.add('unsupported-card-diff'); continue; }
    let inHunk = false;
    for (const line of diff.split('\n')) {
      if (line.startsWith('@@')) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (line.startsWith('-')) { reasons.add('removed-lines'); continue; }
      if (!line.startsWith('+')) continue;
      const added = line.slice(1);
      if (!added.trim() || added === '## Also raised by') continue;
      const records = parseRaisedBy(added);
      if (records.length !== 1) { reasons.add('other-added-lines'); continue; }
      let file;
      try { file = raisedByFile(cardId, added); }
      catch { reasons.add('other-added-lines'); continue; }
      const key = raisedByKey(records[0]);
      const present = keys.has(key) || fs.existsSync(join(snapshot, file.path));
      moved.push({ card, line: added, disposition: present ? 'already-present' : 'create' });
      if (!present) files.set(file.path, file);
      keys.add(key);
    }
  }
  if (!moved.length) reasons.add('no-mention-lines');
  return { reasons: [...reasons], moved, files: [...files.values()] };
}

/** All process/filesystem boundaries can be replaced by a caller; writes stay in scratch until leased push. */
export function migrateRaisedBy(options = {}, deps = {}) {
  const { fs = nodeFs, exec = execFileSync, spawn = spawnSync, env = process.env, settings = readSettings,
    gh = args => exec('gh', args, { cwd: options.root ?? ROOT, encoding: 'utf8', stdio: 'pipe' }),
    tempRoot = tmpdir(), readRaises = readRaisedBy } = deps;
  const root = options.root ?? ROOT;
  const max = resolveMax(options, { env, settings });
  const result = { apply: !!options.apply, max, prs: [] };
  const remote = String(exec('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: 'pipe' })).trim();
  const prs = JSON.parse(gh(['pr', 'list', '--repo', REPO, '--state=open', '--limit=10000', '--json', FIELDS]));
  const scratch = fs.mkdtempSync(join(tempRoot, 'migrate-raised-by-'));
  const bare = join(scratch, 'git');
  // execFileSync otherwise echoes raw child stderr before throwing, bypassing error redaction.
  const git = (args, extra = {}) => exec('git', args, { cwd: bare, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024, ...extra });
  let processed = 0;
  try {
    exec('git', ['init', '--bare', bare], { cwd: scratch, encoding: 'utf8', stdio: 'pipe' });
    for (const pr of prs) {
      if (options.prs && !options.prs.includes(pr.number)) continue;
      const row = { number: pr.number, branch: pr.headRefName, head: pr.headRefOid, status: 'skipped', reasons: [], moved: [], files: [] };
      result.prs.push(row);
      if (pr.isCrossRepository || (pr.headRepositoryOwner?.login && pr.headRepositoryOwner.login !== 'web-everything')) row.reasons.push('cross-repository');
      if (pr.baseRefName !== 'main') row.reasons.push('non-main-base');
      const labels = (pr.labels ?? []).map(l => typeof l === 'string' ? l : l.name);
      for (const label of ['review:changes', 'review:human']) if (labels.includes(label)) row.reasons.push(`has-hold-label ${label}`);
      if (row.reasons.length) continue;
      let snapshot;
      try {
        git(['check-ref-format', `refs/heads/${pr.headRefName}`]);
        git(['fetch', '--no-tags', remote, '+refs/heads/main:refs/remotes/origin/main', `+refs/heads/${pr.headRefName}:refs/migration/head`]);
        const main = git(['rev-parse', 'refs/remotes/origin/main']).trim();
        const head = git(['rev-parse', 'refs/migration/head']).trim();
        if (head !== pr.headRefOid) { row.reasons.push('head-changed'); continue; }
        snapshot = fs.mkdtempSync(join(scratch, 'main-'));
        if (git(['ls-tree', '--name-only', main, '--', 'backlog']).trim()) {
          const archive = git(['archive', main, 'backlog'], { encoding: null });
          exec('tar', ['-xf', '-', '-C', snapshot], { input: archive, stdio: 'pipe' });
        }
        Object.assign(row, inspect(git, main, head, snapshot, fs, readRaises));
        if (row.reasons.length) continue;
        // Keep the original head when main already contains every mention; never create an empty PR.
        if (!row.files.length) { row.reasons.push('all-mentions-already-present'); continue; }
        row.status = 'migratable';
        if (!options.apply) continue;
        if (processed >= max.value) { row.status = 'max-reached'; continue; }
        processed++;
        const index = join(snapshot, 'index');
        const indexGit = (args, extra = {}) => git(args, { ...extra, env: { ...env, GIT_INDEX_FILE: index } });
        indexGit(['read-tree', main]);
        for (const file of row.files) {
          const blob = indexGit(['hash-object', '-w', '--stdin'], { input: file.content }).trim();
          indexGit(['update-index', '--add', '--cacheinfo', '100644', blob, file.path]);
        }
        const tree = indexGit(['write-tree']).trim();
        const message = `backlog: move raised-by lines to per-note files (PR #${pr.number})\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>\n`;
        row.newHead = git(['-c', 'user.name=Raised-by migration', '-c', 'user.email=noreply@anthropic.com', 'commit-tree', tree, '-p', main], { input: message }).trim();
        const ref = `refs/heads/${pr.headRefName}`;
        try { git(['push', `--force-with-lease=${ref}:${head}`, remote, `${row.newHead}:${ref}`]); }
        catch { row.status = 'push-rejected'; row.reasons.push('lease-rejected-or-push-failed'); continue; }
        row.status = 'migrated';
        if (labels.includes('review:accepted')) {
          let carried = false;
          try {
            const stamp = spawn(process.execPath, [join(root, 'scripts/review-set-label.mjs'), String(pr.number), `--repo=${REPO}`,
              '--to=restamp', '--actor=drain', '--channel=drain-rebase',
              `--reason=head moved to ${row.newHead} by raised-by migration`, `--new-head=${row.newHead}`], { cwd: root, encoding: 'utf8' });
            carried = stamp.status === 0;
          } catch { /* Roll back on spawn errors too. */ }
          if (carried) row.restamped = true;
          else {
            row.status = 'refused: approval could not be carried';
            try {
              git(['push', `--force-with-lease=${ref}:${row.newHead}`, remote, `${head}:${ref}`]);
              row.rolledBack = true;
            } catch {
              row.rolledBack = false;
              row.reasons.push('rollback-push-failed: branch requires operator recovery');
            }
          }
        }
      } catch (error) {
        row.status = 'skipped';
        row.reasons.push(`probe-or-build-failed: ${safeError(error)}`);
      } finally {
        if (snapshot) fs.rmSync(snapshot, { recursive: true, force: true });
      }
    }
    return result;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

export function formatResult(result) {
  const lines = [`raisedByMigrate.maxPrsPerRun=${result.max.value} (${result.max.source})`];
  for (const pr of result.prs) {
    lines.push(`#${pr.number} ${pr.branch} ${pr.head}: ${pr.status}${pr.reasons.length ? ` (${pr.reasons.join('; ')})` : ''}`);
    for (const move of pr.moved) lines.push(`  ${move.card} -> ${move.line} [${move.disposition}]`);
    for (const file of pr.files) lines.push(`  ${result.apply ? 'file' : 'would create'} ${file.path}`);
    if (pr.restamped) lines.push(`  acceptance restamped at ${pr.newHead}`);
    if (pr.rolledBack) lines.push('  restored old head with expect-head lease');
  }
  return lines.join('\n');
}

/** Return the CLI exit code so recovery failures are tested through the same output path. */
export function runCli(argv, { migrate = migrateRaisedBy, stdout = console.log, stderr = console.error } = {}) {
  try {
    const options = parseArgs(argv);
    const result = migrate(options);
    stdout(options.json ? JSON.stringify(result, null, 2) : formatResult(result));
    return result.prs.some(pr => pr.status.startsWith('refused:') || pr.status === 'push-rejected' || pr.reasons.some(r => r.startsWith('probe-or-build-failed:'))) ? 1 : 0;
  } catch (error) { stderr(safeError(error)); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
