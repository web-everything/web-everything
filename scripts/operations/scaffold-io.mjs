/**
 * @file scripts/operations/scaffold-io.mjs
 * @description THE IO SHELL of the `scaffold` declaration (#xrrpfo7) — the reader its `read` step is
 *   injected with, and the sink its `write` effect is applied through.
 *
 * Reads the existing id set and today's date, and reserves the final id through the shared allocator.
 * Everything the item becomes is decided in the pure plan, so the sink writes bytes it did not choose — which
 * is what makes the #2288 collision retry testable with no filesystem.
 *
 * THE WRITE GOES THROUGH THE GUARDED WRITER, never a bare `writeFileSync`. That writer owns the
 * lane-not-primary refusal AND the #883 locus scan, and the scan is not incidental here: it fired three times
 * while cards were being filed on 2026-08-21, each time FAIL-CLOSED with nothing written and the fix named in
 * the message. A scaffold that wrote around it would turn that into a card that lands and reddens CI.
 *
 * IMPURE by construction: `fs`.
 */

import { readdirSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeBacklogMd } from '../backlog/guarded-write.mjs';
// #2747 — the shared wall-clock helper. A hand-rolled UTC day-slice stamps the runtime's UTC day, which runs
// a day ahead of a UTC-behind operator all evening; `check:standards` scans for that shape and caught the
// first cut of `resolve-io.mjs` doing exactly it.
import { localToday } from '../lib/local-date.mjs';
import { nextHash } from '../backlog/id.mjs';
import { allocateCardNumber } from '../lib/card-number-allocator.mjs';
import { SCAFFOLD_EFFECT } from './scaffold.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Resolved by SCRIPT LOCATION, never cwd — same reason `run-store.mjs` does it. */
export const REPO_ROOT = resolvePath(HERE, '..', '..');

const backlogDir = (root) => join(root, 'backlog');
const idFromName = (file) => file.replace(/\.md$/, '').split('-')[0];

/**
 * Build the injected reader.
 *
 * The id set is EVERY existing card's id, including `resolved` ones. Filtering to open items would let the
 * allocator hand back an id a resolved card already owns, and two cards sharing an id is not a state anything
 * downstream can untangle.
 */
export function createScaffoldReader({
  root = REPO_ROOT,
  listFiles = (dir) => readdirSync(dir),
  today = localToday,
  allocate = allocateCardNumber,
  log = console.warn,
} = {}) {
  return () => {
    const dir = backlogDir(root);
    const existingIds = listFiles(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => idFromName(f))
      .filter(Boolean);
    const bornAs = nextHash(existingIds);
    const allocation = allocate({ id: bornAs, cwd: root, log });
    if (!allocation.ok) log(`scaffold: using hash naming: ${allocation.reason}`);
    return { existingIds, today: today(), dir, bornAs,
      ...(allocation.ok ? { allocatedId: String(allocation.num) } : {}) };
  };
}

/**
 * BUILD THE SINK MAP for `scaffold`'s one effect.
 *
 * The guarded writer REFUSES rather than warns — a bad digest is rejected with nothing written, so a refused
 * scaffold leaves no half-made card behind. That is the property worth preserving: the failure mode this
 * replaces is a file on disk that the gate rejects minutes later.
 */
export function createScaffoldSinks({ root = REPO_ROOT, write = writeBacklogMd } = {}) {
  return {
    [SCAFFOLD_EFFECT]: async (payload) => {
      // `write` is injected ONLY so a test can OBSERVE the call. It defaults to the guarded writer and a
      // caller must never substitute it in production: that writer owns the lane-not-primary refusal and the
      // #883 locus scan, and a sink that wrote around either would put a card on disk the gate then rejects.
      // #1497's lesson is the reason it is injected at all — a partially-injected shell is how a suite goes
      // green over code that genuinely wrote outside its fixture.
      write(payload.abs, payload.rel, payload.content, { root });
      return { rel: payload.rel, written: true };
    },
  };
}
