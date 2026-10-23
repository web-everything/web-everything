/**
 * @file scripts/lib/git-identity.mjs
 * @description Is the git author a real person, or a placeholder nobody will notice?
 *
 *   INCIDENT (2026-10-05 → 2026-10-20): the global git config carried `user.name=test` /
 *   `user.email=test@test.com`, so every lane and agent commit for two weeks was authored "test". Nothing
 *   flagged it. This module is the one check every surface shares — the SessionStart bootstrap report
 *   (`git-identity` line), `lane-pool.mjs status`/`provision`, and the lane pre-commit guard
 *   (`we:scripts/guard-git-identity.mjs`) — so they can never disagree about what "placeholder" means.
 *
 *   `checkGitIdentity` is PURE. The placeholder list is a cascade setting (`gitIdentityPlaceholders`, see
 *   `we:scripts/lib/policy-cascade.mjs`), source logged through `cascadePolicy`. The configured lists only ADD
 *   to the built-in one: the built-in list is the guard's floor, so a setting can widen it but never weaken it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, accessSync, statSync, realpathSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { LANE_GIT_CONFIG_PINS, hardenLaneGitArgs } from './lane-git-hardening.mjs';

/** The cascade key (platform preference / `scripts/settings/*.json` block). */
export const GIT_IDENTITY_POLICY = 'gitIdentityPlaceholders';

/** Built-in placeholders — the floor. Names and email local-parts compared lower-cased and trimmed. */
export const BUILTIN_PLACEHOLDERS = Object.freeze({
  names: Object.freeze(['test', 'tester', 'testuser', 'test user', 'example', 'foo', 'bar', 'foobar', 'user',
    'root', 'name', 'your name', 'yourname', 'unknown', 'nobody', 'changeme', 'placeholder', 'none', 'null']),
  emails: Object.freeze(['you@example.com', 'your@email.com', 'email@example.com']),
  // `*@<domain>` and `*@*.<domain>`. `test`/`example`/`invalid`/`localhost` are the RFC 2606 reserved names.
  // NOT `email.com` — that is a real mail provider (audit finding); only its exact `your@email.com` is listed above.
  emailDomains: Object.freeze(['test.com', 'example.com', 'example.org', 'example.net',
    'localhost', 'localhost.localdomain', 'test', 'example', 'invalid']),
});

const norm = (v) => String(v ?? '').trim().toLowerCase();
/** A setting value is accepted ONLY as a plain array of non-empty strings (audit finding: a nested object slipped through). */
const isStrList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');
const EXTRA_KEYS = Object.freeze(['extraNames', 'extraEmails', 'extraEmailDomains']);
const defaultWarn = (line) => { try { process.stderr.write(`${line}\n`); } catch { /* best effort */ } };

/**
 * IO-light: resolve the effective placeholder lists (built-in ∪ configured extras) through the policy cascade.
 * Settings shape: `{ "gitIdentityPlaceholders": { "extraNames": [], "extraEmails": [], "extraEmailDomains": [] } }`
 * in any `scripts/settings/<feature>.json` (or the platform preference file). Env
 * `WE_GIT_IDENTITY_EXTRA_PLACEHOLDERS` = comma list of extra names/emails (an entry with `@` is an email,
 * one starting `@` is a domain). Never throws — a broken setting falls back to the built-in floor.
 * @returns {{names:string[], emails:string[], emailDomains:string[], sources:Record<string,string>}}
 */
