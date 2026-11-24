/** Fail-closed evidence readers and the single atomic runtime-list writer. */
import fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { isTrustChainPath, TRUST_CHAIN, TRUST_CHAIN_BASENAMES } from '../lib/gate-config.mjs';
import { AUDITOR_FLOOR, GUARD_FLOOR, LOCK_USERS } from '../lib/protected-path-floor.mjs';
import { globsMayIntersect } from '../readiness/scope-lease.mjs';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { normalizeBriefScope, SCOPE_PREFIX_ALIASES } from './dispatch-lane.mjs';
import { GH_LIST_FILE_CAP, prHoldsFile, qualifyFile, repoKeyFor } from './free-scope.mjs';
import { resolveCoordinationRoot } from './coordination-root.mjs';
import { buildPrioritySetOperation, BUILD_PRIORITY_SET_EFFECT, validateBuildPriorityInput } from './build-priority-set.mjs';
import { matchesSome } from '../lib/audit-path.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Execution controls and the guard remain protected wherever a copy is relocated.
const EXECUTION_CONTROLS = [
  /^package\.json$/, /^vitest.*\.config\..+$/, /setup.*\.(?:js|ts|mjs)$/, /^vitest\.setup\..+$/,
  /^(?:cli-adapter|engine|effect-executor|build-priority-set-io|build-priority-set|build-priority-set\.test|build-priority-set-io-real\.test)\.mjs$/,
];
// Explicit snapshot of the guard's internal dependencies, protected in every directory.
// The test-only import-graph witness checks this list for drift; admission does no source scanning.
const GUARD_DEPENDENCY_BASENAMES = new Set([
  'atomic-json-file.mjs', 'automation-home.mjs', 'backlog-status.cjs',
  'bounded-child.mjs', 'build-priority-set-io.mjs', 'build-priority-set.mjs',
  'import-graph.mjs', 'audit-settings.test.mjs',
  'runtime-admission.mjs', ...AUDITOR_FLOOR.map(file => basename(file)), 'audit-path.mjs', 'build-policy.mjs',
  'protected-path-floor.mjs', 'guard-path-floor.mjs', 'guard-auditor-roots.json',
  'build-queue.mjs', 'command-redact.mjs', 'constellation-repos.mjs',
  'container-exec.mjs', 'coordination-root.mjs', 'daemon-clone-layout.mjs',
  'daemon-events.mjs', 'daemon-last-good.mjs', 'declared-homes.mjs',
  'delivery-priority.mjs', 'dispatch-lane.mjs', 'dispatch-task-type.mjs',
  'dispatch-throttle.mjs', 'drain-lock.mjs', 'file-locks.mjs',
  'finished-ci-cache.mjs', 'forge-cache-prune.mjs', 'forge-exec-bases.mjs',
  'forge-exec-limits.mjs', 'forge-exec-manifest.mjs', 'forge-exec-run.mjs',
  'forge-exec-siblings.mjs', 'forge-key-structure.mjs', 'forge-manifest-tracked.mjs',
  'forge-remote-health.mjs', 'forge-run-finish.mjs', 'forge-share.mjs',
  'forge-slot-markers.mjs', 'forge-telemetry.mjs', 'free-scope.mjs',
  'gate-config.mjs', 'gh-argv.mjs', 'gh-deferred.mjs',
  'gh-throttle-holders.mjs', 'gh-throttle.mjs', 'github-auth-policy.mjs',
  'handoff-path.mjs', 'handoff-settings.mjs', 'heavy-admission.mjs',
  'heavy-queue-io.mjs', 'heavy-queue-projection.mjs', 'heavy-queue.mjs',
  'heavy-repair-priority.mjs', 'host-capacity-render.mjs', 'host-capacity.mjs',
  'host-load.mjs', 'host-overload-settings.mjs', 'host-sample.mjs',
  'infra-blocked.mjs', 'lane-git-hardening.mjs', 'lane-lease.mjs',
  'lane-partition.mjs', 'lane-pool-paths.mjs', 'memory-warn-corroboration.mjs',
  'model-proposer.mjs', 'needs-git-route.mjs', 'no-prompt-command-rules.mjs',
  'operator-override-reader.mjs', 'pid-alive.mjs', 'pid-liveness.mjs',
  'policy-cascade.mjs', 'pr-land-reasons.mjs', 'pr-snapshot-store.mjs',
  'queue-store.mjs', 'registry.mjs', 'remote-exec.mjs',
  'remote-git-bundle.mjs', 'repo-names.mjs', 'resource-admission.mjs',
  'resource-gate.mjs', 'resource-policy.mjs', 'scope-glob-overlap.cjs',
  'scope-lease.mjs', 'session-slug.mjs', 'settings-files.mjs',
  'settings-safe-direction.mjs', 'standards-cache.mjs', 'standards-sections.mjs',
  'strict-utc-timestamp.mjs',
  'step-kinds.mjs', 'telemetry-machine.mjs', 'telemetry-store.mjs',
  'telemetry-summary-io.mjs', 'telemetry-summary.mjs', 'telemetry.mjs',
  'tools-root-guard.mjs', 'tools-root.mjs', 'under-test.mjs',
  'write-all-sync.mjs',
]);
const SCOPE_SETTINGS = 'scripts/settings/build-priority-scope.json';
const normalSegments = path => path.split('/').every(segment =>
  /^[a-z0-9_-][a-z0-9_.-]*$/i.test(segment) && !segment.includes('..'));

