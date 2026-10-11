/**
 * @file scripts/lib/github-app-identity.mjs
 * @description Per-role GitHub App identity (operator decision 2026-10-10 ~5:55 PM ET, five roles). An App's slug
 *   and bot login can never be renamed, so the fleet moves to five NEW Apps, one per job:
 *     - worker   — builders, fixers, ci-heal (everything not listed below)
 *     - reviewer — the review daemon, review-pr, review-set-label
 *     - merger   — the drain; the ONLY identity on `main`'s ruleset bypass list
 *     - ledger   — the sole writer of `ops/**` branches (verdict ledger, quarantine, red-main freeze, review-request
 *                  and pr-view transports)
 *     - observer — read-only callers (health watch, coroner, operator-queue, WIP/live-state, watchers, ledger shadow)
 *   This module makes each role's switch a SETTING. Until a role is configured it uses today's App ("legacy": the
 *   `WE_GITHUB_APP_*` env vars + `we:scripts/lib/github-app-installations.mjs`), so nothing changes before cutover.
 *
 * SETTING `delivery.identity.<role>` → `{ appId, installations: {owner|"owner/repo": installationId}, key, botLogin? }`
 *   `key` is a REFERENCE, never the key: `{file: "/path/key.pem"}` (or a bare path string) or
 *   `{keychain: {service, account?}}` (macOS keychain, read with `/usr/bin/security`). An inline PEM is refused.
 *   CASCADE, per role (a role's App is atomic — layers never mix one App's id with another's key):
 *     standard (null = today's App) → platform preference (`delivery.identity`) → tool/repo override
 *     (`we:scripts/settings/delivery-identity.json` → `delivery.identity`) → env `WE_DELIVERY_IDENTITY` (JSON
 *     `{role: {...}}`). The effective source of each role is logged once per daemon (shared policy-cascade log).
 *
 * WHICH ROLE A PROCESS PLAYS: explicit `role` argument > `WE_GITHUB_APP_ROLE` env > the caller map below (by the
 *   caller name `github-app-auth-env.mjs#defaultAuthCaller` derives: `<script>` or `pass-daemon.mjs:<pass>`) >
 *   worker. The map is itself a setting (`delivery.identity.callerRoles`), so a caller can be re-routed without code.
 *
 * FALLBACK, NEVER SILENT: role → worker → today's App. Once ANY role is configured (cutover has begun), a role that
 *   is unconfigured, invalid, unreadable, fails to mint or lacks a permission falls to the next App with a loud log
 *   and a per-caller status the `github-app-config` health smell reports. With NOTHING configured, today's App is
 *   the plain default, not a fallback, and nothing is logged.
 *
 * SETTING `delivery.botLogins` → the list of bot logins whose markers are trusted (marker-authorship.mjs). Default:
 *   today's bot (`web-everything`, `web-everything[bot]`) plus every configured role's `botLogin`. Each `x[bot]` is
 *   also trusted in its bare form `x` (the GraphQL comment shape) — `app/x` (PR author shape) is handled by callers.
 *   Env override: `WE_DELIVERY_BOT_LOGINS` (comma-separated). Reviewer INDEPENDENCE does not rest on logins: it is
 *   the harness session id (`we:scripts/lib/review-independence.mjs`), so a reviewer App never weakens it.
 *
 * Pure apart from {@link readDeliveryIdentity}/{@link readBotLogins} (settings files + env). Never throws.
 */
import { readSettings } from './settings-files.mjs';
import { platformPreference, logCascadeSources } from './policy-cascade.mjs';
import { installationMap, remapLegacyInstallationId, ownerOfSlug } from './github-app-installations.mjs';

export const GITHUB_APP_ROLES = Object.freeze(['worker', 'reviewer', 'merger', 'ledger', 'observer']);
export const FALLBACK_ROLE = 'worker';
export const LEGACY_ROLE = 'legacy';
export const ROLE_ENV = 'WE_GITHUB_APP_ROLE';
export const IDENTITY_ENV = 'WE_DELIVERY_IDENTITY';
export const BOT_LOGINS_ENV = 'WE_DELIVERY_BOT_LOGINS';
export const LEGACY_BOT_LOGINS = Object.freeze(['web-everything', 'web-everything[bot]']);

