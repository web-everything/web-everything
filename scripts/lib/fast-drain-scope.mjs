import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import { readFileSync, statSync, mkdirSync, appendFileSync } from 'node:fs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { localRepoSlug } from '../readiness/drain-lock.mjs';
import { withWriteLock } from './daemon-clone-lock.mjs';
import { cascadePolicy, resolveCascade, readPlatformPreferences } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { validDefaultBranch } from './default-branch-cache.mjs';
import { isPinnedQueueEntryCommand } from './merge-queue-enqueue.mjs';

export const FAST_DRAIN_DEFER_KINDS = Object.freeze(new Set([
  'ordered', 'couple', 'card-group', 'manifest-unreadable', 'red-team-override',
  'couple-unknown', 'sibling-unreadable', 'hydration-race', 'budget', 'index-age',
  'index-setting', 'queue-precondition', 'incomplete-context',
].map(kind => `defer-to-pass:${kind}`)));
export const FAST_DRAIN_WRITE_KINDS = Object.freeze(new Set([
  'merge', 'refresh', 'numbering-push', 'retarget', 'dequeue', 'label-removal', 'other-pr', 'send-back', 'lane-repair',
  'post-conflict-finding', 'workflow-run', 'labels', 'pr-edit', 'comment', 'pr', 'graphql', 'api', 'gh', 'git', 'exec', 'prior-refusal', 'ledger',
]));
export function isFastDrainDeferKind(kind) {
  return typeof kind === 'string' && (FAST_DRAIN_DEFER_KINDS.has(kind)
    || kind.startsWith('defer-to-pass:write-boundary:') && FAST_DRAIN_WRITE_KINDS.has(kind.slice('defer-to-pass:write-boundary:'.length)));
}

/** Dynamic producer values must pass the same exhaustive taxonomy as literals. */
export function requireFastDrainDeferKind(kind) {
  if (!isFastDrainDeferKind(kind)) throw new Error(`Unclassified fast-drain defer kind: ${String(kind)}`);
  return kind;
}

/** The cwd-repo sentinel must share the full pass's persistent cache namespace. */
export function shaCacheRepo(repo, localSlug) {
  return repo || localSlug;
}

/** Invalid evidence disables the index, including invalid lower-precedence layers. */
export function resolveFastDrainIndexModeSetting({ env = process.env, tool, platform,
  readSettings = readDeclaredSettings, readPlatform = readPlatformPreferences } = {}) {
  const closed = () => ({ mode: 'off', source: 'invalid', line: 'fast-drain: mergeQueue.fastDrain.index.mode=off (invalid/unreadable setting)' });
  const valid = v => ['off', 'shadow', 'on'].includes(v);
  try {
    let nested;
    if (tool === undefined) {
      const settings = readSettings();
      if (settings.errors?.length || settings.duplicates?.some(d => d.path.startsWith('mergeQueue.fastDrain.index'))) return closed();
      tool = settings.settings?.mergeQueue?.fastDrain;
    }
    if (platform === undefined) {
      const p = readPlatform({ env });
      if (p.errors?.length) return closed();
      platform = p.prefs?.['mergeQueue.fastDrain'];
      nested = p.prefs?.['mergeQueue.fastDrain.index'];
    }
    for (const block of [tool, platform, ...(nested === undefined ? [] : [{ index: nested }])]) {
      if (block !== undefined && (!block || typeof block !== 'object' || Array.isArray(block))) return closed();
      if (block && Object.hasOwn(block, 'index') && (!block.index || typeof block.index !== 'object' || Array.isArray(block.index))) return closed();
      if (block?.index && Object.hasOwn(block.index, 'mode') && !valid(block.index.mode)) return closed();
    }
    const p = resolveCascade({ platform: platform?.index, tool: nested, valid: { mode: valid } });
    const c = cascadePolicy('mergeQueue.fastDrain.index', tool?.index, { env, platform: p.value ?? {},
      standard: { mode: 'shadow' }, envValues: { mode: env.WE_FAST_DRAIN_INDEX_MODE }, valid: { mode: valid }, log: () => {} });
    if (p.invalid.length || c.invalid.length || !valid(c.value.mode)) return closed();
    return { mode: c.value.mode, source: c.sources.mode,
      line: `fast-drain: mergeQueue.fastDrain.index.mode=${c.value.mode} (${c.sources.mode})` };
  } catch { return closed(); }
}