const exactSourceFile = path => !/[\s,]/.test(path) && normalSegments(path)
  && !path.split('/').slice(0, -1).some(segment => segment.includes('.'))
  && /\.(mjs|js|ts|json|md|sh|yml|yaml|css|html)$/i.test(path);
const CONTENT_LIMIT = 64 * 1024;
const GUARD_NAME = /^guard-|-guard|policy|gate/i;
const GUARD_MARKER = /TRUST_CHAIN|isTrustChainPath|@guard|gate-config/i;

function readAllowedFiles(readSettings) {
  try {
    const contents = readSettings();
    if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > CONTENT_LIMIT) throw new Error('invalid settings content');
    const settings = JSON.parse(contents);
    if (!settings || Object.hasOwn(settings, 'allowedDirs')
        || !Array.isArray(settings.allowedFiles)) throw new Error('invalid allowedFiles');
    return new Set(settings.allowedFiles.map(file => {
      if (typeof file !== 'string' || !exactSourceFile(file)) throw new Error('invalid file');
      return file;
    }));
  } catch { refuse(`unreadable or malformed scope settings ${SCOPE_SETTINGS}, or exceeds 64 KB; obtain human review and narrow the settings before retrying`); }
}
const READ_OPTIONS = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] };
const PAGED_FILE_LIMIT = 3000; // GitHub's files API stops at 3000 files; at that size the read may be truncated
const canonicalId = id => id.replace(/^0+(?=\d)/, '');
const refuse = why => { throw new Error(`build-priority-set: ${why}; repair evidence or drain open PRs and retry`); };

/** One pinned main snapshot per reader; no worktree cards, fetching or lazy network reads. */
export function readPriorityCards({ root = ROOT, git = (args, options = {}) => execFileSync('git', ['--no-replace-objects', ...args], {
  ...READ_OPTIONS, ...options, maxBuffer: options.maxBuffer ?? READ_OPTIONS.maxBuffer, cwd: root,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
}) } = {}) {
  let sha, names;
  const snapshot = () => {
    if (!sha) {
      const candidate = git(['rev-parse', '--verify', 'refs/remotes/origin/main']).trim();
      if (!/^[0-9a-f]{40}$/.test(candidate)) refuse('unreadable origin/main');
      sha = candidate;
    }
    return sha;
  };
  const read = id => {
    snapshot();
    names ??= git(['ls-tree', '-r', '--name-only', '-z', sha, '--', 'backlog']).split('\0').filter(Boolean);
    const matches = names.filter(name => {
      const match = /^backlog\/(\d+)-[^/]+\.md$/.exec(name);
      return match && canonicalId(match[1]) === canonicalId(id);
    });
    if (matches.length !== 1) refuse(`card ${id} missing or ambiguous on origin/main`);
    const text = git(['show', `${sha}:${matches[0]}`]);
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!front) refuse(`card ${id} has unreadable YAML frontmatter`);
    const data = yaml.load(front[1]);
    return { scope: data?.scope, status: data?.status, size: data?.size };
  };
  // Literal pathspec and NUL records preserve exact filenames; symlinks are blobs too,
  // so the mode is part of the evidence. Both readers share the same pinned SHA.
  read.pathType = path => {
    const rows = git(['--literal-pathspecs', 'ls-tree', '-z', snapshot(), '--', path]).split('\0').filter(Boolean);
    if (rows.length !== 1) return 'missing';
    const match = /^(100644|100755) blob [0-9a-f]{40}\t([^\0]+)$/.exec(rows[0]);
    return match && match[2] === path ? 'file' : 'non-file';
  };
  // Refuse overflow instead of silently declaring a partial scan clean. The same
  // pinned main SHA supplies cards, regular-file evidence and guard content.
  read.readContent = path => git(['show', `${snapshot()}:${path}`], { maxBuffer: CONTENT_LIMIT });
  read.readScopeSettings = () => {
    if (read.pathType(SCOPE_SETTINGS) !== 'file') throw new Error('invalid settings file mode');
    return read.readContent(SCOPE_SETTINGS);
  };
  return read;
}

