/**
 * @file Mechanical data-refresh certification (R861). Comments are receipts, never authority.
 * Incomplete evidence retains normal review; operators can inspect the full PR and clear it there.
 */
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { createMqLiveReader } from './drain-queue-safety.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { hasLabel } from './ai-pr-authorship.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

export const REQUIRED_MECHANICAL_CHECKS = Object.freeze(['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate']);
export const GITHUB_ACTIONS_APP_ID = 15368;
const RULES = ['author', 'commit-identity', 'diff-scope', 'diff-shape', 'schema', 'keys', 'checks'];
const IDENTITIES = new Set(['web-everything[bot]', 'github-actions[bot]']);
const TIMINGS_PATH = 'scripts/ci/test-timings.json';
const MAX_BYTES = 4 * 1024 * 1024;
const OPTIONS = { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 };
const plain = v => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const regular = v => v?.type === 'blob' && v.mode === '100644';
const testPath = path => typeof path === 'string' && !path.startsWith('/') && !/[\\\0]/.test(path)
  && !path.split('/').some(part => part === '..' || part === '.' || part === '')
  && /\.(?:test|spec)\.(?:ts|mjs|js|tsx)$/.test(path);

/** Pure, ordered policy. Read failures override all apparent positive evidence. */
export function validateMechanicalClearance(facts = {}) {
  const head = typeof facts.head === 'string' ? facts.head : '';
  const fail = (rule, reason) => ({ cleared: false, rule, reasons: [reason], head });
  if (facts.readError || !head || !Array.isArray(facts.commits) || !Number.isInteger(facts.commitCount)
    || facts.commitCount < 1 || facts.commits.length !== facts.commitCount
    || !Array.isArray(facts.files) || facts.files.length >= 300
    || typeof facts.content !== 'string' || Buffer.byteLength(facts.content) > MAX_BYTES
    || typeof facts.baseContent !== 'string' || Buffer.byteLength(facts.baseContent) > MAX_BYTES
    || !Array.isArray(facts.existingFiles) || !Array.isArray(facts.checks)) {
    return fail('read-error', 'Incomplete or unreadable evidence; use normal review of the full PR.');
  }
  let baseData;
  try { baseData = JSON.parse(facts.baseContent); } catch { return fail('read-error', 'Unreadable base timing JSON; use normal review of the full PR.'); }
  if (!plain(baseData)) return fail('read-error', 'Unreadable base timing schema; use normal review of the full PR.');
  if (facts.author?.login !== 'web-everything[bot]' || facts.author?.type !== 'Bot') return fail('author', 'PR author is not the repository App bot.');
  if (!facts.commits.every(c => IDENTITIES.has(c?.author?.login) && IDENTITIES.has(c?.committer?.login))) return fail('commit-identity', 'Every commit must have linked workflow author and committer identities.');
  if (facts.files.length !== 1 || facts.files[0]?.filename !== TIMINGS_PATH) return fail('diff-scope', 'Net diff must touch only test-timings.json.');
  if (facts.files[0].status !== 'modified' || Object.hasOwn(facts.files[0], 'previous_filename')
    || !regular(facts.baseEntry) || !regular(facts.headEntry)) return fail('diff-shape', 'Only a modified regular non-executable blob is allowed at both endpoints.');
  let data;
  try { data = JSON.parse(facts.content); } catch { return fail('schema', 'Timing content is not JSON.'); }
  if (!plain(data) || Object.keys(data).some(k => !['_doc', 'unit', 'soak'].includes(k))
    || (Object.hasOwn(data, '_doc') && typeof data._doc !== 'string')) return fail('schema', 'Unexpected top-level timing schema.');
  const keys = [];
  for (const group of ['unit', 'soak']) {
    if (!Object.hasOwn(data, group) || !plain(data[group]) || !Object.keys(data[group]).length) return fail('schema', `Timing group ${group} must be a non-empty plain object.`);
    const headKeys = Object.keys(data[group]);
    const baseKeys = plain(baseData[group]) ? Object.keys(baseData[group]) : [];
    if (headKeys.length < Math.ceil(0.9 * baseKeys.length)) return fail('schema', `Timing group ${group} retains ${headKeys.length}/${baseKeys.length} keys, below 90%; use normal review of the full PR.`);
    for (const [key, value] of Object.entries(data[group])) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 3600) return fail('schema', 'Durations must be finite seconds between 0 and 3600.');
      keys.push(key);
    }
  }
  if (keys.length > 20000) return fail('schema', 'Timing key bound exceeded; use normal review of the full PR.');
  const existing = new Set(facts.existingFiles);
  if (!keys.every(key => testPath(key) && existing.has(key))) return fail('keys', 'Every timing key must identify an existing regular test file at the head.');
  // Do not require mergeStateStatus: it is BLOCKED before ready-to-merge exists here,
  // which would deadlock label minting. The drain's classifyPr requires CLEAN/UNSTABLE at merge time.
  const rollup = facts.rollup;
  if (rollup?.state !== 'SUCCESS' || typeof rollup.commitOid !== 'string' || typeof rollup.headOid !== 'string'
    || rollup.commitOid.toLowerCase() !== head.toLowerCase() || rollup.headOid.toLowerCase() !== head.toLowerCase()) {
    return fail('checks', 'GitHub roll-up must succeed for the exact head; use normal review.');
  }
  if (!REQUIRED_MECHANICAL_CHECKS.every(name => facts.checks.some(check => check?.name === name
    && check.appId === GITHUB_ACTIONS_APP_ID && check.status === 'completed'
    && typeof check.conclusion === 'string' && check.conclusion.toUpperCase() === 'SUCCESS'))) {
    return fail('checks', 'Required head checks must all have a successful completed GitHub Actions run.');
  }
  return { cleared: true, rule: null, reasons: [], head };
}

