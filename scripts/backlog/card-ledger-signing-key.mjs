#!/usr/bin/env node
/** Provision only on explicit invocation; private keys never belong in a checkout. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicSigningIdentity } from '../lib/git-transport-branch.mjs';
import { resolveCardNumbering } from '../lib/policy-cascade.mjs';
export function provisionCardLedgerSigningKey({ keyPath = join(homedir(), '.config', 'web-everything', 'card-ledger', 'signing_key'), env = process.env, exec = execFileSync, chmod = chmodSync } = {}) {
  if (resolveCardNumbering({ env }).value.ledgerAuth !== 'signed') throw new Error('key provisioning requires ledgerAuth=signed');
  keyPath = resolve(keyPath);
  // Resolve ancestors too: a symlink outside a tree must not smuggle a key back into it.
  let ancestor = dirname(keyPath);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), relative(ancestor, keyPath));
  let dir = dirname(actual);
  for (;;) {
    if (existsSync(join(dir, '.git'))) throw new Error('signing key must be outside every checkout');
    const parent = dirname(dir); if (parent === dir) break; dir = parent;
  }
  if (existsSync(keyPath) && realpathSync(keyPath) !== actual) throw new Error('refusing signing key symlink');
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  if (!existsSync(keyPath)) exec('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'card-ledger-drain', '-f', keyPath], { stdio: 'pipe', timeout: 10000, maxBuffer: 16384 });
  chmod(keyPath, 0o600);
  return publicSigningIdentity(keyPath, exec);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(provisionCardLedgerSigningKey({ ...(process.env.WE_CARD_LEDGER_SIGNING_KEY ? { keyPath: process.env.WE_CARD_LEDGER_SIGNING_KEY } : {}) }), null, 2)); }
  catch (e) { console.error(String(e.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000)); process.exitCode = 1; }
}