/** Strict per-PR paginated read: every row validated, head pinned before and after, 3000-file API cap refused. */
function readPagedPrFiles({ gh, repo, number, head, total }) {
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)
      || !Number.isInteger(total) || total < GH_LIST_FILE_CAP || total >= PAGED_FILE_LIMIT) refuse('incomplete open PR files');
  try {
    const raw = gh(['api', '--paginate', `repos/${repo}/pulls/${number}/files?per_page=100`,
      '--jq', '.[] | {f: .filename, p: .previous_filename}']);
    const files = [];
    const filenames = new Set();
    let rows = 0;
    for (const line of String(raw).split(/\r?\n/).filter(l => l.trim())) {
      const row = JSON.parse(line);
      if (typeof row?.f !== 'string' || !row.f.trim() || (row.p != null && (typeof row.p !== 'string' || !row.p.trim()))) throw new Error('bad row');
      if (filenames.has(row.f)) throw new Error('duplicate row');
      filenames.add(row.f);
      rows += 1;
      files.push(row.f, ...(row.p ? [row.p] : []));
    }
    if (rows !== total) throw new Error('truncated');
    const after = JSON.parse(gh(['api', `repos/${repo}/pulls/${number}`, '--jq', '{head: .head.sha, total: .changed_files}']));
    if (after?.head !== head || after?.total !== total) throw new Error('PR changed');
    return files;
  } catch { return refuse('incomplete open PR files'); }
}

