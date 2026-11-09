/** Bounded, head-bound merge-group evidence. All remote IO is supplied by the caller. */
const clean = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const infra = /runner has lost communication|runner.*(?:offline|disconnected)|infrastructure failure/i;
const assertion = /^(?:FAIL\b|AssertionError\b|Error: expect\b|Expected:|Received:)/;
const failureMarkers = /\b(?:FAIL|FAILED|AssertionError|failure)\b|^Error: expect\b|^Expected:|^Received:/gi;
function failurePaths(text, repo) {
  const name = repo.split('/').at(-1);
  const roots = ['/workspace/', `/home/runner/work/${name}/${name}/`, `/__w/${name}/${name}/`];
  const paths = [];
  let complete = true;
  for (const match of text.matchAll(/(?:^|[\s(])((?:[A-Za-z]:)?[\w@./\\-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?=[:\s)]|$)/g)) {
    let path = match[1].replace(/\\/g, '/');
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
      const root = roots.find(prefix => path.startsWith(prefix));
      if (!root) { complete = false; continue; } // Unknown checkout root: retain path uncertainty.
      path = path.slice(root.length);
    }
    path = path.replace(/^(?:\.\/)+/, '');
    if (path.split('/').some(part => !part || part === '.' || part === '..')) { complete = false; continue; }
    if (!paths.includes(path)) paths.push(path);
  }
  return { paths, complete };
}
export function classifyMqFailureEvidence(evidence) {
  // Missing paths forbid refresh, while fully read, head-bound assertions can still prove a real
  // defect for the normal fixer. Missing/unreadable logs never receive this separate proof.
  if ((evidence?.complete !== true && evidence?.failureProven !== true) || !evidence?.failedJobs?.length) return 'unknown';
  if (evidence.assertions?.some(line => assertion.test(line))) return 'real';
  return evidence.assertions?.length && evidence.assertions.every(line => infra.test(line)) ? 'infra' : 'unknown';
}
export async function collectMqFailureEvidence({ removal, io, limits = {} }) {
  const result = { failedJobs: [], testFiles: [], assertions: [], complete: false };
  const maxPages = Math.min(20, limits.maxPages ?? 10);
  const maxLogBytes = Math.min(2 * 1024 * 1024, limits.maxLogBytes ?? 256 * 1024);
  let calls = 0;
  const call = async (method, args) => {
    if (++calls > 128) throw new Error('evidence budget exceeded; operator inspection required');
    return io[method]({ repo: removal.repo, ...args });
  };
  const pages = async (method, field, args = {}) => {
    const rows = [], seen = new Set();
    let page = 1;
    for (let n = 0; n < maxPages; n++) {
      if (!Number.isInteger(page) || seen.has(page)) throw new Error('invalid pagination');
      seen.add(page);
      const response = await call(method, { ...args, page });
      if (response?.complete !== true || !Array.isArray(response[field]) || response[field].length > 100) throw new Error('incomplete page');
      rows.push(...response[field]);
      if (response.nextPage === null) return rows;
      page = response.nextPage;
    }
    throw new Error('pagination bound; operator inspection required');
  };
  const add = (key, value) => { if (!result[key].includes(value)) result[key].push(value); };
  try {
    if (!removal?.repo || !Number.isInteger(removal.pr) || !/^[a-f0-9]{40}$/.test(removal.head)) return result;
    const runs = (await pages('listRuns', 'runs')).filter(run => run.event === 'merge_group'
      && run.head_branch === `gh-readonly-queue/main/pr-${removal.pr}-${removal.head}` && run.conclusion === 'failure');
    if (!runs.length) return result;
    let pathsComplete = true;
    for (const run of runs) {
      const jobs = await pages('listJobs', 'jobs', { runId: run.id });
      const failed = jobs.filter(job => job.conclusion === 'failure');
      if (!failed.length) return result;
      for (const job of failed) {
        if (typeof job.name !== 'string' || !job.name) return result;
        add('failedJobs', clean(job.name));
        const log = await call('readJobLog', { jobId: job.id });
        if (log?.complete !== true || typeof log.text !== 'string' || Buffer.byteLength(log.text) > maxLogBytes) return result;
        let parsed = false, markers = 0, attributed = 0;
        let activePaths = [];
        for (const raw of clean(log.text).split(/\r?\n/)) {
          const line = raw.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '').trim();
          if (assertion.test(line) || infra.test(line)) { add('assertions', line); parsed = true; }
          const found = [...line.matchAll(failureMarkers)];
          if (!found.length) { activePaths = []; continue; }
          for (let i = 0; i < found.length; i++) {
            const segment = line.slice(found[i].index, found[i + 1]?.index ?? line.length);
            const { paths, complete } = failurePaths(segment, removal.repo);
            const detail = /^(?:AssertionError\b|Error: expect\b|Expected:|Received:)/i.test(segment);
            markers++;
            // Only assertion detail in the same failure block may inherit its preceding FAIL's path.
            // A new FAIL/failure marker always starts a new attribution, even within the same job.
            if (!complete) activePaths = [];
            else if (paths.length) activePaths = paths;
            else if (!detail) activePaths = [];
            if (activePaths.length) attributed++;
            for (const path of paths) add('testFiles', path);
          }
        }
        // Neither another job nor another failure in this job can hide an unattributed marker.
        if (markers !== attributed) pathsComplete = false;
        if (!parsed || result.assertions.length > 100 || result.testFiles.length > 100) return result;
      }
    }
    result.complete = pathsComplete;
    if (!pathsComplete && result.assertions.some(line => assertion.test(line))) result.failureProven = true;
  } catch { /* Unreadable or oversized evidence remains incomplete for fix/operator inspection. */ }
  return result;
}