export function resolveGitIdentityPlaceholders({ env = process.env, tool, readSettings = readDeclaredSettings, warn = defaultWarn } = {}) {
  const standard = { extraNames: [], extraEmails: [], extraEmailDomains: [] };
  let extras = standard;
  let sources = { extraNames: 'standard', extraEmails: 'standard', extraEmailDomains: 'standard' };
  try {
    let block = tool;
    if (block === undefined) { try { block = readSettings().settings?.[GIT_IDENTITY_POLICY]; } catch { block = undefined; } }
    const raw = String(env?.WE_GIT_IDENTITY_EXTRA_PLACEHOLDERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const envValues = raw.length ? {
      extraNames: raw.filter((s) => !s.includes('@')),
      extraEmails: raw.filter((s) => s.includes('@') && !s.startsWith('@')),
      extraEmailDomains: raw.filter((s) => s.startsWith('@')).map((s) => s.slice(1)),
    } : {};
    const r = cascadePolicy(GIT_IDENTITY_POLICY, block, {
      env, standard, envValues,
      valid: { extraNames: isStrList, extraEmails: isStrList, extraEmailDomains: isStrList },
    });
    const value = r.value && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : {};
    // RE-VALIDATE each key's FINAL value: the cascade validates leaves, so `extraNames: {nested: [...]}` reached
    // here as an object. Anything that is not a plain array of non-empty strings is ignored with a warning.
    const bad = [...(r.invalid ?? [])];
    extras = { ...standard };
    for (const k of EXTRA_KEYS) {
      if (value[k] === undefined) continue;
      if (isStrList(value[k])) extras[k] = value[k];
      else { bad.push(`${k}=${JSON.stringify(value[k])}`); sources[k] = 'standard (invalid value ignored)'; }
    }
    for (const k of EXTRA_KEYS) if (extras[k] !== standard[k] && r.sources?.[k]) sources[k] = r.sources[k];
    if (bad.length) warn(`git-identity: ignored invalid ${GIT_IDENTITY_POLICY} setting(s) — need a plain array of non-empty strings: ${bad.join('; ')} (built-in list still applies)`);
  } catch (e) {
    extras = standard;
    warn(`git-identity: ${GIT_IDENTITY_POLICY} setting unreadable (${String(e?.message ?? e).split('\n')[0]}) — built-in list applies`);
  }
  const union = (a, b) => [...new Set([...a, ...b].map(norm).filter(Boolean))];
  return {
    names: union(BUILTIN_PLACEHOLDERS.names, extras.extraNames),
    emails: union(BUILTIN_PLACEHOLDERS.emails, extras.extraEmails),
    emailDomains: union(BUILTIN_PLACEHOLDERS.emailDomains, extras.extraEmailDomains),
    sources,
  };
}

/**
 * PURE: classify one identity.
 * @param {{name?:string|null, email?:string|null}} ident
 * @param {{names?:string[], emails?:string[], emailDomains?:string[]}} [lists] defaults to the built-in floor
 * @returns {{status:'ok'|'placeholder'|'missing', reasons:string[]}}
 */
export function checkGitIdentity({ name, email } = {}, lists = BUILTIN_PLACEHOLDERS) {
  const n = norm(name);
  const e = norm(email);
  const missing = [];
  if (!n) missing.push('user.name is not set');
  if (!e) missing.push('user.email is not set');
  if (missing.length) return { status: 'missing', reasons: missing };
  const names = new Set((lists.names ?? []).map(norm));
  const emails = new Set((lists.emails ?? []).map(norm));
  const domains = (lists.emailDomains ?? []).map(norm).filter(Boolean);
  const reasons = [];
  if (names.has(n)) reasons.push(`name "${String(name).trim()}" is a placeholder`);
  const at = e.lastIndexOf('@');
  // Reasons never echo the whole address — only the (placeholder) domain — so a report can't leak a real email.
  // The local part is NOT matched against the names list: `bar@realcorp.io` is a real address (audit finding).
  if (at <= 0 || at === e.length - 1) {
    reasons.push('email is not an address');
  } else {
    const domain = e.slice(at + 1);
    if (emails.has(e)) reasons.push('email is a listed placeholder address');
    else if (domains.some((d) => domain === d || domain.endsWith(`.${d}`))) reasons.push(`email domain "@${domain}" is a placeholder`);
  }
  return reasons.length ? { status: 'placeholder', reasons } : { status: 'ok', reasons: [] };
}

/** PURE: parse `git var GIT_AUTHOR_IDENT` output (`Name <email> 1700000000 +0000`). */
export function parseIdent(line) {
  const m = /^(.*?)\s*<([^>]*)>/.exec(String(line ?? '').trim());
  return m ? { name: m[1], email: m[2] } : { name: '', email: '' };
}

/** PURE: is this `git var` failure git saying "no identity" (→ missing), rather than git itself failing? */
export function isIdentityUnknownError(e) {
  const text = `${e?.stderr ?? ''}\n${e?.message ?? ''}`;
  return /identity unknown|empty ident|unable to auto-detect email|name consists only of disallowed characters/i.test(text);
}

/**
 * IO: the effective author and committer git would use in `dir` (config + env, exactly what a commit gets).
 * Git's own "identity unknown" refusal reads as an empty identity (→ `missing`). ANY OTHER failure (timeout,
 * EMFILE, no git) is returned as `error`, never as `missing`: a check that cannot run must not be mistaken for a
 * missing identity (the guard allows on `error`; audit finding). Never throws.
 * @returns {{author:{name:string,email:string}, committer:{name:string,email:string}, error?:string}}
 */
export function readGitIdentity(dir = process.cwd(), { env = process.env, run = execFileSync } = {}) {
  let error;
  const read = (v) => {
    try {
      return parseIdent(run('git', ['var', v], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 1024 * 1024 }));
    } catch (e) {
      if (!isIdentityUnknownError(e)) error = String(e?.message ?? e).split('\n')[0];
      return { name: '', email: '' };
    }
  };
  const out = { author: read('GIT_AUTHOR_IDENT'), committer: read('GIT_COMMITTER_IDENT') };
  return error ? { ...out, error } : out;
}

