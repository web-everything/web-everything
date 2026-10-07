#!/usr/bin/env node
/**
 * @file scripts/readiness/prep-staleness.mjs
 * @description Story preparation staleness signature check (backlog item #3108).
 *   Diffs a card's declared `scope:` files against the git commit sha it was prepared
 *   against (`preparedAgainstSha`), reporting presence of drift.
 *
 *   The mechanical check answers PRESENCE only, never SEVERITY: it reports WHICH scope
 *   files changed since `preparedAgainstSha`, not how bad that is.
 *
 * Usage:
 *   node scripts/readiness/prep-staleness.mjs --item=<NNN> [--json]
 */

import { readGit } from '../lib/proc-read.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readField } from '../backlog/frontmatter.mjs';
import { idFromName } from '../backlog/id.mjs';

/**
 * Diffs a card's declared scope against the repo commit it was prepared against.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.scope]
 * @param {string} [opts.preparedAgainstSha]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {string} [opts.head='HEAD'] - the tip to compare against (the build daemon passes `origin/main`, card 80:
 *   a daemon clone's HEAD can carry overlay commits that are not on main).
 * @returns {{ checked: true, stale: boolean, changedFiles: string[], skipped: string[] } | { checked: false, reason: string }}
 *   checked:false when the card has no preparedAgainstSha (nothing to compare) or the sha is unreachable
 *   (e.g. squash-merged and gc'd) — NOT an error, a "can't tell" result the caller must handle explicitly.
 *   `skipped`: scope entries this repo's diff cannot check (non-`we:` locus prefixes — another repo's
 *   files) — listed, never silently dropped.
 */
export function checkPrepStaleness({ scope, preparedAgainstSha, cwd = process.cwd(), head = 'HEAD' } = {}) {
  if (!preparedAgainstSha || typeof preparedAgainstSha !== 'string' || !preparedAgainstSha.trim()) {
    return { checked: false, reason: 'no preparedAgainstSha' };
  }

  const sha = preparedAgainstSha.trim();

  // Verify that the sha is reachable in git
  try {
    readGit(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return { checked: false, reason: `unreachable commit sha: ${sha}` };
  }

  const rawScope = Array.isArray(scope) ? scope : [];
  const scopeFiles = [];
  const skipped = [];

  for (const entry of rawScope) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const trimmed = entry.trim();
    if (trimmed.startsWith('we:')) {
      const rel = trimmed.slice(3).trim();
      if (rel) scopeFiles.push(rel);
    } else {
      skipped.push(trimmed);
    }
  }

  if (scopeFiles.length === 0) {
    return {
      checked: true,
      stale: false,
      changedFiles: [],
      skipped,
    };
  }

  try {
    const stdout = readGit(['diff', '--name-only', sha, head, '--', ...scopeFiles], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const changedFiles = Array.from(new Set(
      stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ));
    return {
      checked: true,
      stale: changedFiles.length > 0,
      changedFiles,
      skipped,
    };
  } catch (err) {
    return { checked: false, reason: `git diff failed: ${err?.message || err}` };
  }
}

/**
 * CLI runner for prep-staleness.
 * @param {string[]} [argv=process.argv.slice(2)]
 */
export function runCli(argv = process.argv.slice(2)) {
  let itemArg = null;
  let json = false;
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--item=')) {
      itemArg = arg.slice('--item='.length);
    } else if (arg === '--item' && i + 1 < argv.length) {
      itemArg = argv[++i];
    } else if (arg.startsWith('--cwd=')) {
      cwd = arg.slice('--cwd='.length);
    } else if (arg.startsWith('--backlog-dir=')) {
      process.env.WE_BACKLOG_DIR = arg.slice('--backlog-dir='.length);
    } else if (arg === '--json') {
      json = true;
    } else if (!arg.startsWith('--') && !itemArg) {
      itemArg = arg;
    }
  }

  if (!itemArg) {
    console.error('Usage: node scripts/readiness/prep-staleness.mjs --item=<NNN>');
    process.exit(1);
  }

  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const requireCjs = createRequire(import.meta.url);
  const loadBacklog = requireCjs(join(ROOT, 'src/_data/backlog.js'));
  const items = typeof loadBacklog === 'function' ? loadBacklog() : loadBacklog;

  const cleanItem = String(itemArg).replace(/^#/, '');
  const targetId = idFromName(cleanItem) || cleanItem;
  const backlogItem = (items || []).find(
    (b) => b.num === targetId || b.id === targetId || b.id === cleanItem || b.id?.startsWith(`${targetId}-`),
  );

  const backlogDir = process.env.WE_BACKLOG_DIR || join(ROOT, 'backlog');
  let file = null;
  try {
    const allFiles = readdirSync(backlogDir);
    file = allFiles.find(
      (f) => f.endsWith('.md') && (f === `${targetId}.md` || f === `${cleanItem}.md` || f.startsWith(`${targetId}-`)),
    );
  } catch {}

  if (!file && !backlogItem) {
    console.error(`Backlog item #${targetId} not found`);
    process.exit(1);
  }

  let content = '';
  if (file) {
    content = readFileSync(join(backlogDir, file), 'utf8');
  }

  const preparedAgainstSha = readField(content, 'preparedAgainstSha');
  let scope = backlogItem?.scope;
  if (!scope && content) {
    try {
      const gm = requireCjs('gray-matter');
      const data = gm(content)?.data;
      if (Array.isArray(data?.scope)) {
        scope = data.scope;
      }
    } catch {}
  }
  if (!scope) scope = [];

  const result = checkPrepStaleness({ scope, preparedAgainstSha, cwd });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.checked) {
    console.log(`not staleness-checked — ${result.reason}`);
  } else if (result.stale) {
    for (const changed of result.changedFiles) {
      console.log(changed);
    }
  } else {
    console.log('no drift');
  }
}

const IS_CLI = process.argv[1] && (
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) ||
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
);

if (IS_CLI) {
  runCli(process.argv.slice(2));
}