/** All reads are live, bounded and pinned; no PR title, body, or branch-name heuristic. */
export function readMechanicalClearanceFacts({ repo, num, exec = execFileSyncThrottled, cwd,
  listFiles } = {}) {
  const facts = {};
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9]\d*$/.test(String(num))) throw Error('invalid repository or PR');
    const live = createMqLiveReader(exec);
    let calls = 0;
    const request = args => {
      if (++calls > 128) throw Error('read budget exceeded');
      return JSON.parse(live('gh', ['api', ...args], { ...OPTIONS, cwd }));
    };
    const api = path => request([`repos/${repo}/${path}`]);
    const pr = api(`pulls/${num}`);
    facts.head = pr?.head?.sha;
    if (!/^[a-f0-9]{40}$/i.test(facts.head) || !/^[a-f0-9]{40}$/i.test(pr?.base?.sha) || pr.base.ref !== 'main') throw Error('unreadable head or main base');
    facts.author = pr.user;
    facts.commitCount = pr.commits;
    const pages = (path, field, totalField) => {
      const rows = [];
      let expected;
      for (let page = 1; page <= 20; page++) {
        const data = api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        const batch = field ? data?.[field] : data;
        if (!Array.isArray(batch) || batch.length > 100) throw Error('unreadable page');
        if (totalField) {
          if (!Number.isInteger(data[totalField]) || data[totalField] < 0 || (expected != null && expected !== data[totalField])) throw Error('unreadable count');
          expected = data[totalField];
        }
        rows.push(...batch);
        if (batch.length < 100) {
          if (expected != null && rows.length !== expected) throw Error('incomplete listing');
          return rows;
        }
      }
      throw Error('page bound exceeded; inspect full PR through normal review');
    };
    facts.commits = pages(`pulls/${num}/commits`);
    if (facts.commits.length !== facts.commitCount) throw Error('incomplete commits');
    const compare = api(`compare/${pr.base.sha}...${facts.head}?per_page=100&page=1`);
    if (!Array.isArray(compare.files) || compare.files.length >= 300) throw Error('incomplete compare files');
    facts.files = compare.files;
    const tree = sha => {
      const data = api(`git/trees/${sha}`);
      if (data.truncated !== false || !Array.isArray(data.tree)) throw Error('incomplete tree');
      return data.tree;
    };
    const entryAt = sha => {
      let entry;
      const parts = TIMINGS_PATH.split('/');
      for (const [i, part] of parts.entries()) {
        entry = tree(sha).find(item => item.path === part);
        if (!entry) throw Error('missing tree entry');
        if (i < parts.length - 1 && entry.type !== 'tree') throw Error('unreadable parent tree');
        sha = entry.sha;
      }
      return entry;
    };
    facts.baseEntry = entryAt(pr.base.sha);
    facts.headEntry = entryAt(facts.head);
    // A non-blob has no readable blob content; retain shape evidence for the policy refusal.
    const readBlob = entry => {
      if (entry.type !== 'blob') return '{}';
      const blob = api(`git/blobs/${entry.sha}`);
      if (!Number.isInteger(blob.size) || blob.size > MAX_BYTES || blob.size < 0 || blob.encoding !== 'base64'
        || typeof blob.content !== 'string' || !/^[A-Za-z0-9+/=\r\n]*$/.test(blob.content)) throw Error('unreadable or oversized blob');
      const bytes = Buffer.from(blob.content, 'base64');
      if (bytes.length !== blob.size) throw Error('incomplete blob');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    };
    facts.baseContent = readBlob(facts.baseEntry);
    facts.content = readBlob(facts.headEntry);
    if (listFiles) facts.existingFiles = listFiles(facts.head);
    else {
      live('git', ['fetch', '--no-tags', '--no-write-fetch-head', `https://github.com/${repo}.git`, facts.head], { ...OPTIONS, cwd });
      // NUL framing preserves literal paths; modes prove keys are regular files, not symlinks.
      const output = live('git', ['ls-tree', '-r', '-z', facts.head], { ...OPTIONS, cwd });
      if (typeof output !== 'string' || (output && !output.endsWith('\0'))) throw Error('incomplete head file listing');
      facts.existingFiles = output.split('\0').filter(Boolean).map(row => {
        const match = row.match(/^(\d{6}) (blob|commit) [a-f0-9]{40}\t([\s\S]+)$/);
        if (!match) throw Error('unreadable head file entry');
        return ['100644', '100755'].includes(match[1]) && match[2] === 'blob' ? match[3] : null;
      }).filter(path => path !== null);
    }
    const [owner, name] = repo.split('/');
    const query = `query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){pullRequest(number:$num){headRefOid commits(last:1){nodes{commit{oid statusCheckRollup{state}}}}}}}`;
    const result = request(['graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `num=${num}`]);
    const pullRequest = result?.data?.repository?.pullRequest;
    const commit = pullRequest?.commits?.nodes?.[0]?.commit;
    facts.rollup = { headOid: pullRequest?.headRefOid, commitOid: commit?.oid, state: commit?.statusCheckRollup?.state };
    if (result.errors || !/^[a-f0-9]{40}$/i.test(facts.rollup.headOid) || !/^[a-f0-9]{40}$/i.test(facts.rollup.commitOid)
      || typeof facts.rollup.state !== 'string' || !facts.rollup.state) throw Error('unreadable roll-up');
    facts.checks = pages(`commits/${facts.head}/check-runs?filter=all`, 'check_runs', 'total_count')
      .map(check => ({ ...check, appId: check.app?.id ?? null }));
    if (api(`pulls/${num}`)?.head?.sha !== facts.head) throw Error('head moved');
  } catch {
    facts.readError = true;
  }
  return facts;
}

