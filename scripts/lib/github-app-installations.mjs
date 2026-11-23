/**
 * @file scripts/lib/github-app-installations.mjs
 * @description Owner -> GitHub App installation map. After the 2026-10-03 org move each constellation repo
 *   lives under its own org, and a GitHub App installation covers ONE account, so a single installation id can
 *   no longer mint a token that works for all three repos. This is the ONE config place for the mapping; the
 *   token minter (`github-app-auth-env.mjs`) and the generated `gh` shim (`gh-app-shim.mjs`) both read it.
 *
 *   Override at runtime with `WE_GITHUB_APP_INSTALLATIONS` (JSON object `{"owner":"installationId"}`) when an
 *   org is added or an installation is re-created. An owner that is not in the map has NO App token: callers
 *   fall back to personal auth and log a warning.
 *
 *   Pure: no fs, no network. Nothing here touches the private key.
 */

/** owner (lower-case) -> installation id (string). Installed by the operator 2026-10-03 ~17:10 ET. */
export const OWNER_INSTALLATIONS = Object.freeze({
  'web-everything': '167640002',
  'frontier-ui': '167639957',
  plateauapp: '167639975',
});

/** The retired personal-account installation. A daemon env that still carries it is remapped (see
 *  {@link remapLegacyInstallationId}), so the 13 launchd plists keep working before they are edited. */
export const LEGACY_PERSONAL_INSTALLATION_ID = '163880042';

/** The owner whose installation is the default one for a caller that targets no particular repo. */
export const DEFAULT_OWNER = 'web-everything';

/** The effective owner->installation map: the built-in one, overlaid by `WE_GITHUB_APP_INSTALLATIONS` (JSON). */
export function installationMap(env = process.env) {
  const map = { ...OWNER_INSTALLATIONS };
  const raw = env && env.WE_GITHUB_APP_INSTALLATIONS;
  if (raw) {
    try {
      const extra = JSON.parse(raw);
      for (const [owner, id] of Object.entries(extra || {})) {
        if (/^\d+$/.test(String(id))) map[String(owner).toLowerCase()] = String(id);
      }
    } catch { /* a malformed override is ignored — the built-in map still applies */ }
  }
  return map;
}

/** The installation id for a repo owner, or `null` when the owner is unknown (-> personal auth). */
export function installationForOwner(owner, env = process.env) {
  if (!owner) return null;
  const map = installationMap(env);
  const key = String(owner).toLowerCase();
  return Object.hasOwn(map, key) ? map[key] : null;
}

/** A legacy personal installation id becomes the default owner's installation; anything else is unchanged. */
export function remapLegacyInstallationId(installationId, env = process.env) {
  return String(installationId) === LEGACY_PERSONAL_INSTALLATION_ID
    ? (installationForOwner(DEFAULT_OWNER, env) ?? String(installationId))
    : String(installationId);
}

/** Repo names that moved off the personal `chalbert` account on 2026-10-03, with the org each now lives in.
 *  A checkout or script that still names `chalbert/<repo>` (GitHub redirects it) resolves to the new owner. */
export const MOVED_REPO_OWNERS = Object.freeze({
  'web-everything': 'web-everything',
  webeverything: 'web-everything',
  frontierui: 'frontier-ui',
  'plateau-app': 'plateauapp',
});

/** The owner to use for `owner/repo`: the legacy personal owner is replaced by the repo's new org. */
export function canonicalOwner(owner, repo) {
  const o = String(owner || '');
  const r = String(repo || '').replace(/\.git$/, '');
  if (o.toLowerCase() === 'chalbert' && Object.hasOwn(MOVED_REPO_OWNERS, r)) return MOVED_REPO_OWNERS[r];
  return o || null;
}

/** `owner` of a slug like `web-everything/web-everything`; `null` when it is not a plain owner/name. */
export function ownerOfSlug(slug) {
  const m = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(String(slug || '').trim());
  return m ? canonicalOwner(m[1], m[2]) : null;
}

/** The owner a git remote URL points at (https or ssh forms), or `null`. */
export function ownerFromRemoteUrl(url) {
  const m = /github\.com[:/]([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(String(url || '').replace(/\/\/[^@/]*@/, '//'));
  return m ? canonicalOwner(m[1], m[2]) : null;
}

/**
 * Resolve explicit argv targets. null means no target; false means GraphQL target fields
 * were supplied but cannot safely identify an owner (callers must refuse ambient auth).
 * Self-contained because the gh shim embeds this function via toString().
 * @param {string[]} argv
 */
export function ownerFromGhArgv(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  // Preserve the existing non-api repo selector behavior.
  if (args[0] !== 'api') {
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      const v = a === '--repo' || a === '-R' ? args[i + 1]
        : a.startsWith('--repo=') ? a.slice(7)
          : a.startsWith('-R') ? a.slice(2) : null;
      if (v) return ownerOfSlug(v.split('/').slice(-2).join('/'));
    }
    return null;
  }
  const takesValue = new Set(['header', 'method', 'raw-field', 'field', 'input', 'jq', 'template', 'cache', 'hostname', 'repo', 'preview']);
  const shorts = { H: 'header', X: 'method', f: 'raw-field', F: 'field', q: 'jq', t: 'template', R: 'repo', p: 'preview' };
  let endpoint;
  let repoSelector;
  let owner;
  let name;
  let repo;
  let hasTarget = false;
  let invalid = false;
  const consume = (option, value) => {
    if (option === 'repo' && repoSelector === undefined) repoSelector = value;
    if (option !== 'field' && option !== 'raw-field') return;
    // Only actual field keys count, never substrings inside queries or other values.
    const match = /^(owner|name|repo)(?:=([\s\S]*))?$/.exec(value || '');
    if (!match) return;
    hasTarget = true;
    const key = match[1];
    const v = match[2];
    const valid = key === 'owner' ? /^[A-Za-z0-9][A-Za-z0-9-]*(?![\s\S])/ : /^[A-Za-z0-9._-]+(?![\s\S])/;
    if (v === undefined || !valid.test(v)) { invalid = true; return; }
    const previous = key === 'owner' ? owner : key === 'name' ? name : repo;
    if (previous !== undefined && previous !== v) invalid = true;
    if (key === 'owner') owner = v;
    else if (key === 'name') name = v;
    else repo = v;
  };
  let positionalOnly = false;
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i];
    if (!positionalOnly && a === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && a.startsWith('--')) {
      const equals = a.indexOf('=');
      const option = a.slice(2, equals < 0 ? undefined : equals);
      if (takesValue.has(option)) consume(option, equals < 0 ? args[++i] : a.slice(equals + 1));
      continue;
    }
    if (!positionalOnly && a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j += 1) {
        const option = shorts[a[j]];
        if (!option) continue; // Boolean switches may precede a value-taking short option.
        consume(option, j + 1 < a.length ? a.slice(j + 1) : args[++i]);
        break;
      }
      continue;
    }
    if (endpoint === undefined) endpoint = a;
  }
  if (endpoint === 'graphql' && hasTarget) {
    if (invalid || !owner || (!name && !repo) || (name && repo && name !== repo)) return false;
    return canonicalOwner(owner, name || repo);
  }
  if (repoSelector) return ownerOfSlug(repoSelector.split('/').slice(-2).join('/'));
  const m = /^\/?repos\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)/.exec(endpoint || '');
  return m ? canonicalOwner(m[1], m[2]) : null;
}

/** Per-installation token cache path, derived from the legacy single-cache path: `x.json` -> `x.<id>.json`. */
export function installationCachePath(cachePath, installationId) {
  return String(cachePath).replace(/\.json$/, '') + `.${installationId}.json`;
}
