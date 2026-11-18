#!/usr/bin/env node
/**
 * @file fixtures/take-clone-write-lock.mjs — soak fixture for `breaks/rebuild-spawner-reader-wait.mjs`. Plays the
 * detached rebuild job: asks the sim clone's REAL `daemon-clone-lock.mjs` (imported live from the tree under
 * test) for the WRITE lock, excluding the given owners, and prints the result as one JSON line.
 *
 * argv: <lockModulePath> <cloneRoot> <waitMs> <ignoreOwnersCsv> <lockRoot>
 */
import { pathToFileURL } from 'node:url';

const [, , lockModulePath, cloneRoot, waitMs, ignoreCsv, lockRoot] = process.argv;
const lockMod = await import(pathToFileURL(lockModulePath).href);
const ignoreOwners = String(ignoreCsv || '').split(',').filter(Boolean);
const startedAt = Date.now();
const res = await lockMod.acquireWrite(cloneRoot, { lockRoot, waitMs: Number(waitMs), pollMs: 100, ignoreOwners });
const out = { ok: !!res.ok, reason: res.reason ?? null, heldBy: res.heldBy ?? null, ms: Date.now() - startedAt };
if (res.ok) lockMod.releaseWrite(cloneRoot, { lockRoot });
process.stdout.write(`${JSON.stringify(out)}\n`);
