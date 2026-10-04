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
 * The repo owner a `gh` invocation targets, from its argv: `--repo X/Y`, `--repo=X/Y`, `-R X/Y`, `-RX/Y`, or an
 * `api repos/X/Y/...` path. `null` when the call names no repo (then the caller consults the checkout remote).
 * @param {string[]} argv
 */
export function ownerFromGhArgv(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    let v = null;
    if (a === '--repo' || a === '-R') v = args[i + 1];
    else if (a.startsWith('--repo=')) v = a.slice(7);
    else if (a.startsWith('-R') && a.length > 2) v = a.slice(2);
    if (v) {
      // `HOST/OWNER/REPO` form: take the last two segments.
      const parts = v.split('/');
      return ownerOfSlug(parts.slice(-2).join('/'));
    }
  }
  if (args[0] === 'api') {
    for (const a of args.slice(1)) {
      const m = /^\/?repos\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)/.exec(a);
      if (m) return canonicalOwner(m[1], m[2]);
    }
  }
  return null;
}

/** Per-installation token cache path, derived from the legacy single-cache path: `x.json` -> `x.<id>.json`. */
export function installationCachePath(cachePath, installationId) {
  return String(cachePath).replace(/\.json$/, '') + `.${installationId}.json`;
}
