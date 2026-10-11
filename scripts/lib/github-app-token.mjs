#!/usr/bin/env node
/**
 * @file scripts/lib/github-app-token.mjs
 * @description xs5drwb (epic #3383) — mint a GitHub App installation access token: build the RS256 JWT a
 *   GitHub App uses to authenticate as ITSELF (never as a user), then exchange it for a short-lived
 *   (1-hour) installation access token scoped to exactly the permissions granted at installation time.
 *
 *   GENERIC AND DECISION-AGNOSTIC. This does not wire into any daemon's actual credential-inheritance path —
 *   that is #3872's own call to make (GitHub App vs fine-grained PAT vs status quo), not presupposed here.
 *   This file only makes the technical capability available and testable ahead of that ratification, the
 *   same way #3877 built the keyed-lease MECHANISM before any daemon actually used it.
 *
 *   NO NEW DEPENDENCY. `node:crypto`'s `createSign('RSA-SHA256')` signs the JWT directly — this repo's own
 *   native-first default (built-in defaults align to the platform; a library is opt-in, not needed here).
 *
 * THE JWT'S OWN SHAPE (GitHub's documented contract, not a made-up convention):
 *   - `iat` is backdated 60 SECONDS into the past — GitHub's own recommended clock-drift tolerance; without
 *     it, a JWT minted on a clock running even slightly ahead of GitHub's own servers is rejected as "not
 *     yet valid".
 *   - `exp` is `iat + 600` (10 minutes) — GitHub's own documented MAXIMUM JWT lifetime; a longer expiry is
 *     rejected outright, not silently truncated.
 *   - `iss` is the App ID (GitHub also now accepts the newer Client ID form as `iss` — either works; this
 *     file takes whichever the caller passes, unvalidated, since only GitHub itself can judge which of the
 *     two forms is well-formed).
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors every other daemon/dispatch primitive in this epic):
 *   - {@link buildAppJwt} is pure — no fs, no network, no real clock (every input, including `now` and the
 *     signing function itself, is injected) — unit-tested against a fixture keypair, no real GitHub App
 *     needed to prove the JWT's own shape is correct.
 *   - {@link mintInstallationToken} is the thin IO shell: reads the private key file, builds the JWT, calls
 *     the real GitHub API. `readKey`/`buildJwt`/`fetchImpl` are all injectable for the same reason.
 */

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read an App's PEM private key from a REFERENCE (`we:scripts/lib/github-app-identity.mjs` — settings only ever hold
 * a reference): `{file}` (or a bare path) reads the file; `{keychain: {service, account?}}` reads the macOS keychain
 * with the absolute `/usr/bin/security` (never a PATH lookup). `security -w` prints a secret containing newlines (a
 * PEM) as hex, so a hex answer that decodes to a PEM is decoded. Throws on failure — the caller treats it like an
 * unreadable key and never echoes the value.
 * @param {string|{file?:string, keychain?:{service:string, account?:string}}} keyRef
 * @param {{readFile?:Function, exec?:Function}} [o]
 * @returns {string}
 */
export function readPrivateKeyRef(keyRef, { readFile = (p) => readFileSync(p, 'utf8'), exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }) } = {}) {
  const ref = typeof keyRef === 'string' ? { file: keyRef } : keyRef;
  if (ref?.file) return String(readFile(ref.file));
  const kc = ref?.keychain;
  if (!kc?.service) throw new TypeError('github-app-token: key reference needs {file} or {keychain:{service}}');
  const args = ['find-generic-password', '-s', kc.service, ...(kc.account ? ['-a', kc.account] : []), '-w'];
  const out = String(exec('/usr/bin/security', args) ?? '').trim();
  if (/^[0-9a-f]+$/i.test(out) && out.length % 2 === 0) {
    const decoded = Buffer.from(out, 'hex').toString('utf8');
    if (decoded.includes('PRIVATE KEY')) return decoded;
  }
  return out.replace(/\\n/g, '\n');
}

/** Can the key reference be read? Never throws, never returns the key. */
export function canReadPrivateKeyRef(keyRef, o) {
  try { return readPrivateKeyRef(keyRef, o).length > 0; } catch { return false; }
}

/** GitHub's own documented maximum JWT lifetime — a longer `exp` is rejected outright by their API. */
export const MAX_JWT_LIFETIME_SECONDS = 600;

/** GitHub's own recommended clock-drift tolerance — `iat` is backdated this many seconds. */
export const CLOCK_DRIFT_TOLERANCE_SECONDS = 60;

/** Base64url, no padding — the encoding both the JWT header/payload and its signature use. */
function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** The default signer — RS256 over the signing input, using the App's own PEM-encoded private key.
 *  Injectable so {@link buildAppJwt}'s own tests can supply a fixture keypair without touching real crypto
 *  material, and so a caller could swap in an HSM-backed signer later without this file changing. */
export function defaultSign(signingInput, privateKeyPem) {
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return signer.sign(privateKeyPem).toString('base64url');
}

/**
 * Build the RS256 JWT a GitHub App uses to authenticate as itself. Pure — no fs, no network, no real clock.
 * @param {{appId: string|number, privateKeyPem: string, now?: number, sign?: typeof defaultSign}} o
 * @returns {string} the encoded `header.payload.signature` JWT
 */
