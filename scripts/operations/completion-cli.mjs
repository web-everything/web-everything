#!/usr/bin/env node
/**
 * @file scripts/operations/completion-cli.mjs
 * @description THE COMPLETION CLI (#3436) — the write side a dispatched review/fix agent shells at its own
 * start and exit, and the read side that recovers "what did the one that just finished actually conclude"
 * with NO `claude logs` call and NO ANSI parsing anywhere in the read path (`we:backlog/3436-*.md`, done-when
 * #1/#2). A THIN shell over the pure/io split in {@link ./completion-record.mjs} / {@link ./completion-store.mjs}
 * — this file owns only argv parsing and stdout/stderr.
 *
 * TWO SUBCOMMANDS:
 *   `report` — write. `--status=started` mints a fresh record (idempotent: re-reporting `started` for a
 *     session that already has one is a no-op, never a throw — a retried brief must not lose its first
 *     record). `--status=done` merges onto the EXISTING record when one exists (preserving `startedAt`), or
 *     mints one directly when it does not (a brief that skipped the `started` report, or a race) — either way
 *     a `done` report always leaves a record behind.
 *   `show` — read. Resolve a session either directly (`--session=`) or by `--pr=` + `--kind=` using the SAME
 *     shared session-slug grammar, with optional `--repo=<slug|key>`. Prints JSON or `{"found":false}`.
 *
 * SCRIPT, NOT PROSE (#2607/#3296's own precedent — see `we:scripts/conveyor/stand-down.mjs`'s header). The
 * write must happen even when the agent following the brief is under stress (about to crash, about to be
 * refused an effect); asking it to also *remember* to hand-author a record is the exact write-back-onto-prose
 * hazard #3296 already named for a fixer's own stand-down marker.
 */
import { mintSessionSlug } from '../conveyor/session-slug.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyCompletionUpdate, newCompletionRecord, tryReadCompletion, withCompletionLock, writeCompletion } from './completion-store.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';

/** The SAME two grammars `dispatch-lane.mjs#sessionSlugFor` (fix) and `review-dispatch.mjs` (review) mint. */
export function sessionSlugForCompletion({ kind, pr, repo = 'we' }) {
  if (kind !== 'review' && kind !== 'fix' && kind !== 'ci-heal') throw new TypeError(`operations: completion --kind must be review, fix, or ci-heal, got ${JSON.stringify(kind)}`);
  if (pr === undefined || pr === null || String(pr).trim() === '') throw new TypeError('operations: completion --pr is required when --session is not given');
  return mintSessionSlug({ kind, id: pr, repo: repoKeyForSlug(repo) });
}

/**
 * PURE-ish (fs read only) core of `report --status=done`: reuse the existing record's `session`/`kind`/`pr`/
 * `item`/`startedAt` when one is on disk, otherwise mint a fresh one — so a `done` report never depends on a
 * `started` report having happened first.
 * @returns {object} the record to write
 */
export function planDoneReport({ existing, session, kind, pr, item, patch, now }) {
  const base = existing ?? newCompletionRecord({ session, kind, pr, item, now });
  return applyCompletionUpdate(base, { status: 'done', ...patch }, now);
}

/**
 * we:scripts/operations/completion-cli.mjs#planDoneOwnership — #4306 (epic #3383/#4075, BLOCKER fix-2821) —
 * PURE core of the `done`-report half of the ownership table (`we:backlog/4306-*.md`'s own Design section):
 *
 * | existing record            | incoming `done` report        | result                                     |
 * |-----------------------------|-------------------------------|---------------------------------------------|
 * | any, same `sessionId` (or both null) | —                     | update in place (today's behaviour)          |
 * | legacy (`sessionId` null)   | non-null id                   | update in place AND stamp the id (adopt)     |
 * | identified (non-null id)    | a DIFFERENT id, or no id      | REFUSE — a late/anonymous `done` must never overwrite the current owner |
 * | none                        | —                              | fresh `done` record owned by the reporter    |
 *
 * "Never downgrade a non-null foreign id to legacy": once `existing.sessionId` is set and does not match the
 * incoming report, this ALWAYS refuses — there is no fallback path that treats it as legacy instead.
 * @param {{existing:object|null, incomingSessionId:string|null}} o
 * @returns {{refuse:boolean, why?:string, sessionId?:string|null}}
 */
export function planDoneOwnership({ existing, incomingSessionId }) {
  const existingSessionId = existing?.sessionId ?? null;
  if (existing && existingSessionId != null && (incomingSessionId == null || incomingSessionId !== existingSessionId)) {
    return {
      refuse: true,
      why: `record for ${JSON.stringify(existing.session)} is owned by session ${existingSessionId}; refusing a done report from ${incomingSessionId == null ? 'a session with no id' : `session ${incomingSessionId}`} — a late or anonymous done must not overwrite the current owner`,
    };
  }
  // Same owner (both non-null and equal, or both null — today's behaviour unchanged), or a legacy record
  // adopting a non-null incoming id, or no existing record at all (fresh record owned by the reporter).
  return { refuse: false, sessionId: existingSessionId != null ? existingSessionId : incomingSessionId };
}

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