/**
 * Caller → role. Exact caller name, else a `prefix*` pattern, else the script part before `:`. Anything unlisted is
 * the worker. Write-capable watchers (stuck-pr-watch, parked-pr-*-watch, ci-red-recovery-watch, advisory-label-sweep,
 * duplicate-pr-watch, health-responder) stay worker: they label, comment or dispatch, which observer cannot.
 */
export const DEFAULT_CALLER_ROLES = Object.freeze({
  'merge-ai-prs.mjs': 'merger',
  'pass-daemon.mjs:merge-orphan-sweep': 'merger',
  'review-daemon.mjs': 'reviewer',
  'review-pr.mjs': 'reviewer',
  'review-set-label.mjs': 'reviewer',
  'review-prep.mjs': 'reviewer',
  'record-verdict.mjs': 'ledger',
  'record-verdict-cli.mjs': 'ledger',
  'collect-review-requests.mjs': 'ledger',
  'stage-pr-view.mjs': 'ledger',
  'produce-pr-view.mjs': 'ledger',
  'ledger-backfill-rulings.mjs': 'ledger',
  'handoff-home.mjs': 'ledger',
  'pass-daemon.mjs:health-watch': 'observer',
  'health-watch.mjs': 'observer',
  'pass-daemon.mjs:coroner-sweep': 'observer',
  'coroner-*': 'observer',
  'operator-queue.mjs': 'observer',
  'live-state.mjs': 'observer',
  'wip*': 'observer',
  'review-hold-ledger-shadow.mjs': 'observer',
  'github-app-status.mjs': 'observer',
  'pass-daemon.mjs:lane-pool-health-watch-*': 'observer',
  'pass-daemon.mjs:ci-queue-watch-*': 'observer',
  'pass-daemon.mjs:pr-movement-sweep': 'observer',
});

