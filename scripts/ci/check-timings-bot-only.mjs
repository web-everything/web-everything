#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = 'scripts/ci/test-timings.json';
const OWNER = '.github/workflows/ci-timings-refresh.yml';

export function checkTimingsBotOnly({ changedFiles, headRef, author }) {
  if (!Array.isArray(changedFiles) || !changedFiles.every(file => typeof file === 'string')) {
    return { ok: false, message: `Cannot verify changes to ${FILE}; rerun CI with a readable PR diff. Only ${OWNER} owns it.` };
  }
  if (changedFiles.includes(FILE) && headRef !== 'ci/refresh-test-timings') {
    return { ok: false, message: `The weekly bot owns ${FILE}; PRs never edit it. Only ${OWNER} on ci/refresh-test-timings may update it. Remove this file from the PR.` };
  }
  return { ok: true, message: 'Bot-owned test timings check passed.' };
}

function main() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return 0;
  try {
    const { REPO, PR_NUMBER, HEAD_REF } = process.env;
    if (!/^[\w.-]+\/[\w.-]+$/.test(REPO ?? '') || !/^\d+$/.test(PR_NUMBER ?? '') || !HEAD_REF) {
      throw new Error('Missing or invalid REPO/PR_NUMBER/HEAD_REF; rerun CI with complete PR event values');
    }
    // The PR files API lists every changed file (renames carry previous_filename); NUL separation keeps names literal.
    const out = execFileSync('gh', ['api', `repos/${REPO}/pulls/${PR_NUMBER}/files`, '--paginate',
      '--jq', '.[] | (.filename, (.previous_filename // empty)) + "\\u0000"'], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = checkTimingsBotOnly({ changedFiles: out.split('\0').map(s => s.replace(/^\n/, '')).filter(Boolean), headRef: HEAD_REF });
    process[result.ok ? 'stdout' : 'stderr'].write(`${result.message}\n`);
    return result.ok ? 0 : 1;
  } catch {
    console.error(`Cannot verify ${FILE}: PR event values or merge-base diff unavailable (or over 16 MiB). Only ${OWNER} owns it; restore complete checkout history/event values and rerun CI, or ask a maintainer to inspect the full diff.`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
