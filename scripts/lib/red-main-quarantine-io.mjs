#!/usr/bin/env node
/**
 * @file scripts/lib/red-main-quarantine-io.mjs
 * @description IO + CLI for the red-main quarantine list on the `ops/quarantine` branch (pure rules:
 *   we:scripts/lib/red-main-quarantine.mjs). Reuses the #4451 push-ref guarded transport
 *   (we:scripts/lib/git-transport-branch.mjs): the ONLY ref this module may push is `refs/heads/ops/quarantine`,
 *   never forced, and only for the writers in QUARANTINE_WRITERS. Each change writes the list and appends its
 *   `quarantine-added` / `quarantine-removed` events to `events.jsonl` in the SAME commit (audit trail).
 *
 * CLI (repo root as cwd):
 *   node scripts/lib/red-main-quarantine-io.mjs skip [--pr=<n>] [--fix-prs=<n,..>] [--on-main] [--format=json|vitest]
 *       CI job start: fetch the CURRENT list and print the tests to skip. Unreadable list ⇒ prints nothing to
 *       skip (CI runs everything — the safe direction). The main-fix PR / main always skip nothing.
 *   node scripts/lib/red-main-quarantine-io.mjs add --actor=<red-main-safety-net|operator> --broken-sha=<sha>
 *       --owner=<who> --reason=<why> --tests=<id,id> [--area=<dir/>] [--ttl-min=<n>]
 *   node scripts/lib/red-main-quarantine-io.mjs prune --actor=<..> --main-green=<true|false|unknown>
 *   node scripts/lib/red-main-quarantine-io.mjs show
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFromTransportBranch, stageOnTransportBranch, assertPushRef } from './git-transport-branch.mjs';
import {
  QUARANTINE_BRANCH, QUARANTINE_REF, QUARANTINE_LIST_PATH, QUARANTINE_EVENTS_PATH,
  validateQuarantineList, addEntries, pruneOnGreen, testsToSkip, canWriteQuarantine,
} from './red-main-quarantine.mjs';

const git = (args, opts) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

/**
 * Read the current list. `{ok:true, list}` (an absent branch/file = an empty list is NOT assumed: absent file on a
 * read tip ⇒ empty; unreachable branch ⇒ ok:false).
 */
export function readQuarantine({ board = process.cwd(), run = git } = {}) {
  try {
    const got = readFromTransportBranch({ board, branch: QUARANTINE_BRANCH, paths: [QUARANTINE_LIST_PATH], run });
    const text = got[QUARANTINE_LIST_PATH];
    if (text == null) return { ok: true, list: { version: 1, entries: [] } };
    const list = JSON.parse(text);
    const v = validateQuarantineList(list);
    return v.ok ? { ok: true, list } : { ok: false, error: v.errors.join('; ') };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).split('\n')[0] };
  }
}

/** Apply one change (computed against the freshly fetched tip inside the transport) and push it. */
export function writeQuarantineChange({ board = process.cwd(), actor, change, message, run = git, ...seams }) {
  if (!canWriteQuarantine(actor)) throw new Error(`red-main-quarantine: writer "${actor}" refused`);
  assertPushRef(QUARANTINE_BRANCH, QUARANTINE_REF); // the ONE ref; nothing else is ever pushed
  let events = [];
  let refused = null;
  const listFile = {
    path: QUARANTINE_LIST_PATH,
    content: ({ existing }) => {
      const cur = existing ? JSON.parse(existing) : { version: 1, entries: [] };
      const r = change(cur);
      if (!r.ok && r.ok !== undefined) { refused = r.error; return existing ?? JSON.stringify(cur, null, 2) + '\n'; }
      events = r.events;
      return JSON.stringify(r.list, null, 2) + '\n';
    },
  };
  const eventsFile = {
    path: QUARANTINE_EVENTS_PATH,
    content: ({ existing }) => (existing ?? '') + events.map((e) => JSON.stringify(e) + '\n').join(''),
  };
  let createIfAbsent = false;
  try { git(['ls-remote', '--exit-code', 'origin', QUARANTINE_REF], { cwd: board }); } catch { createIfAbsent = true; }
  const out = stageOnTransportBranch({ board, branch: QUARANTINE_BRANCH, files: [listFile, eventsFile], message, run, allowRef: QUARANTINE_REF, createIfAbsent, ...seams });
  if (refused) throw new Error(`red-main-quarantine: change refused: ${refused}`);
  return { ...out, events };
}

function flagsOf(argv) {
  const f = {};
  for (const a of argv) { if (!a.startsWith('--')) continue; const i = a.indexOf('='); if (i < 0) f[a.slice(2)] = true; else f[a.slice(2, i)] = a.slice(i + 1); }
  return f;
}

function cli(argv) {
  const cmd = argv[0];
  const f = flagsOf(argv.slice(1));
  const now = Date.now();
  if (cmd === 'skip') {
    const r = readQuarantine();
    const fixPrs = String(f['fix-prs'] ?? '').split(',').filter(Boolean).map(Number);
    const tests = r.ok ? testsToSkip({ list: r.list, now, prNumber: f.pr ?? null, fixPrs, onMain: !!f['on-main'] }) : [];
    if (f.format === 'vitest') process.stdout.write(tests.map((t) => `--exclude=${t.split('::')[0]}`).join(' ') + '\n');
    else process.stdout.write(JSON.stringify({ ok: r.ok, ...(r.ok ? {} : { error: r.error }), skip: tests }) + '\n');
    return;
  }
  if (cmd === 'show') { process.stdout.write(JSON.stringify(readQuarantine(), null, 2) + '\n'); return; }
  if (cmd === 'add') {
    const tests = String(f.tests ?? '').split(',').filter(Boolean);
    const ttlMs = f['ttl-min'] ? Number(f['ttl-min']) * 60_000 : undefined;
    const out = writeQuarantineChange({
      actor: f.actor, message: `quarantine: add ${tests.join(', ')} (broken ${String(f['broken-sha']).slice(0, 9)}, by ${f.actor})`,
      change: (cur) => addEntries(cur, { tests, brokenSha: f['broken-sha'], owner: f.owner, reason: f.reason, actor: f.actor, now, ...(ttlMs ? { ttlMs } : {}), area: f.area ?? null }),
    });
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }
  if (cmd === 'prune') {
    const mg = f['main-green'] === 'true' ? true : f['main-green'] === 'false' ? false : null;
    const out = writeQuarantineChange({ actor: f.actor, message: `quarantine: prune (main green: ${mg})`, change: (cur) => pruneOnGreen(cur, { mainGreen: mg, now, actor: f.actor }) });
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }
  process.stderr.write('usage: red-main-quarantine-io.mjs <skip|show|add|prune> [--flags]\n');
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { cli(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