/** What each role's App must be granted (GitHub App permission levels). No role ever needs admin. */
export const ROLE_REQUIRED_PERMISSIONS = Object.freeze({
  worker: Object.freeze({ metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write', actions: 'write', checks: 'read', statuses: 'read', workflows: 'write' }),
  reviewer: Object.freeze({ metadata: 'read', pull_requests: 'write', issues: 'write', contents: 'read', checks: 'read', statuses: 'read', actions: 'read' }),
  merger: Object.freeze({ metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write', checks: 'read', statuses: 'read', actions: 'read', workflows: 'write' }),
  ledger: Object.freeze({ metadata: 'read', contents: 'write', pull_requests: 'read' }),
  observer: Object.freeze({ metadata: 'read', contents: 'read', pull_requests: 'read', issues: 'read', checks: 'read', statuses: 'read', actions: 'read' }),
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRole = (r) => GITHUB_APP_ROLES.includes(r);

/** PURE: a key reference, or null when invalid. Inline key material is never accepted. */
function normaliseKeyRef(key) {
  if (typeof key === 'string') key = { file: key };
  if (!isObj(key)) return null;
  if (typeof key.file === 'string' && key.file.trim() && !key.file.includes('PRIVATE KEY')) return { file: key.file.trim() };
  const kc = key.keychain;
  if (isObj(kc) && typeof kc.service === 'string' && kc.service.trim()) {
    return { keychain: { service: kc.service.trim(), ...(typeof kc.account === 'string' && kc.account.trim() ? { account: kc.account.trim() } : {}) } };
  }
  return null;
}

/** PURE: one role's App config, normalised, or null when it is not a complete, valid App. */
export function normaliseRoleApp(raw) {
  if (!isObj(raw)) return null;
  const appId = typeof raw.appId === 'number' ? String(raw.appId) : (typeof raw.appId === 'string' ? raw.appId.trim() : '');
  if (!appId || !/^[A-Za-z0-9._-]+$/.test(appId)) return null;
  const key = normaliseKeyRef(raw.key);
  if (!key) return null;
  if (!isObj(raw.installations)) return null;
  const installations = {};
  for (const [k, v] of Object.entries(raw.installations)) {
    const id = String(v ?? '');
    if (!/^\d+$/.test(id)) return null;
    const owner = k.includes('/') ? ownerOfSlug(k) : String(k).trim().toLowerCase();
    if (!owner) return null;
    const o = owner.toLowerCase();
    if (installations[o] && installations[o] !== id) return null; // two installations for one account: ambiguous
    installations[o] = id;
  }
  if (!Object.keys(installations).length) return null;
  const botLogin = typeof raw.botLogin === 'string' && raw.botLogin.trim() ? raw.botLogin.trim().toLowerCase() : null;
  return { appId, installations, key, ...(botLogin ? { botLogin } : {}) };
}

function parseEnvIdentity(env) {
  const raw = String(env?.[IDENTITY_ENV] ?? '').trim();
  if (!raw) return { value: {}, error: null };
  try { const v = JSON.parse(raw); return { value: isObj(v) ? v : {}, error: isObj(v) ? null : `${IDENTITY_ENV} is not a JSON object` }; } catch (e) {
    return { value: {}, error: `${IDENTITY_ENV}: ${String(e?.message ?? e).split('\n')[0]}` };
  }
}

/**
 * PURE: resolve every role through standard → platform → tool → env. A layer whose value for a role is present but
 * invalid is ignored (named in `invalid`); a lower valid layer still applies.
 * @returns {{roles:Record<string,object|null>, sources:Record<string,string>, invalid:string[], anyConfigured:boolean,
 *   callerRoles:Record<string,string>}}
 */
export function resolveDeliveryIdentity({ platform = {}, tool = {}, env = {} } = {}) {
  const envLayer = parseEnvIdentity(env);
  const invalid = envLayer.error ? [envLayer.error] : [];
  const roles = {};
  const sources = {};
  for (const role of GITHUB_APP_ROLES) {
    roles[role] = null;
    sources[role] = 'standard';
    for (const [name, layer] of [['platform', platform], ['tool', tool], ['env', envLayer.value]]) {
      if (!isObj(layer) || layer[role] === undefined || layer[role] === null) continue;
      const app = normaliseRoleApp(layer[role]);
      if (!app) { invalid.push(`${name}.${role}`); continue; }
      roles[role] = app;
      sources[role] = name;
    }
  }
  const callerRoles = { ...DEFAULT_CALLER_ROLES };
  for (const layer of [platform, tool, envLayer.value]) {
    if (!isObj(layer?.callerRoles)) continue;
    for (const [caller, role] of Object.entries(layer.callerRoles)) if (isRole(role)) callerRoles[caller] = role;
  }
  return { roles, sources, invalid, anyConfigured: GITHUB_APP_ROLES.some((r) => roles[r]), callerRoles };
}

let cachedTool;
/** Test seam. @test-only-export-ok */
export function resetDeliveryIdentityCacheForTest() { cachedTool = undefined; }

/** IO: the live identity (settings files + platform preference + env), sources logged once per daemon. Never throws. */
export function readDeliveryIdentity({ env = process.env, read = readSettings } = {}) {
  let tool = {};
  let platform = {};
  try {
    if (read !== readSettings || cachedTool === undefined) {
      const t = read()?.delivery?.identity;
      tool = isObj(t) ? t : {};
      if (read === readSettings) cachedTool = tool;
    } else tool = cachedTool;
  } catch { tool = {}; }
  try { const p = platformPreference('delivery', { env })?.identity; platform = isObj(p) ? p : {}; } catch { platform = {}; }
  const resolved = resolveDeliveryIdentity({ platform, tool, env });
  const shown = Object.fromEntries(GITHUB_APP_ROLES.map((r) => [r, resolved.roles[r] ? `app ${resolved.roles[r].appId}` : "today's App"]));
  logCascadeSources('delivery.identity', { value: shown, sources: resolved.sources, invalid: resolved.invalid }, { env });
  return resolved;
}

/** PURE: the role a caller name maps to, or null (→ worker). */
export function roleForCaller(caller, callerRoles = DEFAULT_CALLER_ROLES) {
  if (!caller) return null;
  const c = String(caller);
  if (Object.hasOwn(callerRoles, c)) return callerRoles[c];
  for (const [pat, role] of Object.entries(callerRoles)) {
    if (pat.endsWith('*') && c.startsWith(pat.slice(0, -1))) return role;
  }
  const script = c.split(':')[0];
  if (script !== c && Object.hasOwn(callerRoles, script)) return callerRoles[script];
  return null;
}

/** PURE: which role this process plays, and why. */
export function resolveRequestedRole({ role, env = {}, caller, callerRoles = DEFAULT_CALLER_ROLES } = {}) {
  if (isRole(role)) return { role, source: 'arg' };
  const fromEnv = String(env?.[ROLE_ENV] ?? '').trim().toLowerCase();
  if (isRole(fromEnv)) return { role: fromEnv, source: 'env' };
  const mapped = roleForCaller(caller, callerRoles);
  if (isRole(mapped)) return { role: mapped, source: 'caller' };
  return { role: FALLBACK_ROLE, source: 'default' };
}

/** PURE: a role App's own token cache: `x.json` → `x.app-<appId>.json` (per-installation files derive from it). */
export function roleCachePath(cachePath, appId) {
  return String(cachePath).replace(/\.json$/, '') + `.app-${String(appId).replace(/[^A-Za-z0-9._-]+/g, '_')}.json`;
}

/** The installation an App uses when a call names no repo: the default owner's, else its first. */
function primaryInstallation(installations) {
  return installations['web-everything'] ?? Object.values(installations)[0];
}

/**
 * PURE: the ordered Apps to try for `requestedRole`: role → worker → today's App. Roles with no usable config are
 * `skipped` (with why). `loud` is true once any role is configured: from then on every fallback is reported.
 * @returns {{requestedRole:string, candidates:object[], skipped:{role:string,reason:string}[], steps:object[], loud:boolean}}
 */
export function buildIdentityChain({ requestedRole = FALLBACK_ROLE, identity, env = {}, cachePath }) {
  const id = identity ?? resolveDeliveryIdentity({});
  const order = requestedRole === FALLBACK_ROLE ? [FALLBACK_ROLE] : [requestedRole, FALLBACK_ROLE];
  const candidates = [];
  const skipped = [];
  const steps = []; // role Apps in order: {candidate} or {skip}
  for (const role of order) {
    const app = id.roles?.[role];
    if (!app) { const skip = { role, reason: id.invalid?.some((s) => s.endsWith(`.${role}`)) ? 'invalid' : 'unconfigured' }; skipped.push(skip); steps.push({ skip }); continue; }
    const candidate = {
      role, appId: app.appId, installations: app.installations, installationId: primaryInstallation(app.installations),
      keyRef: app.key, privateKeyPath: app.key.file ?? `keychain:${app.key.keychain.service}`, cachePath: roleCachePath(cachePath, app.appId),
      required: ROLE_REQUIRED_PERMISSIONS[role],
    };
    candidates.push(candidate);
    steps.push({ candidate });
  }
  const appId = env?.WE_GITHUB_APP_ID;
  const installationId = env?.WE_GITHUB_APP_INSTALLATION_ID;
  const privateKeyPath = env?.WE_GITHUB_APP_PRIVATE_KEY_PATH;
  candidates.push({
    role: LEGACY_ROLE, legacy: true,
    ...(appId && installationId && privateKeyPath ? { appId, installationId: remapLegacyInstallationId(installationId, env), privateKeyPath, keyRef: { file: privateKeyPath } } : {}),
    installations: installationMap(env), cachePath,
  });
  return { requestedRole, candidates, skipped, steps, loud: !!id.anyConfigured };
}

/**
 * PURE: the role table the generated `gh` shim bakes in — `{role: {cachePath, installations}}` for every configured
 * role. Empty when nothing is configured (the shim then behaves exactly as before).
 */
export function shimRoleTable({ identity, cachePath }) {
  const out = {};
  for (const role of GITHUB_APP_ROLES) {
    const app = identity?.roles?.[role];
    if (app) out[role] = { cachePath: roleCachePath(cachePath, app.appId), installations: { ...app.installations } };
  }
  return out;
}

/** PURE: `x[bot]` also trusted as `x`; lower-cased, de-duplicated, order kept. */
function expandLogins(list) {
  const out = [];
  for (const raw of list) {
    const l = String(raw ?? '').trim().toLowerCase();
    if (!l) continue;
    const bare = l.endsWith('[bot]') ? l.slice(0, -5) : null;
    for (const x of bare ? [bare, l] : [l]) if (!out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * PURE: the trusted bot logins. Cascade: standard (today's bot + every configured role's botLogin) → platform list →
 * tool list → env `WE_DELIVERY_BOT_LOGINS`. A list layer REPLACES the lower one (it is the whole trusted set).
 */
export function resolveBotLogins({ platform, tool, env = {}, identity } = {}) {
  let list = [...LEGACY_BOT_LOGINS];
  for (const role of GITHUB_APP_ROLES) { const b = identity?.roles?.[role]?.botLogin; if (b) list.push(b); }
  for (const layer of [platform, tool]) if (Array.isArray(layer) && layer.some((s) => typeof s === 'string' && s.trim())) list = layer.filter((s) => typeof s === 'string');
  const fromEnv = String(env?.[BOT_LOGINS_ENV] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length) list = fromEnv;
  return expandLogins(list);
}

/** IO: the live trusted bot logins. Never throws (falls back to today's bot). */
export function readBotLogins({ env = process.env, read = readSettings } = {}) {
  try {
    const tool = read()?.delivery?.botLogins;
    let platform;
    try { platform = platformPreference('delivery', { env })?.botLogins; } catch { platform = undefined; }
    return resolveBotLogins({ platform, tool, env, identity: readDeliveryIdentity({ env, read }) });
  } catch { return expandLogins(LEGACY_BOT_LOGINS); }
}

/**
 * PURE: which role's App posted as `login` (`x`, `x[bot]` or the PR-author shape `app/x`): a configured role, else
 * `legacy` for today's bot, else null. The cutover's "proof of who posted".
 */
export function roleOfBotLogin(login, identity) {
  const l = String(login ?? '').trim().toLowerCase().replace(/^app\//, '');
  if (!l) return null;
  const bare = l.endsWith('[bot]') ? l.slice(0, -5) : l;
  for (const role of GITHUB_APP_ROLES) {
    const b = identity?.roles?.[role]?.botLogin;
    if (b && (b === l || b.replace(/\[bot\]$/, '') === bare)) return role;
  }
  return LEGACY_BOT_LOGINS.some((b) => b.replace(/\[bot\]$/, '') === bare) ? LEGACY_ROLE : null;
}

// ── DRY-RUN CLI: which App would this caller use? Reads settings + env, mints nothing, never reads a key. ──────────
//   node scripts/lib/github-app-identity.mjs --caller=merge-ai-prs.mjs [--role=reviewer] [--json]
const IS_CLI = process.argv[1] && /github-app-identity\.mjs$/.test(process.argv[1]);
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || undefined;
  const identity = readDeliveryIdentity({ env: process.env });
  const callers = flag('caller') ? flag('caller').split(',') : Object.keys(DEFAULT_CALLER_ROLES).filter((c) => !c.endsWith('*'));
  const rows = callers.map((caller) => {
    const req = resolveRequestedRole({ role: flag('role'), env: process.env, caller, callerRoles: identity.callerRoles });
    const chain = buildIdentityChain({ requestedRole: req.role, identity, env: process.env, cachePath: '~/.claude/github-app-token/web-everything.json' });
    const first = chain.candidates[0];
    return {
      caller, role: req.role, roleSource: req.source,
      uses: first.role === LEGACY_ROLE ? "today's App" : `${first.role} App ${first.appId}`,
      fallback: chain.loud && first.role !== req.role, skipped: chain.skipped,
      chain: chain.candidates.map((c) => (c.legacy ? 'legacy' : `${c.role}:${c.appId}`)),
    };
  });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify({ sources: identity.sources, invalid: identity.invalid, rows }, null, 2) + '\n');
  else {
    for (const r of rows) process.stdout.write(`${r.caller} → ${r.role} (${r.roleSource}) → ${r.uses}${r.fallback ? `  FALLBACK (${r.skipped.map((s) => `${s.role}: ${s.reason}`).join(', ')})` : ''}  [${r.chain.join(' → ')}]\n`);
    if (identity.invalid.length) process.stdout.write(`ignored invalid: ${identity.invalid.join('; ')}\n`);
  }
}
