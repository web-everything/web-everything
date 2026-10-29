import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy } from './policy-cascade.mjs';
import { parseLatestHumanClearedSha, scoreEscalation } from './review-escalation.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { proveNumberingOnlyMove } from './numbering-carry.mjs';
import { GATE_PATH_PREFIXES, normalizeGatePath } from './merge-queue-enqueue.mjs';

/** R212: environment → feature settings → default true; invalid layers fall through. */
export function resolveApprovalLicensesEnqueue({ env = process.env, readFile = readFileSync } = {}) {
  const raw = String(env?.WE_MERGE_QUEUE_HUMAN_ONLY_APPROVAL_LICENSES_ENQUEUE).toLowerCase();
  const parsed = ['true', 'on', '1'].includes(raw) ? true : ['false', 'off', '0'].includes(raw) ? false : undefined;
  let tool;
  try {
    tool = JSON.parse(readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'human-only-enqueue.json'), 'utf8'))?.mergeQueue?.humanOnly?.approvalLicensesEnqueue;
  } catch { /* use the standard default */ }
  // R212 specifies this three-layer cascade; use the shared resolver for validation and source logging.
  const resolved = cascadePolicy('mergeQueue.humanOnly.approvalLicensesEnqueue', tool, {
    standard: true, platform: null, envValues: { '': parsed }, valid: value => typeof value === 'boolean', env,
  });
  const source = resolved.sources[''];
  return { value: resolved.value, source: source === 'tool' ? 'settings' : source === 'standard' ? 'default' : source };
}

const SHA = /^[0-9a-f]{40}$/;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PATHS = 1024;
const refuse = reason => ({ licensed: false, reason: `${reason}; operator must re-approve the current head or queue it` });

/** Recorded operator clearance licenses only an exact head or a proven mechanical successor. Never throws. */
export function proveHumanOnlyLicense({ repo, pr, headSha, exec, cwd, readComments = readCompletePrComments } = {}) {
  try {
    if (!SHA.test(headSha ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !Number.isSafeInteger(Number(pr)) || Number(pr) < 1) return refuse('invalid approval target');
    const view = JSON.parse(exec('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,labels'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: MAX_BYTES,
    }));
    if (view?.headRefOid !== headSha || !Array.isArray(view.labels)) return refuse('live approval head or labels unreadable or moved');
    if (!view.labels.some(label => (label?.name ?? label) === 'review:accepted')) return refuse('review:accepted approval missing');
    const comments = readComments(pr, { repo, exec });
    if (!Array.isArray(comments)) return refuse('operator approval comments unreadable');
    const approved = parseLatestHumanClearedSha(comments);
    if (!SHA.test(approved ?? '')) return refuse('trusted operator clear-human approval missing');
    if (approved === headSha) return { licensed: true, tier: 'exact', reason: 'operator approved the exact current head' };
    if (!cwd) return refuse('no checkout for successor proof');
    let gitReadFailed = false;
    const boundedExec = (cmd, args, options) => {
      try {
        // The shared numbering reader can fetch missing objects; this admission proof is read-only.
        if (cmd !== 'git' || args[0] === 'fetch') throw Error('local git evidence required');
        const output = exec(cmd, args, { ...options, cwd, timeout: 5000, maxBuffer: Math.min(options?.maxBuffer ?? MAX_BYTES, MAX_BYTES) });
        if (!(typeof output === 'string' || Buffer.isBuffer(output)) || Buffer.byteLength(output) > Math.min(options?.maxBuffer ?? MAX_BYTES, MAX_BYTES)) throw Error('git evidence unreadable or oversized');
        return output;
      } catch (error) {
        // `git grep` exit 1 proves no optional numbering aliases; every other read failure blocks fallback.
        if (!(args[0] === 'grep' && error?.status === 1)) gitReadFailed = true;
        throw error;
      }
    };
    const git = args => {
      const output = boundedExec('git', args, { encoding: null, stdio: ['ignore', 'pipe', 'pipe'] });
      if (!Buffer.isBuffer(output)) throw Error('raw git evidence required');
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output);
    };
    git(['cat-file', '-e', `${approved}^{commit}`]);
    git(['cat-file', '-e', `${headSha}^{commit}`]);
    git(['merge-base', '--is-ancestor', approved, headSha]);
    const numbering = proveNumberingOnlyMove({ exec: boundedExec, fromSha: approved, toSha: headSha, cwd });
    if (gitReadFailed) return refuse('numbering git evidence unreadable');
    if (numbering.ok) {
      return { licensed: true, tier: 'numbering', reason: 'shared proof confirms a numbering-only successor' };
    }
    const main = git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']).trim();
    if (!SHA.test(main)) return refuse('main evidence unreadable');
    const parents = git(['rev-list', '--parents', '-n', '1', headSha]).trim().split(' ');
    if (parents.length !== 3 || parents[0] !== headSha || !parents.slice(1).every(sha => SHA.test(sha))) {
      return refuse('successor is not a proven main merge');
    }
    git(['merge-base', '--is-ancestor', parents[2], main]);
    // Tree modes must remain visible regardless of local submodule-ignore or diff-driver settings.
    const diff = git(['-c', 'diff.ignoreSubmodules=none', 'diff-tree', '-r', '-z', '--raw', '--no-abbrev',
      '--no-renames', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv', approved, headSha]);
    if (diff && !diff.endsWith('\0')) return refuse('successor diff incomplete');
    const records = diff ? diff.slice(0, -1).split('\0') : [];
    if (records.length % 2 !== 0) return refuse('successor diff incomplete');
    if (records.length / 2 > MAX_PATHS) return refuse('successor diff exceeds 1024-path proof limit');
    const paths = [];
    for (let i = 0; i < records.length; i += 2) {
      const entry = /^:(000000|100644|100755|120000|160000) (000000|100644|100755|120000|160000) [0-9a-f]{40} [0-9a-f]{40} [ADMT]$/.exec(records[i]);
      if (!entry) return refuse('successor tree evidence unreadable');
      if (entry[1] === '160000' || entry[2] === '160000') return refuse('successor changes a gitlink');
      paths.push(records[i + 1]);
    }
    const blob = (ref, path) => {
      const tree = git(['--literal-pathspecs', 'ls-tree', '-z', ref, '--', path]);
      if (tree === '') return null; // proven absent, including a deletion inherited from main
      const tab = tree.indexOf('\t');
      if (!/^100(?:644|755) blob [0-9a-f]{40}$/.test(tree.slice(0, tab)) || tree.slice(tab + 1) !== `${path}\0`) throw Error('regular blob evidence unreadable');
      const [mode, , id] = tree.slice(0, tab).split(' ');
      return `${mode} ${id}`;
    };
    for (const path of paths) {
      if (!path || normalizeGatePath(path).split('/').includes('..')) return refuse('successor path unreadable');
      const sensitive = GATE_PATH_PREFIXES.some(prefix => normalizeGatePath(path).startsWith(prefix))
        || scoreEscalation({ changedFiles: [path] }).humanRequired === true;
      if (sensitive && blob(headSha, path) !== blob(main, path)) return refuse('successor changes an unapproved human-only path');
    }
    return { licensed: true, tier: 'mechanical', reason: 'approved ancestor retained; sensitive successor blobs match main' };
  } catch {
    return refuse('approval or git evidence unreadable or oversized');
  }
}
