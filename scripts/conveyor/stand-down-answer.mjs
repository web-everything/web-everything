#!/usr/bin/env node
/** Explicit operator ceremony only. Contract: we:scripts/conveyor/stand-down-answer.md. */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildOperatorAnswer, latestUnresolvedStandDown } from './stand-down-answer-core.mjs';

export function runStandDownAnswer(argv, { gh = (args) => execFileSync('gh', args, {
  encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
}) } = {}) {
  const [pr, ...args] = argv;
  if (!/^[1-9]\d*$/.test(pr ?? '')) throw new Error('PR must be a positive integer');
  const flags = {};
  for (const arg of args) {
    const m = arg.match(/^--(repo|reason|actor|channel|disposition)=([\s\S]*)$/);
    if (!m || Object.hasOwn(flags, m[1])) throw new Error(`unknown or duplicate argument: ${arg}`);
    flags[m[1]] = m[2];
  }
  for (const key of ['repo', 'reason', 'actor', 'channel']) {
    if (!flags[key]?.trim()) throw new Error(`--${key} is required and must be non-empty`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(flags.repo)) throw new Error('--repo must be owner/name');
  // Validate the ceremony before any IO. --reason is deliberately never trimmed or paraphrased.
  buildOperatorAnswer({ standDownId: 'validation', ...flags });
  let snapshot;
  try {
    snapshot = JSON.parse(gh(['pr', 'view', pr, `--repo=${flags.repo}`, '--json', 'comments']));
  } catch (error) {
    throw new Error(`Could not read comments for ${flags.repo} PR #${pr}: ${String(error.message || error).split(/[\r\n]/)[0]}`);
  }
  const target = latestUnresolvedStandDown(snapshot.comments);
  if (!target) throw new Error('no unresolved stand-down on this PR');
  if (!target.id) throw new Error('unresolved stand-down has no durable comment id');
  const body = buildOperatorAnswer({ standDownId: String(target.id), ...flags });
  if (body.length > 65536) throw new Error('operator answer exceeds GitHub comment limit');
  // ONE durable write; no label swap, deletion, or automatic retry after an ambiguous write failure.
  return gh(['pr', 'comment', pr, `--repo=${flags.repo}`, '--body', body]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(String(runStandDownAnswer(process.argv.slice(2)) ?? '')); }
  catch (error) { process.stderr.write(`stand-down-answer: ${error.message}\n`); process.exitCode = 1; }
}