/** One dispatch for the child. Shadow errors, including telemetry IO, cannot escape into live work. */
export async function dispatchFastDrainIndex({ mode, legacy, index, repo = null, pr = null, head = null, mainSha = null,
  observe = () => ({}), env = process.env, shadowPath = env.WE_FAST_DRAIN_SHADOW_PATH,
  now = Date.now, log = () => {}, append = (path, row) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + '\n');
  } }) {
  if (mode === 'on') return index({ writeScope: 'enqueue-only' });
  if (mode === 'shadow') {
    let decision = { indexDecision: 'error', reason: 'shadow incomplete' }, failure;
    try {
      const writeBoundary = createFastDrainWriteBoundary({ writeScope: 'none', repo, num: pr });
      const identity = await observe(writeBoundary);
      head = identity.head ?? head;
      mainSha = identity.mainSha ?? mainSha;
      repo = identity.repo ?? repo;
      decision = await index({ writeScope: 'none', writeBoundary });
    } catch (error) { failure = error; decision = { indexDecision: 'error', reason: String(error?.message ?? error) }; }
    try {
      append(shadowPath || join(homedir(), '.claude', 'daemon-self-sync-state', 'fast-drain-shadow.jsonl'),
        { at: new Date(now()).toISOString(), pr, repo, head, indexDecision: decision?.indexDecision ?? 'unknown',
          reason: decision?.reason ?? null, mainSha });
    } catch (error) { failure ??= error; }
    if (failure) {
      try { log(`fast-drain shadow: ${String(failure?.message ?? failure).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}`); }
      catch { /* Shadow diagnostics cannot block the live child either. */ }
    }
  }
  return legacy();
}

/** Safety bounds: an invalid layer refuses rather than silently falling through to a lower value. */
export function resolveFastDrainIndexSetting({ env = process.env, tool, platform, readSettings = readDeclaredSettings,
  readPlatform = readPlatformPreferences } = {}) {
  const closed = () => ({ ok: false, kind: 'defer-to-pass:index-setting', line: 'fast-drain: defer-to-pass:index-setting' });
  let nestedPlatform;
  try {
    if (tool === undefined) {
      const settings = readSettings();
      if (settings.errors?.length || settings.duplicates?.some(d => d.path.startsWith('mergeQueue.fastDrain.index'))) return closed();
      tool = settings.settings?.mergeQueue?.fastDrain;
    }
    if (platform === undefined) {
      const p = readPlatform({ env });
      if (p.errors?.length) return closed();
      platform = p.prefs?.['mergeQueue.fastDrain'];
      nestedPlatform = p.prefs?.['mergeQueue.fastDrain.index'];
    }
    const validAge = v => Number.isInteger(v) && v >= 1 && v <= 120;
    const validBudget = v => Number.isInteger(v) && v >= 0 && v <= 50;
    for (const block of [tool, platform, ...(nestedPlatform === undefined ? [] : [{ index: nestedPlatform }])]) {
      if (block !== undefined && (block === null || typeof block !== 'object' || Array.isArray(block))) return closed();
      if (block && Object.hasOwn(block, 'index') && (!block.index || typeof block.index !== 'object' || Array.isArray(block.index))) return closed();
      for (const [key, valid] of [['maxAgeMinutes', validAge], ['hydrateBudget', validBudget]]) {
        if (block?.index && Object.hasOwn(block.index, key) && !valid(block.index[key])) return closed();
      }
    }
    const platformIndex = resolveCascade({ platform: platform?.index, tool: nestedPlatform,
      valid: { maxAgeMinutes: validAge, hydrateBudget: validBudget } });
    if (platformIndex.invalid.length) return closed();
    const parseEnv = key => env[key] === undefined ? undefined : /^\d+$/.test(env[key]) ? Number(env[key]) : null;
    const c = cascadePolicy('mergeQueue.fastDrain.index', tool?.index, { env, platform: platformIndex.value ?? {},
      standard: { maxAgeMinutes: 40, hydrateBudget: 10 },
      envValues: { maxAgeMinutes: parseEnv('WE_FAST_DRAIN_INDEX_MAX_AGE_MINUTES'), hydrateBudget: parseEnv('WE_FAST_DRAIN_INDEX_HYDRATE_BUDGET') },
      valid: { maxAgeMinutes: validAge, hydrateBudget: validBudget }, log: () => {} });
    if (c.invalid.length) return closed();
    const { maxAgeMinutes, hydrateBudget } = c.value;
    if (!validAge(maxAgeMinutes) || !validBudget(hydrateBudget)) return closed();
    const line = `fast-drain: mergeQueue.fastDrain.index.maxAgeMinutes=${maxAgeMinutes} (${c.sources.maxAgeMinutes}), hydrateBudget=${hydrateBudget} (${c.sources.hydrateBudget})`;
    return { ok: true, maxAgeMinutes, hydrateBudget, sources: c.sources, line };
  } catch { return closed(); }
}

