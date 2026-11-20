// @vitest-environment node
/**
 * S1 T8 / checklist 13 tests-first API:
 * signReceipt({fields,uidSweepConfirmed,readKey}) -> base64 Ed25519 signature.
 * readKey() -> PEM/KeyObject (possibly Promise), called only after === true.
 * Otherwise return null or throw, without reading the key or producing a signature.
 * Canonical JSON recursively sorts object keys; arrays retain order. Sign ONLY
 * {runName,nonce,manifestDigest,argvDigest,code,siblingShas,phase}; diagnostics,
 * timestamps, host and task-provided keys are excluded. No Forge/uid live proof here.
 */
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync, verify} from 'node:crypto';
import * as runnerAPI from '../forge-exec-run.mjs';

let root, keyPath, pair, reads;
const fields = () => ({runName: `r-${'1'.repeat(32)}`, nonce: '2'.repeat(32),
  manifestDigest: '3'.repeat(64), argvDigest: '4'.repeat(64), code: 0,
  siblingShas: {frontierui: '5'.repeat(40)}, phase: 'test'});
function canonical(value) {
  const sorted = item => Array.isArray(item) ? item.map(sorted) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])])) : item;
  return Buffer.from(JSON.stringify(sorted(value)));
}
function readKey() { reads++; return readFileSync(keyPath); }
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-receipt-sign-')));
  keyPath = join(root, 'root-only-signing-key.pem');
  pair = generateKeyPairSync('ed25519'); reads = 0;
  writeFileSync(keyPath, pair.privateKey.export({type: 'pkcs8', format: 'pem'}), {mode: 0o600});
});
afterEach(() => rmSync(root, {recursive: true, force: true}));

describe('Forge receipt signing after confirmed UID sweep', () => {
  it.each([false, undefined, null, 1, 'true', {}, []])(
    'T8 / checklist 13: unconfirmed sweep %j never signs and never reads the root key', async uidSweepConfirmed => {
      // Assert the export outside try/catch: a missing API is red, not an accepted refusal.
      expect(runnerAPI.signReceipt).toBeTypeOf('function');
      let result;
      try { result = await runnerAPI.signReceipt({fields: fields(), uidSweepConfirmed, readKey}); }
      catch (error) { expect(error).toBeInstanceOf(Error); }
      expect(result == null).toBe(true);
      expect(reads).toBe(0);
    });
  it('positive control: confirmed sweep signs canonical fields with real Ed25519', async () => {
    const input = fields();
    const signature = await runnerAPI.signReceipt({fields: input, uidSweepConfirmed: true, readKey});
    expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(verify(null, canonical(input), pair.publicKey, Buffer.from(signature, 'base64'))).toBe(true);
    expect(reads).toBe(1);
  });
  it('diagnostic key order, host and timestamps cannot change the signed payload', async () => {
    const input = fields();
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    Object.assign(reordered, {host: 'task-host', finishedAt: '2100-01-01',
      publicKey: 'task-supplied-key', debug: {untrusted: true}});
    const signature = await runnerAPI.signReceipt({fields: reordered, uidSweepConfirmed: true, readKey});
    expect(verify(null, canonical(input), pair.publicKey, Buffer.from(signature, 'base64'))).toBe(true);
  });
  it.each(['runName', 'nonce', 'manifestDigest', 'argvDigest', 'code', 'siblingShas', 'phase'])(
    'signature authenticates %s independently', async field => {
      const input = fields();
      const signature = await runnerAPI.signReceipt({fields: input, uidSweepConfirmed: true, readKey});
      const changed = {...input, [field]: field === 'code' ? 1 : field === 'siblingShas'
        ? {frontierui: '6'.repeat(40)} : 'changed'};
      expect(verify(null, canonical(changed), pair.publicKey, Buffer.from(signature, 'base64'))).toBe(false);
    });
  it('checklist 7,13: unreadable root key after confirmed sweep never returns a signature', async () => {
    expect(runnerAPI.signReceipt).toBeTypeOf('function');
    rmSync(keyPath);
    await expect(async () => runnerAPI.signReceipt({fields: fields(), uidSweepConfirmed: true, readKey})).rejects.toThrow();
  });
});
