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
import { cascadePolicy } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';

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
const isStrList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

/**
 * IO-light: resolve the effective placeholder lists (built-in ∪ configured extras) through the policy cascade.
 * Settings shape: `{ "gitIdentityPlaceholders": { "extraNames": [], "extraEmails": [], "extraEmailDomains": [] } }`
 * in any `scripts/settings/<feature>.json` (or the platform preference file). Env
 * `WE_GIT_IDENTITY_EXTRA_PLACEHOLDERS` = comma list of extra names/emails (an entry with `@` is an email,
 * one starting `@` is a domain). Never throws — a broken setting falls back to the built-in floor.
 * @returns {{names:string[], emails:string[], emailDomains:string[], sources:Record<string,string>}}
 */
export function resolveGitIdentityPlaceholders({ env = process.env, tool, readSettings = readDeclaredSettings } = {}) {
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
    extras = { ...standard, ...(r.value ?? {}) };
    sources = { ...sources, ...r.sources };
  } catch { /* the built-in floor still applies */ }
  const union = (a, b) => [...new Set([...a, ...b].map(norm).filter(Boolean))];
  return {
    names: union(BUILTIN_PLACEHOLDERS.names, extras.extraNames ?? []),
    emails: union(BUILTIN_PLACEHOLDERS.emails, extras.extraEmails ?? []),
    emailDomains: union(BUILTIN_PLACEHOLDERS.emailDomains, extras.extraEmailDomains ?? []),
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
      return parseIdent(run('git', ['var', v], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }));
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