export function assertFastDrainIndexAge(index, { now = Date.now(), maxAgeMinutes = 40 } = {}) {
  const stamp = index?.fetchedAtMs;
  if (!Number.isFinite(stamp) || stamp > now || now - stamp >= maxAgeMinutes * 60_000) throw new Error('defer-to-pass:index-age');
}

export function createFastDrainHydrationBudget(limit) {
  let used = 0;
  return { take({ target = false } = {}) {
    if (!target && ++used > limit) throw new Error('defer-to-pass:budget');
  }, get used() { return used; } };
}

/** Resolve standard → platform → tool → env; injected layers keep unit probes deterministic. */
export function resolveFastDrainScopeSetting({ env = process.env, tool, platform, readSettings = readDeclaredSettings } = {}) {
  let block = tool;
  if (block === undefined) {
    try { block = readSettings().settings?.mergeQueue?.fastDrain; } catch { block = undefined; }
  }
  const raw = String(env?.WE_FAST_DRAIN_SCOPE ?? '').trim().toLowerCase();
  const c = cascadePolicy('mergeQueue.fastDrain', block, {
    env, standard: { scope: 'target' }, envValues: { scope: raw || undefined },
    valid: { scope: (v) => v === 'target' || v === 'full' },
    ...(platform !== undefined ? { platform } : {}), log: () => {},
  });
  const scope = c.value.scope, source = c.sources.scope;
  const line = `fast-drain: mergeQueue.fastDrain.scope=${scope} (${source})${c.invalid.length ? ` · ignored invalid: ${c.invalid.join('; ')}` : ''}`;
  return { scope, source, line };
}

/** Resolve standard → platform → tool → env; injected layers keep unit probes deterministic. */
export function resolveFastDrainListingSetting({ env = process.env, tool, platform, readSettings = readDeclaredSettings, legacy = false } = {}) {
  let block = tool;
  if (block === undefined) {
    try { block = readSettings().settings?.mergeQueue?.fastDrain; } catch { block = undefined; }
  }
  const raw = String(env?.WE_FAST_DRAIN_LISTING ?? '').trim().toLowerCase();
  const contextRaw = String(env?.WE_FAST_DRAIN_CONTEXT ?? '').trim().toLowerCase();
  const c = cascadePolicy('mergeQueue.fastDrain', block, {
    env, standard: { listing: 'snapshot', context: 'snapshot', ...(legacy ? { selfRefresh: 'off' } : {}) },
    envValues: { listing: raw || undefined, context: contextRaw || undefined },
    valid: { listing: (v) => v === 'snapshot' || v === 'live', context: (v) => v === 'snapshot' || v === 'live',
      ...(legacy ? { selfRefresh: v => v === 'on' || v === 'off' } : {}) },
    ...(platform !== undefined ? { platform } : {}), log: () => {},
  });
  const listing = c.value.listing, source = c.sources.listing;
  const context = c.value.context, contextSource = c.sources.context;
  const line = `fast-drain: mergeQueue.fastDrain.listing=${listing} (${source}), context=${context} (${contextSource})${c.invalid.length ? ` · ignored invalid: ${c.invalid.join('; ')}` : ''}`;
  return { listing, source, context, contextSource, ...(legacy ? { selfRefresh: c.value.selfRefresh === 'on' } : {}), line };
}