export function runReport(flags) {
  const kind = flags.kind;
  const pr = flags.pr ?? null;
  const item = flags.item ?? null;
  const session = flags.session || (kind && pr ? sessionSlugForCompletion({ kind, pr, repo: flags.repo }) : undefined);
  if (!session) throw new Error('usage: completion-cli.mjs report --session=<slug>|--kind=review|fix --pr=<n> --status=started|done [...]');
  if (flags.status !== 'started' && flags.status !== 'done') throw new Error('report requires --status=started|done');
  // #4306 — the reporter's OWN sessionId, when known. `--session-id=<uuid>`, filled by the CLI entry point
  // below from `CLAUDE_CODE_SESSION_ID` when the flag is absent — see this file's own header for why that env
  // read happens ONLY there, never in this function (an in-process caller, e.g. `we:scripts/operations/
  // review-job.mjs`, must keep writing legacy records even when ITS OWN process happens to have the var set).
  const incomingSessionId = Object.hasOwn(flags, 'session-id') && flags['session-id'] !== '' ? String(flags['session-id']) : null;

  // #4306 — the WHOLE existing/decide/write sequence for one session name is one critical section: two
  // concurrent `report` calls for the same name (the exact live-incident shape, two fixers on one PR) must
  // never race a read against another's write. Reused, not reinvented — the same `we:scripts/readiness/
  // file-locks.mjs` primitive `we:scripts/conveyor/fix-dispatch-claim.mjs` already keys its own synthetic
  // resource on.
  return withCompletionLock(session, () => {
    if (flags.status === 'started') {
      const existing = tryReadCompletion(session);
      // #4306 ownership table, `started` half: idempotent (no-op) ONLY for the SAME owner (same `sessionId`, or
      // both null — today's pre-#4306 rule) re-reporting `started` onto its OWN still-`started` record. Any
      // other shape — no existing record, an existing `done` record (any owner), or an existing `started`
      // record with a DIFFERENT `sessionId` (one side null and the other not counts as different) — mints a
      // FRESH record owned by THIS reporter: a new generation never inherits a foreign name's old bookkeeping.
      const sameOwner = existing?.status === 'started' && (existing.sessionId ?? null) === incomingSessionId;
      if (sameOwner) return { changed: false, record: existing };
      if (!kind) throw new Error('report --status=started requires --kind=review|fix (no existing record to infer it from)');
      const record = newCompletionRecord({
        session, kind, pr, item, sessionId: incomingSessionId,
      });
      writeCompletion(record);
      return { changed: true, record };
    }

    const existing = tryReadCompletion(session);
    const ownership = planDoneOwnership({ existing, incomingSessionId });
    if (ownership.refuse) {
      // #4306 — refused, not thrown: exit 0, print why. A late `done` from a superseded generation is an
      // EXPECTED shape (the exact incident this card fixes almost produced one), never a hard failure.
      return { changed: false, refused: true, why: ownership.why };
    }
    const patch = {};
    for (const key of ['outcome', 'verdict', 'label', 'runId', 'denied', 'cause']) {
      if (Object.hasOwn(flags, key)) patch[key] = flags[key];
    }
    patch.sessionId = ownership.sessionId;
    const record = planDoneReport({
      existing,
      session,
      kind: kind || existing?.kind,
      pr: pr ?? existing?.pr,
      item: item ?? existing?.item,
      patch,
      now: () => new Date().toISOString(),
    });
    writeCompletion(record);
    return { changed: true, record };
  });
}

export function runShow(flags) {
  const session = flags.session || (flags.kind && flags.pr ? sessionSlugForCompletion({ kind: flags.kind, pr: flags.pr, repo: flags.repo }) : undefined);
  if (!session) throw new Error('usage: completion-cli.mjs show --session=<slug>|--kind=review|fix --pr=<n>');
  const record = tryReadCompletion(session);
  return record ? { found: true, ...record } : { found: false, session };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const [sub, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  // #4306 — `CLAUDE_CODE_SESSION_ID` is read ONLY here, in the CLI entry point, never inside `runReport` (see
  // that file's own header / `report`'s own comment): an in-process caller (`we:scripts/operations/
  // review-job.mjs#report`) calls `runReport` directly and must keep writing legacy (`sessionId: null`) records
  // even when its OWN process happens to carry the variable — only a REAL `completion-cli.mjs report` process
  // (this branch) ever stamps it, and only when `--session-id` was not already given explicitly.
  if (sub === 'report' && !Object.hasOwn(flags, 'session-id') && process.env.CLAUDE_CODE_SESSION_ID) {
    flags['session-id'] = process.env.CLAUDE_CODE_SESSION_ID;
  }
  try {
    if (sub === 'report') {
      writeAllSync(1, `${JSON.stringify(runReport(flags))}\n`);
    } else if (sub === 'show') {
      writeAllSync(1, `${JSON.stringify(runShow(flags))}\n`);
    } else {
      writeLineSync(2, 'usage: completion-cli.mjs report|show [--session=<slug>] [--kind=review|fix] [--pr=<n>] ...');
      process.exitCode = 2;
    }
  } catch (e) {
    writeLineSync(2, `error: ${String(e?.message ?? e)}`);
    process.exitCode = 1;
  }
}
