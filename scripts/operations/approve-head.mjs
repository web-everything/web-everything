#!/usr/bin/env node
/**
 * approve-head: write the operator approval record for a PR's CURRENT head (AUTH-BOUND-APPROVAL).
 * Usage: node scripts/operations/approve-head.mjs --repo=<owner/name> --pr=<n> --ruling=R123[+R124] [--head=<40-hex>]
 * The ruling id is verified against the rulings file (WE_RULINGS_FILE, default the handoff rulings.md) BEFORE
 * anything is written. The record is a check run authored by the WE App only (no personal fallback) and is bound
 * to the head sha, so any later push voids it. See scripts/lib/approval-record.mjs.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { writeApprovalRecord, validRulingId } from '../lib/approval-record.mjs';

const flag = (argv, name) => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** A ruling exists only when a line DECLARES it: the id opens the line (after list/bold markers) and ends exactly
 *  there (no trailing letters or digits). A passing mention, or `R474X` for `R474`, never matches. */
export function rulingExistsIn(text) {
  return id => validRulingId(id) && new RegExp(`^[ \\t>*_-]*R${id.slice(1)}(?![A-Za-z0-9])`, 'm').test(String(text));
}

// The rulings source is fixed: no environment override can replace the approval authority (tests inject `readRulings`).
const RULINGS_PATH = join(homedir(), 'workspace/.operations/handoff/rulings.md');
export function runApproveHead(argv, { gh = runGhSync, env = process.env, readRulings = () => readFileSync(RULINGS_PATH, 'utf8') } = {}) {
  const repo = flag(argv, 'repo'), pr = flag(argv, 'pr'), rulingId = flag(argv, 'ruling');
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, reason: '--repo=<owner/name> required' };
  if (!validRulingId(rulingId)) return { ok: false, reason: '--ruling=R<id> required' };
  let headSha = flag(argv, 'head');
  try {
    if (!headSha) {
      if (!/^[1-9]\d*$/.test(String(pr ?? ''))) return { ok: false, reason: '--pr=<n> or --head=<sha> required' };
      headSha = String(gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha'], { encoding: 'utf8' })).trim();
    }
  } catch (error) { return { ok: false, reason: `head unreadable: ${String(error?.message ?? error).split('\n')[0]}` }; }
  let rulingExists;
  try { rulingExists = rulingExistsIn(readRulings()); } catch { return { ok: false, reason: 'rulings file unreadable; nothing written' }; }
  // The operator's own login (personal auth); a missing identity refuses the approval (fail closed).
  let approver = '';
  try { approver = String(gh(['api', 'user', '--jq', '.login'], { encoding: 'utf8' })).trim(); } catch { return { ok: false, reason: 'operator identity unreadable; nothing written' }; }
  if (!approver) return { ok: false, reason: 'operator identity empty; nothing written' };
  return writeApprovalRecord({ repo, headSha, rulingId, approver, rulingExists, gh, env });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = runApproveHead(process.argv.slice(2));
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