/** Keep subverbs and flags finite: several otherwise read-only Git verbs can write output or run helpers. */
function safeGitRead(args) {
  const [verb, ...rest] = args;
  if (verb === 'config') return rest.length === 2 && ['--get', '--get-all'].includes(rest[0]) && !rest[1].startsWith('-')
    || rest.join(' ') === '--null --list --includes';
  if (verb === 'remote') return rest.length === 2 && rest[0] === 'get-url' && rest[1] === 'origin';
  if (verb === 'commit-graph') return rest.join(' ') === 'verify';
  // Fetch is only a remote read for pinned diff/manifest readers. Restrict local updates to origin tracking refs.
  if (verb === 'fetch') {
    const refs = rest.filter(a => !['--quiet', '--no-tags', '--end-of-options'].includes(a));
    return refs.length > 1 && refs[0] === 'origin' && refs.slice(1).every(a =>
      // Net-diff readers use branch shorthand; a source without a destination only updates FETCH_HEAD.
      /^[\w][\w./-]*$/.test(a)
      || /^\+(?:refs\/heads\/)?([\w][\w./-]*):refs\/remotes\/origin\/\1$/.test(a));
  }
  const flags = {
    diff: /^(?:--(?:name-only|name-status|numstat|stat|no-renames|no-relative|no-ext-diff|no-textconv|no-color|cached|end-of-options)|--(?:src-prefix|dst-prefix|diff-filter)=[^\n]*|-z)$/,
    show: /^(?:--(?:end-of-options|no-ext-diff|no-textconv)|--format=[^\n]*)$/,
    log: /^(?:--(?:reverse|first-parent|numstat|end-of-options|no-ext-diff|no-textconv|no-color)|--(?:format|pretty|grep|diff-filter|diff-merges)=[^\n]*|-z)$/,
    'ls-tree': /^(?:--(?:name-only|end-of-options)|-[rz])$/,
    'rev-parse': /^(?:--(?:verify|quiet|end-of-options|abbrev-ref|is-shallow-repository|show-toplevel|git-common-dir|git-dir|absolute-git-dir)|--path-format=absolute)$/,
    'ls-remote': /^(?:--(?:exit-code|heads|tags|refs))$/,
    'cat-file': /^(?:-[ept]|--end-of-options)$/,
    grep: /^(?:--threads=1|-[nE]+|-e)$/,
    status: /^(?:--porcelain(?:=v[12])?|--untracked-files=no)$/,
    'merge-base': /^(?:--(?:is-ancestor|end-of-options|all))$/,
  };
  if (!flags[verb]) return false;
  let paths = false;
  return rest.every(a => {
    if (a === '--') { paths = true; return true; }
    return paths || !a.startsWith('-') || flags[verb].test(a);
  });
}

/** Split value flags, including --flag=value and compact -XPOST/-fkey=value. */
function ghOptions(args, valueFlags, switches = []) {
  const values = [], operands = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (switches.includes(arg)) continue;
    const flag = valueFlags.find(f => arg === f || arg.startsWith(`${f}=`) || f.length === 2 && arg.startsWith(f));
    if (flag) {
      const value = arg === flag ? args[++i] : arg.slice(flag.length).replace(/^=/, '');
      if (typeof value !== 'string' || !value || value.startsWith('-')) return null;
      values.push([flag, value]);
    } else if (arg.startsWith('-')) return null;
    else operands.push(arg);
  }
  return { values, operands };
}