/** The operator-facing fix line, shared by every surface. Never names a real identity. */
export const GIT_IDENTITY_FIX_HINT =
  'fix: git config --global user.name "<Your Name>" && git config --global user.email "<you@your-domain>" '
  + '(and check no lane .git/config or GIT_AUTHOR_*/GIT_COMMITTER_* env overrides it)';

/**
 * The pool-wide identity check for `lane-pool.mjs status`/`provision`. Asks GIT for the resolved identity IN EACH
 * LANE (`readIn` = `git var GIT_AUTHOR_IDENT`/`GIT_COMMITTER_IDENT` there) — never parses config files, so every
 * valid config syntax, `[author]`/`[committer]`, include and includeIf is covered (audit finding). IO injected.
 * @param {{lanes:{lane:number,dir:string}[], readIn:(dir:string)=>{author:object,committer:object,error?:string},
 *   lists?:object}} o
 * @returns {{status:'ok'|'placeholder'|'missing', bad:{lane:number,status:string,detail:string}[]}}
 */
export function laneIdentityReport({ lanes, readIn, lists = BUILTIN_PLACEHOLDERS }) {
  const bad = [];
  for (const { lane, dir } of lanes) {
    const v = identityVerdict(readIn(dir), lists);
    if (v.status !== 'ok' && v.status !== 'error') bad.push({ lane, status: v.status, detail: v.detail });
  }
  const status = bad.some((b) => b.status === 'missing') ? 'missing' : bad.length ? 'placeholder' : 'ok';
  return { status, bad };
}

/**
 * PURE: the combined verdict for author + committer — worst of the two. `error` = the read itself failed.
 * @returns {{status:'ok'|'placeholder'|'missing'|'error', detail:string}}
 */
