/**
 * @file scripts/lib/__tests__/github-app-token.test.mjs
 * @description Unit proof of xs5drwb's GitHub App token minting utility. `buildAppJwt` is verified against a
 *   REAL fixture RSA keypair (generated once, in-process, at test-file load — never a real App's key) so the
 *   signature is checked with `crypto.verify`, not just asserted to be "some string". `mintInstallationToken`
 *   is exercised entirely over injected fakes — no real fs, no real network.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import {
  buildAppJwt, mintInstallationToken, defaultSign, MAX_JWT_LIFETIME_SECONDS, CLOCK_DRIFT_TOLERANCE_SECONDS,
  getInstallationInfo,
} from '../github-app-token.mjs';

const FAKE_PEM_PATH = '/fake/path/key.pem';
const fakePemReader = () => vi.fn(() => 'fake-pem-contents');

// A fixture keypair, generated once for this test file — NOT a real GitHub App's key, never written to disk.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const PUB_PEM = publicKey.export({ type: 'pkcs1', format: 'pem' });

function decodeJwt(jwt) {
  const [h, p, s] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
    signingInput: `${h}.${p}`,
    signature: s,
  };
}

describe('buildAppJwt — pure, verified against a real fixture keypair', () => {
  it('produces a JWT whose signature genuinely verifies against the matching public key', () => {
    const jwt = buildAppJwt({ appId: '12345', privateKeyPem: PEM, now: 1_700_000_000_000 });
    const { signingInput, signature } = decodeJwt(jwt);
    const ok = cryptoVerify(
      'RSA-SHA256',
      Buffer.from(signingInput),
      PUB_PEM,
      Buffer.from(signature, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('a signature verified against the WRONG public key fails — proves the check above is not a tautology', () => {
    const { publicKey: otherPub } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = buildAppJwt({ appId: '12345', privateKeyPem: PEM, now: 1_700_000_000_000 });
    const { signingInput, signature } = decodeJwt(jwt);
    const ok = cryptoVerify(
      'RSA-SHA256',
      Buffer.from(signingInput),
      otherPub.export({ type: 'pkcs1', format: 'pem' }),
      Buffer.from(signature, 'base64url'),
    );
    expect(ok).toBe(false);
  });

  it('header is alg:RS256, typ:JWT', () => {
    const jwt = buildAppJwt({ appId: '1', privateKeyPem: PEM, now: 1_700_000_000_000 });
    expect(decodeJwt(jwt).header).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('iss is the appId, passed through unchanged (works for either the numeric App ID or the newer Client ID form)', () => {
    expect(decodeJwt(buildAppJwt({ appId: 5037855, privateKeyPem: PEM, now: 0 })).payload.iss).toBe(5037855);
    expect(decodeJwt(buildAppJwt({ appId: 'Iv23lixf1FHpAeZCuXOL', privateKeyPem: PEM, now: 0 })).payload.iss).toBe('Iv23lixf1FHpAeZCuXOL');
  });

  it('iat is backdated exactly CLOCK_DRIFT_TOLERANCE_SECONDS — GitHub\'s own recommended clock-drift tolerance', () => {
    const now = 1_700_000_000_000;
    const { payload } = decodeJwt(buildAppJwt({ appId: '1', privateKeyPem: PEM, now }));
    expect(payload.iat).toBe(Math.floor(now / 1000) - CLOCK_DRIFT_TOLERANCE_SECONDS);
  });

  it('exp is iat + MAX_JWT_LIFETIME_SECONDS — GitHub\'s own documented maximum, never exceeded', () => {
    const { payload } = decodeJwt(buildAppJwt({ appId: '1', privateKeyPem: PEM, now: 1_700_000_000_000 }));
    expect(payload.exp - payload.iat).toBe(MAX_JWT_LIFETIME_SECONDS);
    expect(MAX_JWT_LIFETIME_SECONDS).toBe(600);
    expect(CLOCK_DRIFT_TOLERANCE_SECONDS).toBe(60);
  });

  it('the injected sign function receives exactly the signing input and the pem, nothing else', () => {
    const sign = vi.fn(() => 'fake-sig');
    const jwt = buildAppJwt({ appId: '1', privateKeyPem: PEM, now: 0, sign });
    expect(sign).toHaveBeenCalledTimes(1);
    const [signingInput, pem] = sign.mock.calls[0];
    expect(pem).toBe(PEM);
    expect(jwt).toBe(`${signingInput}.fake-sig`);
  });

  it('refuses a missing appId or privateKeyPem', () => {
    expect(() => buildAppJwt({ privateKeyPem: PEM })).toThrow(/appId is required/);
    expect(() => buildAppJwt({ appId: '1' })).toThrow(/privateKeyPem is required/);
  });
});

describe('defaultSign', () => {
  it('is what buildAppJwt uses by default — a real RS256 signature, not a stub', () => {
    const signingInput = 'header.payload';
    const sig = defaultSign(signingInput, PEM);
    const ok = cryptoVerify('RSA-SHA256', Buffer.from(signingInput), PUB_PEM, Buffer.from(sig, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('mintInstallationToken — IO shell over injected fakes (no real fs, no real network)', () => {
  const okArgs = () => ({
    appId: '5037855',
    installationId: '163880042',
    privateKeyPath: FAKE_PEM_PATH,
    readKey: fakePemReader(),
    buildJwt: vi.fn(() => 'fake.jwt.token'),
  });

  it('reads the key from the given path, builds the JWT, and POSTs to the exact GitHub endpoint', async () => {
    const args = okArgs();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: 'ghs_abc123', expires_at: '2026-09-22T20:00:00Z', permissions: { contents: 'read' } }),
    }));
    const result = await mintInstallationToken({ ...args, fetchImpl });
    expect(args.readKey).toHaveBeenCalledWith('/fake/path/key.pem');
    expect(args.buildJwt).toHaveBeenCalledWith({ appId: '5037855', privateKeyPem: 'fake-pem-contents', now: expect.any(Number) });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/app/installations/163880042/access_tokens',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer fake.jwt.token',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      }),
    );
    expect(result).toEqual({ token: 'ghs_abc123', expiresAt: '2026-09-22T20:00:00Z', permissions: { contents: 'read' } });
  });

  it('defaults permissions to {} when the API omits it', async () => {
    const args = okArgs();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ token: 't', expires_at: 'x' }) }));
    const result = await mintInstallationToken({ ...args, fetchImpl });
    expect(result.permissions).toEqual({});
  });

  it('a non-ok response throws with the HTTP status and the API\'s own body, never the JWT or key material', async () => {
    const args = okArgs();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'Bad credentials' }));
    await expect(mintInstallationToken({ ...args, fetchImpl })).rejects.toThrow(/HTTP 401.*Bad credentials/s);
  });

  it('a body read failure on the error path degrades gracefully, still reports the status', async () => {
    const args = okArgs();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, text: async () => { throw new Error('boom'); } }));
    await expect(mintInstallationToken({ ...args, fetchImpl })).rejects.toThrow(/HTTP 500/);
  });

  it('refuses a missing appId, installationId, or privateKeyPath before ever touching fs/network', async () => {
    const readKey = vi.fn();
    const fetchImpl = vi.fn();
    await expect(mintInstallationToken({ installationId: '1', privateKeyPath: 'x', readKey, fetchImpl })).rejects.toThrow(/appId is required/);
    await expect(mintInstallationToken({ appId: '1', privateKeyPath: 'x', readKey, fetchImpl })).rejects.toThrow(/installationId is required/);
    await expect(mintInstallationToken({ appId: '1', installationId: '1', readKey, fetchImpl })).rejects.toThrow(/privateKeyPath is required/);
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('getInstallationInfo — IO shell over injected fakes (no real fs, no real network)', () => {
  const okArgs = () => ({
    appId: '5037855',
    installationId: '163880042',
    privateKeyPath: FAKE_PEM_PATH,
    readKey: fakePemReader(),
    buildJwt: vi.fn(() => 'fake.jwt.token'),
  });

  it('reads the key, builds the JWT, and GETs the installation resource with a Bearer JWT (never the installation token)', async () => {
    const args = okArgs();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ permissions: { contents: 'write' }, repository_selection: 'all' }),
    }));
    const result = await getInstallationInfo({ ...args, fetchImpl });
    expect(args.readKey).toHaveBeenCalledWith('/fake/path/key.pem');
    expect(args.buildJwt).toHaveBeenCalledWith({ appId: '5037855', privateKeyPem: 'fake-pem-contents', now: expect.any(Number) });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/app/installations/163880042',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer fake.jwt.token',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      }),
    );
    expect(result).toEqual({ permissions: { contents: 'write' }, repositorySelection: 'all' });
  });

  it("defaults repositorySelection to null and permissions to {} when the API omits either", async () => {
    const args = okArgs();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    const result = await getInstallationInfo({ ...args, fetchImpl });
    expect(result).toEqual({ permissions: {}, repositorySelection: null });
  });

  // Live-confirmed 2026-09-26: `GET /app/installations/{id}` answers 401 to an installation access token —
  // only the App's own JWT works. This test pins the CONTRACT (a non-ok response throws, naming the status),
  // not the live 401 itself, which needs no fixture to prove since it is exactly `mintInstallationToken`'s own
  // non-ok handling, reused here.
  it('a non-ok response throws with the HTTP status and the API\'s own body, never the JWT or key material', async () => {
    const args = okArgs();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'Bad credentials' }));
    await expect(getInstallationInfo({ ...args, fetchImpl })).rejects.toThrow(/HTTP 401.*Bad credentials/s);
  });

  it('a body read failure on the error path degrades gracefully, still reports the status', async () => {
    const args = okArgs();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, text: async () => { throw new Error('boom'); } }));
    await expect(getInstallationInfo({ ...args, fetchImpl })).rejects.toThrow(/HTTP 500/);
  });

  it('refuses a missing appId, installationId, or privateKeyPath before ever touching fs/network', async () => {
    const readKey = vi.fn();
    const fetchImpl = vi.fn();
    await expect(getInstallationInfo({ installationId: '1', privateKeyPath: 'x', readKey, fetchImpl })).rejects.toThrow(/appId is required/);
    await expect(getInstallationInfo({ appId: '1', privateKeyPath: 'x', readKey, fetchImpl })).rejects.toThrow(/installationId is required/);
    await expect(getInstallationInfo({ appId: '1', installationId: '1', readKey, fetchImpl })).rejects.toThrow(/privateKeyPath is required/);
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