/** One boundary for injected writers and their subprocesses. Unknown mutations refuse. */
export function createFastDrainWriteBoundary({ writeScope = 'full', repo, num, log = () => {} } = {}) {
  const noWrites = writeScope === 'none';
  const limited = noWrites || writeScope === 'enqueue-only';
  let confirmed = false;
  let judgedHead = null, nodeId = null;
  const violations = [];
  const refuse = kind => {
    const reason = `defer-to-pass:write-boundary:${kind}`;
    violations.push(reason);
    throw Object.assign(new Error(reason), { kind: reason });
  };
  const target = (r, n) => { if (limited && (r !== repo || Number(n) !== Number(num))) refuse('other-pr'); };
  // Explicit selectors override the command environment/cwd, but every selector must stay in scope.
  const resolveCommandRepo = (selectors, options, run) => {
    const repoSelectors = selectors.values.filter(([flag]) => ['--repo', '-R'].includes(flag));
    let resolvedRepo = (options?.env ?? process.env).GH_REPO;
    if (!resolvedRepo && !repoSelectors.length) resolvedRepo = localRepoSlug({ cwd: options?.cwd, exec: run });
    for (const [, r] of repoSelectors) {
      if (r !== repo) refuse('other-pr');
      resolvedRepo = r;
    }
    if (!resolvedRepo) refuse('other-pr');
    return resolvedRepo;
  };
  const allow = kind => { if (limited) log(`fast-drain write: ${repo}#${num} ${kind}`); };
  const labels = (r, n, plan) => {
    if (!limited) return;
    if (noWrites) refuse('labels');
    target(r, n);
    if (!Array.isArray(plan?.remove ?? [])) refuse('label-removal');
    const remove = plan.remove ?? [];
    if (remove.length && !(plan.add === 'red-team:clear' && remove.every(l => l === 'red-team:pending'))) refuse('label-removal');
    if (plan.add && !['review:changes', 'red-team:pending', 'red-team:blocked', 'red-team:clear'].includes(plan.add)) refuse('labels');
  };
  return {
    limited, violations, refuse, target, repo, num,
    authorizeEnqueue: (r, n, head) => {
      if (!limited) return;
      target(r, n);
      if (!/^[a-f0-9]{40}$/.test(head)) refuse('graphql');
      judgedHead = head; nodeId = null;
    },
    fullPassDuty: (fn, fallback) => limited ? fallback : fn(),
    confirm: () => { confirmed = true; },
    helper: (kind, fn) => (...args) => {
      if (noWrites) refuse(kind);
      if (limited && !['hold-comment', 'red-team-request', 'local-state', 'operator-feed', 'enqueue'].includes(kind)
        && !(confirmed && ['clearance-stamp', 'ledger'].includes(kind))) refuse(kind);
      allow(kind); return fn(...args);
    },
    labelProvider: provider => !limited ? provider : { ...provider,
      // The full pass provisions repository labels; a child only edits target membership.
      ensureLabel: () => { if (noWrites) refuse('labels'); },
      setLabels: (r, n, plan) => { labels(r, n, plan); allow('labels'); return provider.setLabels(r, n, plan); },
    },
    // Full passes retain the caller's executor, including its identity at helper seams.
    exec: run => !limited ? run : (file, args, options) => {
      const value = flag => args[args.indexOf(flag) + 1];
      let bindIdentity = false;
      if (file === 'git') {
        // Net-diff readers pin these inert settings before the verb. Unknown
        // configuration stays closed: stripping arbitrary -c options can run aliases.
        const safeConfig = new Set(['core.quotepath=false', 'color.ui=never', 'diff.noprefix=false',
          'diff.external=', 'diff.srcPrefix=a/', 'diff.dstPrefix=b/', 'diff.mnemonicPrefix=false',
          'core.attributesFile=/dev/null']);
        let verbArgs = args;
        while (verbArgs[0] === '-c') {
          if (!safeConfig.has(verbArgs[1])) refuse('git');
          verbArgs = verbArgs.slice(2);
        }
        if (noWrites && verbArgs[0] === 'fetch') refuse('git');
        if (verbArgs[0] === 'push') refuse('numbering-push');
        if (!safeGitRead(verbArgs)) refuse('git');
      } else if (file === 'gh') {
        if (args[0] === 'pr' && args[1] === 'view' && judgedHead && Number(args[2]) === Number(num)) {
          const selectors = ghOptions(args.slice(3), ['--repo', '-R', '--json', '--jq', '-q']);
          if (!selectors) refuse('pr');
          target(resolveCommandRepo(selectors, options, run), args[2]);
          bindIdentity = true;
        }
        if (args[0] === 'pr' && !['view', 'list', 'diff', 'checks'].includes(args[1])) {
          if (noWrites) refuse('pr');
          const selectors = ghOptions(args.slice(3), ['--repo', '-R', '--add-label', '--remove-label', '--body', '--body-file', '--base', '--title', '-B', '-b', '-F', '-t']);
          if (!selectors) refuse('pr-edit');
          target(resolveCommandRepo(selectors, options, run), args[2]);
          if (args[1] === 'merge') refuse('merge');
          if (args[1] === 'update-branch') refuse('refresh');
          if (args[1] === 'edit') {
            if (selectors.values.some(([f]) => ['--base', '-B'].includes(f))) refuse('retarget');
            if (selectors.operands.length || selectors.values.some(([f]) => !['--repo', '-R', '--add-label', '--remove-label'].includes(f))) refuse('pr-edit');
            const add = selectors.values.flatMap(([f, v]) => f === '--add-label' ? v.split(',') : []);
            const remove = selectors.values.flatMap(([f, v]) => f === '--remove-label' ? v.split(',') : []);
            labels(repo, num, { add: add.length === 1 ? add[0] : add.length ? 'unknown' : null, remove });
            allow('labels');
          } else if (args[1] === 'comment') {
            const body = value('--body');
            if (!(typeof body === 'string' && (/^<!-- we-drain-poison head=[a-f0-9]{40} kind=bornas-collision /.test(body)
              || confirmed && body.startsWith('<!-- we-drain-enqueue-clearance head=')))) refuse('comment');
            allow(confirmed ? 'clearance-stamp' : 'hold-comment');
          } else refuse('pr');
        } else if (args[0] === 'api') {
          const parsed = ghOptions(args.slice(1), ['--method', '-X', '--field', '--raw-field', '-f', '-F', '--input', '--jq', '-q', '--header', '-H', '--cache', '--hostname'], ['--paginate', '--slurp', '--silent', '--include']);
          if (!parsed || parsed.operands.length !== 1) refuse('api');
          const fields = parsed.values.filter(([f]) => ['--field', '--raw-field', '-f', '-F'].includes(f));
          const queries = fields.filter(([, v]) => v.startsWith('query='));
          const query = queries.length === 1 ? queries[0][1] : null;
          const methods = parsed.values.filter(([f]) => ['--method', '-X'].includes(f));
          const input = parsed.values.some(([f]) => f === '--input');
          if (query && /\bmutation\b/.test(query)) {
            if (noWrites) refuse('graphql');
            if (query.includes('dequeuePullRequest')) refuse('dequeue');
            if (!isPinnedQueueEntryCommand(args) || !nodeId || args[5] !== `id=${nodeId}` || args[7] !== `sha=${judgedHead}`) refuse('graphql');
            if (violations.length) refuse('prior-refusal');
            allow('enqueue');
          } else if (input || methods.some(([, v]) => v !== 'GET')
            || fields.length && (parsed.operands[0] !== 'graphql' || !query || !/^query=\s*(?:query\b|\{)/.test(query))) refuse('api');
        } else if (args[0] === 'run') {
          if (!['view', 'list'].includes(args[1])) refuse('workflow-run');
        } else if (!(args[0] === 'repo' && args[1] === 'view') && args[0] !== 'pr' && args[0] !== 'search') refuse('gh');
      } else refuse('exec');
      const result = run(file, args, options);
      // Bind only the target's live identity read made after the strategy authorizes the judged head.
      if (bindIdentity) {
        try {
          const pr = JSON.parse(String(result));
          nodeId = pr.headRefOid === judgedHead && typeof pr.id === 'string' && pr.id ? pr.id : null;
        } catch { nodeId = null; }
      }
      return result;
    },
  };
}

/** Replace the live target while preserving snapshot context without mutating either input. */
export function mergeLiveTargetIntoRows(snapshotRows, targetRow, onlyPr) {
  const keepTarget = targetRow != null && (targetRow.state === undefined || targetRow.state === 'OPEN');
  let found = false;
  const rows = snapshotRows.flatMap((row) => {
    if (String(row.number) !== String(onlyPr)) return [row];
    found = true;
    return keepTarget ? [targetRow] : [];
  });
  if (keepTarget && !found) rows.push(targetRow);
  return rows;
}

export function shouldReadContextCommits({ onlyPr, scope, isTarget }) {
  return onlyPr == null || scope !== 'target' || isTarget;
}

export function filterToFastDrainTarget(prs, { onlyPr, scope, isTarget }) {
  return onlyPr != null && scope === 'target' ? prs.filter(isTarget) : prs;
}

/**
 * Cache only an answer read from the head sha itself (`definitive`), found or absent. A fallback-ref read
 * (stale origin ref, same-named local branch, FETCH_HEAD another drain moved) is returned but stays retryable.
 */
export async function readLegacyManifestCached({ repo, num, sha, readCache, writeCache, readLegacy }) {
  if (!sha) { const r = await readLegacy(); return { manifest: r.manifest, definitive: false, unreadable: !!r.unreadable }; }
  // v2: entries written under the earlier fetchSucceeded rule could hold a fallback ref's manifest.
  const key = { repo, num, sha, kind: 'legacy-manifest-v2' };
  const cached = readCache(key);
  if (cached !== undefined) return { manifest: cached, definitive: true, unreadable: false };
  const { manifest, definitive, unreadable } = await readLegacy();
  if (definitive) writeCache({ ...key, value: manifest });
  return { manifest, definitive: !!definitive, unreadable: !!unreadable };
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const MANIFEST_PATH = '.lane-manifest.json';

/**
 * Read the tree-committed `.lane-manifest.json` for one PR head. `git(args)` returns stdout or throws.
 * With a full head sha, only that commit answers (fetching it when missing — the PR's own
 * `refs/pull/<n>/head` first, which origin keeps for every open PR, forks included, then `headRef`):
 * FETCH_HEAD, origin/<ref> and a same-named local branch can only name ANOTHER commit there, and FETCH_HEAD is
 * shared by every drain process in the clone. "No manifest" is definitive only when ls-tree lists the head
 * tree without the file. A head that stays unreadable (missing after both fetches, or an ls-tree/show error)
 * returns `unreadable` so the caller fails closed for this pass instead of reading it as "not a carrier".
 * Without a usable sha, nothing can be verified as the head, so it is `unreadable` too.
 * `headRef` is a gh-supplied refname and may lead with a dash, so every ref argument sits behind --end-of-options.
 * @returns {{manifest: object|null, definitive: boolean, unreadable: boolean}}
 */
export function readLegacyLocalManifestAt({ headRef, headSha, prNumber, git }) {
  const sha = typeof headSha === 'string' && FULL_SHA.test(headSha) ? headSha : null;
  const parse = (raw) => { try { const m = JSON.parse(raw); return m && m.item != null ? m : null; } catch { return null; } };
  const fetch = (ref) => {
    try { git(['fetch', '--quiet', '--end-of-options', 'origin', ref]); } catch { /* ref may be local */ }
  };
  const unreadable = { manifest: null, definitive: false, unreadable: true };
  if (sha) {
    const hasHead = () => {
      try { git(['cat-file', '-e', '--end-of-options', `${sha}^{commit}`]); return true; } catch { return false; }
    };
    if (!hasHead() && Number.isSafeInteger(prNumber) && prNumber > 0) fetch(`refs/pull/${prNumber}/head`);
    if (!hasHead() && headRef) fetch(headRef);
    if (!hasHead()) return unreadable;
    let listed;
    try { listed = git(['ls-tree', '--end-of-options', sha, '--', MANIFEST_PATH]); } catch { return unreadable; }
    if (!String(listed ?? '').trim()) return { manifest: null, definitive: true, unreadable: false };
    let raw;
    try { raw = git(['show', '--end-of-options', `${sha}:${MANIFEST_PATH}`]); } catch { return unreadable; }
    // A commit's bytes never change, so even an unparseable manifest is a final answer.
    return { manifest: parse(raw), definitive: true, unreadable: false };
  }
  // No usable head sha (the listing always supplies headRefOid, so this is not expected): no ref can be
  // verified as the head, and FETCH_HEAD may hold another process's PR — fail closed rather than guess.
  return unreadable;
}


/** Invalid bounds retain the standard 60s live-refresh fallback. */
export function roundSnapshotTtl(env) {
  const raw = env.WE_FAST_DRAIN_LISTING_SNAPSHOT_TTL_SEC;
  const number = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  const valid = Number.isFinite(number) && number >= 0;
  return { seconds: valid ? number : 60, source: valid ? 'env' : 'standard' };
}

/** A round cache is advisory context only: reject incomplete, foreign or expired evidence. */
function readFastDrainRoundRecord({ path, repo, now = Date.now(), env = process.env,
  read = (p) => { if (statSync(p).size > 64 * 1024 * 1024) throw new Error('snapshot too large'); return readFileSync(p, 'utf8'); },
} = {}) {
  const { seconds: ttlSec } = roundSnapshotTtl(env);
  try {
    const raw = read(path);
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 64 * 1024 * 1024) return null;
    const snap = JSON.parse(raw);
    if (snap?.repo !== repo || typeof snap.writtenAt !== 'number' || !Number.isFinite(snap.writtenAt)
      || now < snap.writtenAt || now - snap.writtenAt >= ttlSec * 1000) return null;
    return snap;
  } catch { return null; }
}

export function readFastDrainRoundSnapshot(options) {
  const snap = readFastDrainRoundRecord(options);
  if ((options?.requireDefaultBranch && (typeof snap?.defaultBranch !== 'string' || !snap.defaultBranch.trim()))
      || !Array.isArray(snap?.rows)
      || !snap.rows.every(row => Number.isInteger(row?.number) && row.number > 0
        && typeof row.headRefOid === 'string' && row.headRefOid.length > 0
        && typeof row.baseRefName === 'string' && row.baseRefName.length > 0
        && Array.isArray(row.labels) && row.labels.every(l => typeof l?.name === 'string')
        && Array.isArray(row.statusCheckRollup))) return null;
  return snap;
}

/** Parent catch-up writes only branch metadata; it never claims a partial PR set is complete. */
export function writeFastDrainRoundDefaultBranch({ path, repo, defaultBranch, observedAt, write = writeJsonAtomic }) {
  if (!validDefaultBranch(defaultBranch) || !Number.isFinite(observedAt)) return false;
  try { write(path, { repo, writtenAt: observedAt, defaultBranch, defaultBranchReadAt: observedAt }); return true; } catch { return false; }
}

export function readFastDrainRoundDefaultBranch(options) {
  const name = readFastDrainRoundRecord(options)?.defaultBranch;
  return validDefaultBranch(name) ? name : null;
}

/** The shared writer lock waits for readers, but refuses another writer immediately. Wait for that
 * writer here so simultaneous cold children do not all fall back live. Directory identity stays stable
 * across creation of the snapshot file (realpath of an absent file can differ on symlinked temp roots).
 */
export async function withFastDrainRoundLock(path, fn, { owner = `${hostname()}:${randomUUID()}`, waitMs = 180_000, pollMs = 1000, sleep = delay } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = await withWriteLock(dirname(path), fn, { owner, lockRoot: `${path}.locks`, waitMs: Math.max(0, deadline - Date.now()) });
    // acquireWrite checks PID liveness and the heartbeat lease on EVERY attempt, reclaiming dead/stale
    // writers. A healthy writer may take longer than a cold listing; elapsed waiter time is not death.
    if (result.ok) return result;
    if (Date.now() >= deadline) return { ok: false, reason: 'round-lock-deadline' };
    if (result.reason !== 'concurrent-mover') return result;
    await sleep(Math.min(pollMs, deadline - Date.now()));
  }
}

