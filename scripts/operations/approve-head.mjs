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

export function rulingExistsIn(text) {
  return id => new RegExp(`(^|[^A-Za-z0-9])${id}(?![0-9])`, 'm').test(String(text));
}

export function runApproveHead(argv, { gh = runGhSync, env = process.env, readRulings = () => readFileSync(env.WE_RULINGS_FILE
  || join(homedir(), 'workspace/.operations/handoff/rulings.md'), 'utf8') } = {}) {
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
  let approver = 'unknown';
  try { approver = String(gh(['api', 'user', '--jq', '.login'], { encoding: 'utf8' })).trim() || approver; } catch { /* informational only */ }
  return writeApprovalRecord({ repo, headSha, rulingId, approver, rulingExists, gh, env });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = runApproveHead(process.argv.slice(2));
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