export function identityVerdict({ author, committer, error }, lists = BUILTIN_PLACEHOLDERS) {
  if (error) return { status: 'error', detail: `could not read the git identity (${error})` };
  const a = checkGitIdentity(author, lists);
  const c = checkGitIdentity(committer, lists);
  const rank = { ok: 0, placeholder: 1, missing: 2 };
  const status = rank[a.status] >= rank[c.status] ? a.status : c.status;
  if (status === 'ok') return { status, detail: `author "${author.name}" ok` };
  const parts = [];
  if (a.status !== 'ok') parts.push(`author: ${a.reasons.join('; ')}`);
  if (c.status !== 'ok') parts.push(`committer: ${c.reasons.join('; ')}`);
  return { status, detail: parts.join(' · ') };
}

/** The tracked hooks dir every lane must point `core.hooksPath` at (so the identity guard actually runs). */
export const LANE_HOOKS_PATH = '.githooks';

/** `env` without git's command-scope config overrides, so a read sees what an agent's own `git commit` would. */
export function withoutGitConfigEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(k)) out[k] = v;
  return out;
}

/** The hooks-path verification's env: no inherited config overrides (see above), no inherited external diff or pager. */
function hooksVerifyEnv(env) {
  const out = withoutGitConfigEnv(env);
  delete out.GIT_EXTERNAL_DIFF;
  // No lazy fetch: a sparse index whose `.githooks` tree is missing from a lane-declared promisor remote made `ls-files`
  // fetch through the lane's `remote.origin.uploadpack` (PR #5775 self-review). Without it, git fails (→ `error`).
  return { ...out, GIT_PAGER: 'cat', PAGER: 'cat', GIT_NO_LAZY_FETCH: '1' };
}

/**
 * The git argv for the hooks-path verification: every lane-hardening pin (`scripts/lib/lane-git-hardening.mjs`) as a
 * `-c` flag, plus `--no-pager` and its argument rewrites, so a lane's own `.git/config` (`core.fsmonitor`, which
 * `ls-files` runs; `diff.external`; `core.pager`) never runs code (red-team finding, PR #5775). `core.hooksPath` alone
 * stays unpinned: it is the value under test, and `config` / `ls-files` run no hooks. Pure.
 */
export function laneHooksGitArgs(args) {
  const pins = LANE_GIT_CONFIG_PINS.filter(([k]) => k !== 'core.hooksPath').flatMap(([k, v]) => ['-c', `${k}=${v}`]);
  // `protocol.allow=never`: the lazy-fetch backstop for a git older than GIT_NO_LAZY_FETCH (see hooksVerifyEnv).
  return ['--no-pager', ...pins, '-c', 'protocol.allow=never', ...hardenLaneGitArgs(args)];
}

/** Would git actually run this hook? Git checks `access(X_OK)` and silently skips a hook that fails it; a shell hook
 * must also be readable, and a directory is never a hook. (On Windows X_OK is an existence check, as in git.) */
