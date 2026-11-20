#!/usr/bin/env node
// Resolves the matrix `fail-fast` flag for a CI event from scripts/settings/ci-fail-fast.json (R1109).
// merge_group reads ci.failFast.mergeQueue, pull_request reads ci.failFast.pullRequest; every other event,
// and any unreadable or non-boolean setting, resolves to false (today's behaviour: no fail-fast).
// CLI: node scripts/ci/fail-fast.mjs --event=<name>  -> prints `fail_fast=true|false` (for $GITHUB_OUTPUT).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const KEYS = { merge_group: 'mergeQueue', pull_request: 'pullRequest' };

export function resolveFailFast(event, settingText) {
  const key = KEYS[event];
  if (!key) return false;
  try {
    return JSON.parse(settingText)?.ci?.failFast?.[key] === true;
  } catch {
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = (process.argv.find((a) => a.startsWith('--event=')) ?? '').slice(8);
  let text;
  try {
    text = readFileSync(new URL('../settings/ci-fail-fast.json', import.meta.url), 'utf8');
  } catch {
    text = undefined;
  }
  console.log(`fail_fast=${resolveFailFast(event, text)}`);
}
