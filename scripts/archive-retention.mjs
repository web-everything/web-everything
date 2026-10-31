#!/usr/bin/env node
import { archiveRetention } from './lib/archive-retention.mjs';
const args = process.argv.slice(2);
if (args.some(a => a !== '--dry-run' && !/^--kind=(runs|sessions)$/.test(a))) {
  console.error('Usage: node scripts/archive-retention.mjs [--dry-run] [--kind=runs|sessions]');
  process.exitCode = 2;
} else {
  const kinds = args.find(a => a.startsWith('--kind='))?.slice(7);
  for (const kind of kinds ? [kinds] : ['runs', 'sessions']) {
    const result = await archiveRetention({ kind, dryRun: args.includes('--dry-run'), log: console.error });
    console.log(JSON.stringify(result));
    if (result.errors.length) process.exitCode = 1;
  }
}