export function hookRunnable(path) {
  try {
    accessSync(path, constants.R_OK | constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Is `argv1` the module at `metaUrl`? Both sides go through the SAME canonicalization (native realpath of a file
 * path), so a percent-encoded space, a symlinked checkout with or without `--preserve-symlinks-main`, or a
 * case-variant path on a case-insensitive disk never makes an entry script silently skip its `main()`.
 */
export function invokedAsScript(argv1, metaUrl) {
  if (!argv1) return false;
  const canon = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  return canon(argv1) === canon(fileURLToPath(metaUrl));
}

/**
 * IO (injected): make a lane's EFFECTIVE `core.hooksPath` (what git resolves across every scope, incl. worktree
 * config) the tracked `.githooks`. The `prepare` npm script used to be the only thing that set it — `provision
 * --no-install` skips npm and a `--reference` clone does not inherit it — so the pre-commit guard silently never
 * ran there; a worktree-scope `core.hooksPath=/dev/null` also beat a correct local value (audit findings).
 * Repair: replace all `--local` values, drop a lane-owned `--worktree` override, re-read. A global/system override is NOT ours to
 * change — reported as `override`. Idempotent (reads first, writes only on a difference), logged. Skipped when the
 * checkout does not track `.githooks/pre-commit` (a tracked one that is missing is `error`). A pre-commit git would not run (not executable/readable) is `error` on
 * every path — git ignores it, so no hooksPath value protects the lane; the tracked file is not chmod-ed here.
 * `write: false` only reports (read-only callers like `status`). Never throws.
 * @returns {{status:'ok'|'set'|'unset'|'override'|'skipped'|'error', was?:string|null, scope?:string, detail?:string}}
 */
export function ensureLaneHooksPath(dir, {
  write = true,
  exists = existsSync,
  runnable = hookRunnable,
  run = (args) => execFileSync('git', laneHooksGitArgs(args), { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 1024 * 1024, env: hooksVerifyEnv(process.env) }),
  log = defaultWarn,
} = {}) {
  try {
    const hook = join(dir, LANE_HOOKS_PATH, 'pre-commit');
    if (!exists(hook)) {
      // Skip only a checkout that does not TRACK the hook (`ls-files --error-unmatch` exits 1). A tracked hook that is
      // deleted or a dangling symlink runs nothing, so it must not pass as `skipped` (self-review finding).
      try { run(['ls-files', '--error-unmatch', '--', `${LANE_HOOKS_PATH}/pre-commit`]); } catch (e) {
        if (e?.status === 1) return { status: 'skipped' };
        throw e;
      }
      throw new Error(`${LANE_HOOKS_PATH}/pre-commit is tracked but missing (or a dangling symlink), so git runs no pre-commit guard (restore it from git)`);
    }
    // A correct core.hooksPath proves nothing if git skips the hook itself (red-team finding: a 0644 pre-commit).
    if (!runnable(hook)) throw new Error(`${LANE_HOOKS_PATH}/pre-commit is not executable, so git ignores it (restore its mode: chmod +x ${LANE_HOOKS_PATH}/pre-commit)`);
    const effective = () => {
      try {
        // Git appends one LF; all whitespace inside the value belongs to the actual directory name.
        // In particular `.githooks ` and `.githooks\n` must not falsely verify as `.githooks`.
        const [scope, ...rest] = String(run(['config', '--show-scope', '--get', 'core.hooksPath'])).replace(/\n$/, '').split('\t');
        return { scope, value: rest.join('\t') || null };
      } catch (e) {
        // `git config --get` exits 1 only when the key is absent. A timeout, unreadable config, etc. must
        // remain an error, including on the verification read and for read-only status callers.
        if (e?.status !== 1) throw e;
        return { scope: null, value: null };
      }
    };
    const before = effective();
    if (before.value === LANE_HOOKS_PATH) return { status: 'ok', was: before.value, scope: before.scope };
    if (!write) return { status: before.value ? 'override' : 'unset', was: before.value, scope: before.scope };
    run(['config', '--local', '--replace-all', 'core.hooksPath', LANE_HOOKS_PATH]);
    if (before.scope === 'worktree') { try { run(['config', '--worktree', '--unset-all', 'core.hooksPath']); } catch { /* re-read decides */ } }
    const after = effective();
    if (after.value !== LANE_HOOKS_PATH) {
      try { log(`  ⚠ ${dir}: core.hooksPath is still ${after.value} (${after.scope} scope) — the pre-commit guards do NOT run; remove that override`); } catch { /* log only */ }
      return { status: 'override', was: before.value, scope: after.scope };
    }
    try { log(`  ${dir}: core.hooksPath ${before.value ?? '(unset)'}${before.scope ? ` (${before.scope})` : ''} → ${LANE_HOOKS_PATH} (lane pre-commit guards now run)`); } catch { /* log only */ }
    return { status: 'set', was: before.value, scope: before.scope };
  } catch (e) {
    const detail = String(e?.message ?? e).split('\n')[0];
    try { log(`  ⚠ ${dir}: core.hooksPath could not be verified or repaired: ${detail} — the pre-commit guards may NOT run; fix the git config before using this lane`); } catch { /* log only */ }
    return { status: 'error', detail };
  }
}
