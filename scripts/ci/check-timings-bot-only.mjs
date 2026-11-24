#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = 'scripts/ci/test-timings.json';
const OWNER = '.github/workflows/ci-timings-refresh.yml';

const BOT_AUTHORS = ['web-everything[bot]', 'github-actions[bot]'];
/** The PR files API stops at 3000 files; at or past that the list is not complete evidence. */
export const API_FILE_CAP = 3000;
/** The compare API returns at most 300 files; at that size the list may be truncated. */
export const COMPARE_FILE_CAP = 300;

export function checkTimingsBotOnly({ changedFiles, headRef, author, headRepo, repo }) {
  if (!Array.isArray(changedFiles) || !changedFiles.every(file => typeof file === 'string')) {
    return { ok: false, message: `Cannot verify changes to ${FILE}; rerun CI with a readable PR diff. Only ${OWNER} owns it.` };
  }
  if (changedFiles.length >= API_FILE_CAP) {
    return { ok: false, message: `Cannot verify ${FILE}: the PR lists ${API_FILE_CAP}+ files, more than the API can prove. Only ${OWNER} owns it; split the PR.` };
  }
  const isBot = headRef === 'ci/refresh-test-timings' && BOT_AUTHORS.includes(author) && headRepo !== undefined && headRepo === repo;
  if (changedFiles.includes(FILE) && !isBot) {
    return { ok: false, message: `The weekly bot owns ${FILE}; PRs never edit it. Only ${OWNER} on ci/refresh-test-timings may update it. Remove this file from the PR.` };
  }
  return { ok: true, message: 'Bot-owned test timings check passed.' };
}

function main() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return 0;
  try {
    const { REPO, PR_NUMBER, HEAD_REF, HEAD_SHA, AUTHOR, HEAD_REPO } = process.env;
    if (!/^[\w.-]+\/[\w.-]+$/.test(REPO ?? '') || !/^\d+$/.test(PR_NUMBER ?? '') || !HEAD_REF || !/^[a-f0-9]{40,64}$/i.test(HEAD_SHA ?? '')) {
      throw new Error('Missing or invalid REPO/PR_NUMBER/HEAD_REF/HEAD_SHA; rerun CI with complete PR event values');
    }
    // Bind the API answer to the revision under test: a newer push means this run is stale and must not pass.
    const liveHead = execFileSync('gh', ['api', `repos/${REPO}/pulls/${PR_NUMBER}`, '--jq', '.head.sha'], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (liveHead.toLowerCase() !== HEAD_SHA.toLowerCase()) {
      console.error(`Cannot verify ${FILE}: the PR head moved to a newer commit; rerun CI on the new head. Only ${OWNER} owns it.`);
      return 1;
    }
    // Only the PR's own edits count: diff the merge-base of the base branch and the head against the head (compare
    // API, three-dot), not the PR files list, which includes bot refreshes that landed in main after a stale base.
    const baseRef = execFileSync('gh', ['api', `repos/${REPO}/pulls/${PR_NUMBER}`, '--jq', '.base.ref'], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r?\n$/, '');
    if (!baseRef) throw new Error('Unreadable PR base ref');
    // Encode the whole ref as one URL component, preserving valid punctuation and Unicode.
    // Files are returned on the first compare page only; retain entries to count before expanding renames.
    const out = execFileSync('gh', ['api', `repos/${REPO}/compare/${encodeURIComponent(baseRef)}...${HEAD_SHA}`,
      '--jq', '.files'], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const files = JSON.parse(out);
    // A PR always changes something: empty, missing or malformed entries are not evidence.
    if (!Array.isArray(files) || files.length === 0 || !files.every(file => file &&
      typeof file.filename === 'string' && file.filename.length > 0 &&
      (file.previous_filename == null || (typeof file.previous_filename === 'string' && file.previous_filename.length > 0)))) {
      throw new Error('Unreadable compare answer');
    }
    // The compare API truncates its file list at 300: past that the list is not complete evidence.
    if (files.length >= COMPARE_FILE_CAP) {
      console.error(`Cannot verify ${FILE}: the PR changes over ${COMPARE_FILE_CAP} files, more than the compare API can prove; split the PR. Only ${OWNER} owns it.`);
      return 1;
    }
    const changedFiles = files.flatMap(file => file.previous_filename == null ? [file.filename] : [file.filename, file.previous_filename]);
    const result = checkTimingsBotOnly({ changedFiles, headRef: HEAD_REF, author: AUTHOR, headRepo: HEAD_REPO, repo: REPO });
    process[result.ok ? 'stdout' : 'stderr'].write(`${result.message}\n`);
    return result.ok ? 0 : 1;
  } catch {
    console.error(`Cannot verify ${FILE}: PR event values or merge-base diff unavailable (or over 16 MiB). Only ${OWNER} owns it; restore complete checkout history/event values and rerun CI, or ask a maintainer to inspect the full diff.`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
