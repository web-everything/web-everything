/** Fail-closed evidence readers and the single atomic runtime-list writer. */
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { normalizeBriefScope, SCOPE_PREFIX_ALIASES } from './dispatch-lane.mjs';
import { GH_LIST_FILE_CAP, prHoldsFile, qualifyFile, repoKeyFor } from './free-scope.mjs';
import { resolveCoordinationRoot } from './coordination-root.mjs';
import { buildPrioritySetOperation, BUILD_PRIORITY_SET_EFFECT, validateBuildPriorityInput } from './build-priority-set.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const READ_OPTIONS = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] };
const canonicalId = id => id.replace(/^0+(?=\d)/, '');
const refuse = why => { throw new Error(`build-priority-set: ${why}; repair evidence or drain open PRs and retry`); };

/** One pinned main snapshot per reader; no worktree cards, fetching or lazy network reads. */
export function readPriorityCards({ git = args => execFileSync('git', args, {
  ...READ_OPTIONS, maxBuffer: 8 * 1024 * 1024, cwd: ROOT, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
}) } = {}) {
  let sha, names;
  return id => {
    if (!names) {
      sha = git(['rev-parse', '--verify', 'refs/remotes/origin/main']).trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) refuse('unreadable origin/main');
      names = git(['ls-tree', '-r', '--name-only', '-z', sha, '--', 'backlog']).split('\0').filter(Boolean);
    }
    const matches = names.filter(name => {
      const match = /^backlog\/(\d+)-[^/]+\.md$/.exec(name);
      return match && canonicalId(match[1]) === canonicalId(id);
    });
    if (matches.length !== 1) refuse(`card ${id} missing or ambiguous on origin/main`);
    const text = git(['show', `${sha}:${matches[0]}`]);
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!front) refuse(`card ${id} has unreadable YAML frontmatter`);
    const data = yaml.load(front[1]);
    return { scope: data?.scope };
  };
}

/** At most three bounded list calls. At either cap, an operator must drain and retry. */
export function readPriorityPrs({ gh = args => runGhSync(args, READ_OPTIONS) } = {}) {
  const prs = [];
  for (const { slug } of Object.values(CONSTELLATION_REPOS)) {
    const rows = JSON.parse(gh(['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '200', '--json', 'number,files']));
    if (!Array.isArray(rows) || rows.length >= 200) refuse('incomplete open PR list (limit 200)');
    for (const row of rows) {
      if (!Number.isInteger(row?.number) || row.number <= 0 || !Array.isArray(row.files)
          || row.files.length >= GH_LIST_FILE_CAP || row.files.some(f => typeof f?.path !== 'string' || !f.path.trim()
            || (f.previousFilename != null && typeof f.previousFilename !== 'string'))) {
        refuse('incomplete open PR files');
      }
      prs.push({ repo: slug, number: row.number, files: row.files.flatMap(f => [f.path, ...(f.previousFilename ? [f.previousFilename] : [])]) });
    }
  }
  return prs;
}

function prepare(input, options) {
  const { actor, reason, ids, mode, ttlHours } = validateBuildPriorityInput(input);
  if (new Set(ids.map(canonicalId)).size !== ids.length) refuse('duplicate numeric card identities');
  const readCard = options.readCard ?? readPriorityCards();
  const scopes = ids.flatMap(id => {
    const card = readCard(id);
    const raw = typeof card?.scope === 'string' ? [card.scope] : card?.scope;
    if (!Array.isArray(raw) || !raw.length || raw.some(s => typeof s !== 'string' || !s.trim())) refuse(`card ${id} missing or unreadable scope`);
    const scope = raw.flatMap(member => {
      const normalized = normalizeBriefScope([member]);
      if (!normalized.length) refuse(`card ${id} empty scope member`);
      return normalized.map(s => qualifyFile(s));
    });
    if (!scope.length) refuse(`card ${id} empty scope`);
    return scope;
  });
  const prs = (options.readPrs ?? readPriorityPrs)();
  if (!Array.isArray(prs)) refuse('unreadable PR source');
  for (const pr of prs) {
    if (!Object.values(CONSTELLATION_REPOS).some(r => r.slug === pr?.repo) || !Number.isInteger(pr.number)
        || !Array.isArray(pr.files) || pr.files.some(f => typeof f !== 'string' || !f.trim())) refuse('unreadable PR files');
    // Scope syntax splits on these delimiters; never silently split a literal PR filename.
    if (pr.files.some(f => /[\s,]/.test(f))) refuse('PR filenames cannot be represented by scope syntax');
    const key = repoKeyFor(pr.repo);
    // Use the card scope vocabulary while keeping PR filenames literal (including colons).
    const files = pr.files.map(f => `${SCOPE_PREFIX_ALIASES[key] ?? key}:${f}`);
    if (scopes.some(scope => prHoldsFile({ ...pr, files }, scope))) refuse(`scope overlaps open PR ${pr.repo}#${pr.number}`);
  }
  const at = (options.now?.() ?? new Date()).toISOString();
  return { record: { ids, mode, setBy: actor, at, ttlHours }, audit: { actor, reason, ids, mode, ttlHours, at } };
}

function runtimePath(options) {
  const env = options.env ?? process.env;
  return env.WE_BUILD_PRIORITY_RUNTIME_FILE ?? join(resolveCoordinationRoot({ env }), 'build-priority.runtime.json');
}

function install(input, options) {
  const path = runtimePath(options), lock = `${path}.lock`;
  fs.mkdirSync(dirname(path), { recursive: true });
  // O_EXCL refuses a concurrent writer; never reclaim an existing lock implicitly.
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  const scratch = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    const plan = prepare(input, options); // Fresh evidence under the writer lock.
    fd = fs.openSync(scratch, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(plan.record, null, 2)}\n`);
    (options.fsync ?? fs.fsyncSync)(fd);
    fs.closeSync(fd); fd = undefined;
    // An audit failure must never activate a policy; a failed rename leaves an explicit attempt.
    fs.appendFileSync(join(dirname(path), 'build-priority.audit.jsonl'), `${JSON.stringify({ ...plan.audit, phase: 'install-attempt' })}\n`, { mode: 0o600 });
    (options.rename ?? fs.renameSync)(scratch, path);
    const dirFd = fs.openSync(dirname(path), 'r');
    try { (options.fsync ?? fs.fsyncSync)(dirFd); }
    finally { fs.closeSync(dirFd); }
    return plan;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(scratch, { force: true });
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}

export function createBuildPrioritySet(options = {}) {
  return { declaration: buildPrioritySetOperation({ prepare: input => {
    if (fs.existsSync(`${runtimePath(options)}.lock`)) refuse('writer lock exists; verify the owning writer before removing a stale lock');
    return prepare(input, options);
  } }), sinks: { [BUILD_PRIORITY_SET_EFFECT]: input => install(input, options) },
  finish: ({ run, code, lines, json }) => ({ code, lines: !json && code === 0 && run?.verdict?.record
    ? [...lines, JSON.stringify(run.verdict.record, null, 2)] : lines }) };
}