export function decideMechanicalClearance(options) {
  return validateMechanicalClearance(readMechanicalClearanceFacts(options));
}

/** R861: bot/unknown label-only authors need live evidence matching every known merge pin. */
export function decideMechanicalMergeGuard(v, result) {
  if (v.decision !== 'merge' || !v.labelOnlyCertified
    || (v.authorLogin && !['web-everything[bot]', 'app/web-everything'].includes(v.authorLogin))) return v;
  const pins = [v.listedHeadSha, v.headSha].filter(sha => sha != null && sha !== '');
  const rule = !result || result.rule === 'read-error' ? 'read-error'
    : result.cleared !== true ? result.rule || 'read-error'
    : !pins.length || typeof result.head !== 'string' || !result.head
      || pins.some(sha => typeof sha !== 'string' || sha.toLowerCase() !== result.head.toLowerCase()) ? 'head' : null;
  return rule ? { ...v, decision: 'skip',
    reason: `mechanical-clearance refused (${rule}); normal review of the full PR required` } : v;
}

/** Bot/unknown PRs depend on mechanical clearance, regardless of accepted review or AI trailers. */
export function decideMechanicalLabelStrip(pr, result) {
  const eligible = !['CLOSED', 'MERGED'].includes(String(pr?.state ?? '').toUpperCase())
    && (!pr?.author?.login || ['web-everything[bot]', 'app/web-everything'].includes(pr.author.login))
    && hasLabel(pr, 'ready-to-merge');
  const current = result?.cleared === true && typeof result.head === 'string' && result.head.length > 0
    && typeof pr?.headRefOid === 'string' && result.head.toLowerCase() === pr.headRefOid.toLowerCase();
  return { strip: eligible && !current, rule: result?.rule ?? (current ? null : 'head') };
}

/** Idempotent per head. Existing receipts only suppress duplicate recording, never certify a PR. */
export function recordMechanicalClearance({ repo, num, result, exec = execFileSyncThrottled,
  readComments = () => readCompletePrComments(num, { repo, exec: createMqLiveReader(exec) }),
  post = body => exec('gh', ['api', `repos/${repo}/issues/${num}/comments`, '--method', 'POST', '--input', '-'],
    { ...OPTIONS, input: JSON.stringify({ body }) }), now = () => new Date() } = {}) {
  if (!/^[a-f0-9]{40}$/i.test(result?.head)) throw Error('unreadable record head');
  const marker = `<!-- mechanical-clearance: head=${result.head} -->`;
  if (readComments().some(comment => isTrustedMarkerAuthor(comment) && typeof comment.body === 'string'
    && comment.body.split(/\r?\n/).includes(marker))) return false;
  const failedAt = result.rule === 'read-error' ? -1 : RULES.indexOf(result.rule);
  const outcomes = [`read-error: ${result.rule === 'read-error' ? 'FAIL' : 'PASS'}`,
    ...RULES.map((rule, i) => `${rule}: ${result.cleared || (failedAt >= 0 && i < failedAt) ? 'PASS' : rule === result.rule ? 'FAIL' : 'NOT EVALUATED'}`)];
  const timestamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', dateStyle: 'full', timeStyle: 'long' }).format(now());
  post(`${marker}\nMechanical clearance: ${result.cleared ? 'cleared' : result.rule}\n\n${outcomes.join('\n')}\n\n${timestamp} ET\nReceipt only; the drain validates live evidence. Refusals retain normal review.`);
  return true;
}
