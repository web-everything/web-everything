#!/usr/bin/env node
/**
 * Card 106 — install command for the scheduled sweeps. DEFAULT OFF: with no flag it only prints the plan.
 *   --apply  writes the three plists into ~/Library/LaunchAgents (never overwrites an existing file).
 * It NEVER runs launchctl; it prints the `launchctl bootstrap` lines for the operator to run (or not).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPlan } from './scheduled-sweep.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const apply = process.argv.includes('--apply');
const home = homedir();
const plan = installPlan({ repoRoot, nodePath: process.execPath, home, apply });
for (const f of plan.writes) {
  if (existsSync(f.path)) { console.log(`skip (exists): ${f.path}`); continue; }
  mkdirSync(dirname(f.path), { recursive: true });
  mkdirSync(`${home}/workspace/.operations/logs`, { recursive: true });
  writeFileSync(f.path, f.xml);
  console.log(`wrote ${f.path}`);
}
if (!apply) console.log('DRY PLAN (default off). Re-run with --apply to write these plists:\n' + plan.files.map((f) => `  ${f.path}`).join('\n'));
console.log('Then load them yourself, one at a time:\n' + plan.commands.map((c) => `  ${c}`).join('\n'));