export function buildAppJwt({ appId, privateKeyPem, now = Date.now(), sign = defaultSign } = {}) {
  if (!appId) throw new TypeError('github-app-token: appId is required');
  if (!privateKeyPem) throw new TypeError('github-app-token: privateKeyPem is required');
  const iat = Math.floor(now / 1000) - CLOCK_DRIFT_TOLERANCE_SECONDS;
  const exp = iat + MAX_JWT_LIFETIME_SECONDS;
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat, exp, iss: appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign(signingInput, privateKeyPem);
  return `${signingInput}.${signature}`;
}

/**
 * Mint a real installation access token. The IO shell: reads the key file, builds the JWT, calls
 * `POST /app/installations/{id}/access_tokens`.
 * @param {{appId: string|number, installationId: string|number, privateKeyPath: string,
 *   readKey?: (path: string) => string, buildJwt?: typeof buildAppJwt, fetchImpl?: typeof fetch,
 *   now?: number}} o
 * @returns {Promise<{token: string, expiresAt: string, permissions: object}>}
 */
export async function mintInstallationToken({
  appId, installationId, privateKeyPath,
  readKey = (p) => readFileSync(p, 'utf8'),
  buildJwt = buildAppJwt,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  if (!appId) throw new TypeError('github-app-token: appId is required');
  if (!installationId) throw new TypeError('github-app-token: installationId is required');
  if (!privateKeyPath) throw new TypeError('github-app-token: privateKeyPath is required');
  const privateKeyPem = readKey(privateKeyPath);
  const jwt = buildJwt({ appId, privateKeyPem, now });
  const res = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Never echo the JWT or key material — only the API's own response body, already problem-specific.
    throw new Error(`github-app-token: mint failed (HTTP ${res.status}): ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  return { token: data.token, expiresAt: data.expires_at, permissions: data.permissions ?? {} };
}

/**
 * Read the installation's OWN resource — `GET /app/installations/{id}`, authenticated as the App itself (the
 * App's own JWT, `Authorization: Bearer <jwt>`) — NEVER an installation access token: live-confirmed
 * 2026-09-26 that this endpoint answers 401 to an installation token, only a JWT works.
 *
 * WHY THIS CALL EXISTS, GIVEN `mintInstallationToken` ALREADY RETURNS `permissions`. Live-caught 2026-09-26:
 * `we:scripts/lib/github-app-auth-env.mjs#findInstallationGaps`'s repo check depended entirely on enumerating
 * `GET /installation/repositories` (`defaultListInstallationRepos`) — a listing endpoint that can lag the
 * installation's own `repository_selection` field for a short window right after a permission/repo-access
 * change (the fleet hit exactly this: both daemons logged every one of `REQUIRED_APP_REPOS` as missing while
 * a fresh, independent mint at the same moment showed every permission correctly granted and the listing
 * endpoint itself returning all three required repos once it caught up). `repository_selection` (`'all'` or
 * `'selected'`) is a field on the installation resource itself, set synchronously the moment the operator
 * changes it on github.com — never subject to the listing endpoint's own lag — so a caller that already knows
 * it is `'all'` never needs to enumerate anything to know every repo is covered.
 * @param {{appId: string|number, installationId: string|number, privateKeyPath: string,
 *   readKey?: (path: string) => string, buildJwt?: typeof buildAppJwt, fetchImpl?: typeof fetch,
 *   now?: number}} o
 * @returns {Promise<{permissions: object, repositorySelection: string|null}>}
 */
export async function getInstallationInfo({
  appId, installationId, privateKeyPath,
  readKey = (p) => readFileSync(p, 'utf8'),
  buildJwt = buildAppJwt,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  if (!appId) throw new TypeError('github-app-token: appId is required');
  if (!installationId) throw new TypeError('github-app-token: installationId is required');
  if (!privateKeyPath) throw new TypeError('github-app-token: privateKeyPath is required');
  const privateKeyPem = readKey(privateKeyPath);
  const jwt = buildJwt({ appId, privateKeyPem, now });
  const res = await fetchImpl(`https://api.github.com/app/installations/${installationId}`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Never echo the JWT or key material — only the API's own response body, same discipline as mintInstallationToken.
    throw new Error(`github-app-token: installation info fetch failed (HTTP ${res.status}): ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  return { permissions: data.permissions ?? {}, repositorySelection: data.repository_selection ?? null };
}

// ── IO SHELL (runs only as a CLI) ───────────────────────────────────────────────────────────────────────────
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || undefined;
  const appId = flag('app-id');
  const installationId = flag('installation-id');
  const privateKeyPath = flag('key');
  if (!appId || !installationId || !privateKeyPath) {
    process.stderr.write(
      'usage: github-app-token.mjs --app-id=<id> --installation-id=<id> --key=<path-to-pem>\n',
    );
    process.exitCode = 1; // never process.exit() here — see we:scripts/lib/write-all-sync.mjs's own
    // footgun writeup: an exit that is the LAST thing to run takes exitCode + return, not a hard exit, so a
    // large stdout write elsewhere in this same CLI can never race a truncating process.exit.
  } else {
    mintInstallationToken({ appId, installationId, privateKeyPath })
      .then((result) => {
        // The token itself is short-lived (1 hour) and scoped — printing it to stdout for a human-driven
        // CLI invocation is the intended use (pipe it straight into `gh auth login --with-token` or
        // similar); a daemon consuming this programmatically should import `mintInstallationToken`
        // directly instead of shelling this CLI and scraping stdout.
        process.stdout.write(JSON.stringify(result) + '\n');
      })
      .catch((e) => {
        process.stderr.write(`${String((e && e.message) || e)}\n`);
        process.exitCode = 1; // same reasoning as above — no process.exit()
      });
  }
}
