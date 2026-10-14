#!/usr/bin/env node
/** Preview obsolete merge_group run cancellations; --apply sends cancellation requests. */
import { cancelObsoleteQueueRuns } from './lib/merge-queue-obsolete-runs.mjs';

const args = process.argv.slice(2);
const unknown = args.filter(arg => arg !== '--apply' && arg !== '--json' && !arg.startsWith('--repo='));
const repo = args.find(arg => arg.startsWith('--repo='))?.slice('--repo='.length) ?? 'web-everything/web-everything';
if (unknown.length || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
  process.stderr.write('Usage: node scripts/merge-queue-cancel-obsolete.mjs [--apply] [--repo=owner/repo] [--json]\n');
  process.exitCode = 1;
} else {
  const json = args.includes('--json');
  const result = cancelObsoleteQueueRuns({ repo, dryRun: !args.includes('--apply'), log: json ? process.stderr : process.stdout });
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.error || result.failed?.length) process.exitCode = 1;
}