/** Bounded bulk lists; only capped file lists need per-PR paging and a metadata recheck. */
export function readPriorityPrs({ gh = args => runGhSync(args, READ_OPTIONS) } = {}) {
  const prs = [];
  for (const { slug } of Object.values(CONSTELLATION_REPOS)) {
    const rows = JSON.parse(gh(['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '200', '--json', 'number,files,headRefOid,changedFiles']));
    if (!Array.isArray(rows) || rows.length >= 200) refuse('incomplete open PR list (limit 200)');
    for (const row of rows) {
      if (!Number.isInteger(row?.number) || row.number <= 0 || !Array.isArray(row.files)
          || row.files.some(f => typeof f?.path !== 'string' || !f.path.trim()
            || (f.previousFilename != null && typeof f.previousFilename !== 'string'))) {
        refuse('incomplete open PR files');
      }
      if (row.files.length >= GH_LIST_FILE_CAP) {
        // The bulk list is capped: page only this PR; any failed, malformed, truncated or moved read refuses.
        const known = row.files.flatMap(f => [f.path, ...(f.previousFilename ? [f.previousFilename] : [])]);
        const files = readPagedPrFiles({ gh, repo: slug, number: row.number, head: row.headRefOid, total: row.changedFiles });
        const have = new Set(files);
        if (known.some(p => !have.has(p))) refuse('incomplete open PR files');
        prs.push({ repo: slug, number: row.number, files });
        continue;
      }
      if (row.changedFiles !== row.files.length || new Set(row.files.map(f => f.path)).size !== row.files.length) refuse('incomplete open PR files');
      prs.push({ repo: slug, number: row.number, files: row.files.flatMap(f => [f.path, ...(f.previousFilename ? [f.previousFilename] : [])]) });
    }
  }
  return prs;
}

/** Both selection modes validate every named file against the same pinned evidence. */
function scopeReader(options, readCard) {
  const source = readCard.pathType && readCard.readContent && readCard.readScopeSettings ? readCard : readPriorityCards();
  const pathType = options.pathType ?? source.pathType;
  const readContent = options.readContent ?? source.readContent;
  const allowedFiles = readAllowedFiles(options.readScopeSettings ?? source.readScopeSettings);
  if (!allowedFiles.size) refuse('allowlist is empty; add the file by a reviewed settings PR');
  let gateFiles;
  try {
    if (!Array.isArray(TRUST_CHAIN) || !TRUST_CHAIN.length) refuse('empty or unreadable gate TRUST_CHAIN');
    gateFiles = TRUST_CHAIN.flatMap(member => {
      if (!Array.isArray(member?.homes) || !member.homes.length
          || member.homes.some(home => typeof home !== 'string' || !home.trim())
          || typeof member.file !== 'string' || !member.file.trim()) refuse('incomplete gate TRUST_CHAIN member');
      return [...member.homes, member.file];
    });
    if (options.gateFiles !== undefined) {
      const extra = typeof options.gateFiles === 'function' ? options.gateFiles() : options.gateFiles;
      if (!Array.isArray(extra) || !extra.length
          || extra.some(home => typeof home !== 'string' || !home.trim())) refuse('empty or unreadable gate files');
      gateFiles.push(...extra);
    }
    gateFiles = [...new Set(gateFiles)];
  } catch {
    refuse('unreadable or incomplete gate files');
  }
  if (!Array.isArray(gateFiles) || !gateFiles.length
      || gateFiles.some(home => typeof home !== 'string' || !home.trim())) refuse('empty or unreadable gate files');
  const protectedPaths = new Set(gateFiles.map(path => path.toLowerCase()));
  const protectedBasenames = new Set([...protectedPaths].map(file => basename(file)));
  return (card, id) => {
    const raw = typeof card?.scope === 'string' ? [card.scope] : card?.scope;
    if (!Array.isArray(raw) || !raw.length) refuse(`card ${id} missing or unreadable scope`);
    return raw.map(entry => {
      const match = typeof entry === 'string' && /^([a-z-]+):(.+)$/i.exec(entry);
      const prefix = match && match[1].toLowerCase();
      const path = match && match[2];
      if (!match || /[\s,]/.test(entry) || prefix !== 'we'
          || !exactSourceFile(path)) {
        refuse(`card ${id} scope entry ${JSON.stringify(entry)} must be an exact file path`);
      }
      const folded = path.toLowerCase();
      if (protectedPaths.has(folded) || protectedBasenames.has(basename(folded))
          || GUARD_DEPENDENCY_BASENAMES.has(basename(folded))
          || /^scripts\/(?:[^/]+\/)*__tests__\/helpers\//.test(folded)
          || EXECUTION_CONTROLS.some(pattern => pattern.test(basename(folded)))
          || matchesSome(path, [...GUARD_FLOOR, ...LOCK_USERS])) {
        refuse(`card ${id} scope entry ${JSON.stringify(entry)} overlaps gate file ${path}`);
      }
      if (!allowedFiles.has(path)) {
        refuse(`card ${id} scope entry ${JSON.stringify(entry)} outside allowedFiles`);
      }
      if (GUARD_NAME.test(basename(path))) {
        refuse(`card ${id} scope entry ${JSON.stringify(entry)} has a guard name`);
      }
      let type;
      try { type = pathType(path); } catch { /* Unreadable Git evidence refuses below. */ }
      if (type !== 'file') refuse(`card ${id} scope entry ${JSON.stringify(entry)} not a readable regular file on origin/main`);
      let content;
      try { content = readContent(path); } catch { /* Unknown or oversized evidence refuses below. */ }
      if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > CONTENT_LIMIT) {
        refuse(`card ${id} scope entry ${JSON.stringify(entry)} unreadable content or exceeds 64 KB; obtain human review and narrow the scope before retrying`);
      }
      if (content.split(/\r?\n/).some(line => GUARD_MARKER.test(line))) {
        refuse(`card ${id} scope entry ${JSON.stringify(entry)} contains a guard marker`);
      }
      return `we:${folded}`;
    });
  };
}

const MERGE_PATH_SCOPES = [...new Set([
  ...GUARD_FLOOR, ...TRUST_CHAIN.flatMap(member => member.homes ?? []),
  '.github/workflows/', 'scripts/lib/', 'scripts/readiness/', 'scripts/conveyor/',
])];

/** Use the bounded lease matcher for directory/glob coverage of the trust chain and audit floor. */
function touchesMergePath(scope) {
  // cardScope already rejects noncanonical paths and unsupported scope syntax.
  const path = scope.slice(scope.indexOf(':') + 1);
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return isTrustChainPath(path)
    || MERGE_PATH_SCOPES.some(protectedScope => globsMayIntersect(path, protectedScope))
    // File-shaped wildcard basenames also follow relocated trust-chain modules. Generic directory globs
    // use the registered homes/floor above. Disjoint scopes still need exact-file allowlist validation.
    || (basename.includes('.') && /[*?]/.test(basename)
      && [...TRUST_CHAIN_BASENAMES].some(name => globsMayIntersect(basename, name)))
    || /(?:^|\/)[^/]*(?:merge|drain|review)[^/]*(?:\/|$)/i.test(path)
    || /^(?:\.github\/workflows(?:\/|$)|scripts\/(?:lib|readiness|conveyor)\/?$)/.test(path)
    || ['scripts', 'scripts/', '.github', '.github/', './', '.', ''].includes(path);
}

function cardScope(card, id) {
  const raw = typeof card?.scope === 'string' ? [card.scope] : card?.scope;
  if (!Array.isArray(raw) || !raw.length || raw.some(s => typeof s !== 'string' || !s.trim())) refuse(`card ${id} missing or unreadable scope`);
  const scope = raw.flatMap(member => {
    const normalized = normalizeBriefScope([member]);
    if (!normalized.length) refuse(`card ${id} empty scope member`);
    return normalized.map(s => qualifyFile(s));
  });
  if (!scope.length) refuse(`card ${id} empty scope`);
  return scope;
}

function prepare(input, options) {
  const { actor, reason, ids: explicitIds, autoCount, mode, ttlHours } = validateBuildPriorityInput(input);
  if (new Set(explicitIds.map(canonicalId)).size !== explicitIds.length) refuse('duplicate numeric card identities');
  const readCard = options.readCard ?? readPriorityCards();
  const readScope = scopeReader(options, readCard);
  // Preserve explicit-ID validation order and refusal behavior.
  const scopes = autoCount ? [] : explicitIds.flatMap(id => readScope(readCard(id), id));
  const prs = (options.readPrs ?? readPriorityPrs)();
  if (!Array.isArray(prs)) refuse('unreadable PR source');
  const qualifiedPrs = prs.map(pr => {
    if (!Object.values(CONSTELLATION_REPOS).some(r => r.slug === pr?.repo) || !Number.isInteger(pr.number)
        || !Array.isArray(pr.files) || pr.files.some(f => typeof f !== 'string' || !f.trim())) refuse('unreadable PR files');
    // Scope syntax splits on these delimiters; never silently split a literal PR filename.
    if (pr.files.some(f => /[\s,]/.test(f))) refuse('PR filenames cannot be represented by scope syntax');
    const key = repoKeyFor(pr.repo);
    // Use the card scope vocabulary while keeping PR filenames literal (including colons).
    const files = pr.files.map(f => `${SCOPE_PREFIX_ALIASES[key] ?? key}:${f.toLowerCase()}`);
    return { ...pr, files };
  });

  const overlap = scope => qualifiedPrs.find(pr => scope.some(file => prHoldsFile(pr, file)));
  const ids = [...explicitIds], skipped = [];
  if (autoCount) {
    const list = (options.readPriorityList ?? (() => JSON.parse(fs.readFileSync(join(ROOT, 'scripts/settings/build-priority.json'), 'utf8')).build?.priority))();
    if (!Array.isArray(list)) refuse('unreadable build.priority list');
    const seen = new Set();
    for (const value of list) {
      if (ids.length === autoCount) break;
      const id = String(value);
      if (!/^\d+$/.test(id)) { skipped.push({ id, reason: 'non-numeric id' }); continue; }
      const canonical = canonicalId(id);
      if (seen.has(canonical)) { skipped.push({ id, reason: 'duplicate numeric card identity' }); continue; }
      seen.add(canonical);
      let card, scope;
      try {
        card = readCard(canonical);
        if (!card || card.status !== 'open') { skipped.push({ id, reason: 'status is not open' }); continue; }
        if (typeof card.size !== 'number' || !Number.isFinite(card.size) || card.size <= 0 || card.size > 3) {
          skipped.push({ id, reason: 'size missing or outside (0,3]' }); continue;
        }
        scope = cardScope(card, canonical);
      } catch { skipped.push({ id, reason: 'unreadable card or scope on origin/main' }); continue; }
      if (scope.some(touchesMergePath)) { skipped.push({ id, reason: 'scope touches merge path' }); continue; }
      try { scope = readScope(card, canonical); }
      catch (error) { skipped.push({ id, reason: error.message }); continue; }
      const held = overlap(scope);
      if (held) { skipped.push({ id, reason: `scope overlaps open PR ${held.repo}#${held.number}` }); continue; }
      ids.push(canonical);
    }
    if (!ids.length) refuse('no ready build.priority cards fit --auto-count');
  } else {
    const held = overlap(scopes);
    if (held) refuse(`scope overlaps open PR ${held.repo}#${held.number}`);
  }
  const at = (options.now?.() ?? new Date()).toISOString();
  return { record: { ids, mode, setBy: actor, at, ttlHours }, audit: { actor, reason, ids, mode, ttlHours, at,
    ...(autoCount ? { autoCount, selectedCount: ids.length, skipped } : {}) } };
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