/** Populate once across concurrent catch-up children; always replace the target with a live read.
 * The shared host snapshot still seeds listLive's heavy fields. This short-lived round file saves the
 * pages/checks reads too. A failed target read propagates; it can never resurrect the cached target.
 */
export async function readFastDrainRoundListing({ path, repo, onlyPr, env = process.env, now,
  read, write = writeJsonAtomic, listLive, readTarget, defaultBranch = () => null,
  reuseDefaultBranch = () => {}, requireDefaultBranch = false,
  log = line => process.stderr.write(`${line}\n`),
  lock = fn => withFastDrainRoundLock(path, fn),
}) {
  const clock = () => now ?? Date.now();
  const ttl = roundSnapshotTtl(env);
  const hasBranch = snap => !requireDefaultBranch || (typeof snap?.defaultBranch === 'string' && !!snap.defaultBranch.trim());
  const populate = async ({ liveOnly = false, stillHeld } = {}) => {
    const snap = liveOnly ? null : readFastDrainRoundSnapshot({ path, repo, env, now: clock(), read });
    if (snap && hasBranch(snap)) return { ...snap, hit: true };
    const rows = snap?.rows ?? await listLive();
    const branch = await defaultBranch();
    if (requireDefaultBranch && !hasBranch({ defaultBranch: branch })) throw new Error('round listing default branch unreadable — retry next pass');
    if (!liveOnly && (typeof stillHeld !== 'function' || !stillHeld())) {
      throw new Error('round listing lock unavailable (lock-lost) — retry next pass');
    }
    try { if (!liveOnly) write(path, { repo, writtenAt: snap?.writtenAt ?? clock(), rows, defaultBranch: branch }); }
    catch { /* Unwritable cache costs a live listing next time; it never authorizes a cached target. */ }
    return { rows, defaultBranch: branch, hit: !!snap };
  };
  // Hits do not need the population lock. Misses re-check inside it after a sibling's write.
  const snap = readFastDrainRoundSnapshot({ path, repo, env, now: clock(), read });
  let base;
  if (snap && hasBranch(snap)) base = { ...snap, hit: true };
  else {
    let entered = false;
    let locked;
    try { locked = await lock(stillHeld => { entered = true; return populate({ stillHeld }); }); }
    catch (error) {
      if (entered) throw error; // The live reader failed: propagate it, never retry it as a cache error.
      throw new Error('round listing lock unreadable — retry next pass', { cause: error });
    }
    if (!locked.ok && locked.reason === 'round-lock-deadline') {
      log('fast-drain: round listing lock wait deadline expired — falling back to exact live listing');
      base = await populate({ liveOnly: true });
    } else {
      if (!locked.ok) throw new Error(`round listing lock unavailable (${locked.reason || 'unknown'}) — retry next pass`);
      base = locked.value;
    }
  }
  log(`fast-drain: ${base.hit ? 'served-from-snapshot' : 'listed-live'} (round listing; TTL=${ttl.seconds}s, source=${ttl.source})`);
  reuseDefaultBranch(base.defaultBranch);
  if (typeof readTarget !== 'function') throw new Error('round listing live target reader missing — retry next pass');
  const target = await readTarget();
  if (!target || String(target.number) !== String(onlyPr) || !['OPEN', 'CLOSED', 'MERGED'].includes(target.state)) {
    throw new Error('round listing live target unreadable');
  }
  return mergeLiveTargetIntoRows(base.rows, target, onlyPr);
}
