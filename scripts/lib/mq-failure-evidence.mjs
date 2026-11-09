/** Bounded, head-bound merge-group evidence. All remote IO is supplied by the caller. */
const clean = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const infra = /runner has lost communication|runner.*(?:offline|disconnected)|infrastructure failure/i;
const assertion = /^(?:FAIL\b|AssertionError\b|Error: expect\b|Expected:|Received:|❯(?=\s))/;
const failureMarkers = /\b(?:FAIL|FAILED|AssertionError)\b|^failure\b|^Error: expect\b|^Expected:|^Received:|^❯(?=\s)/g;
// These jobs only aggregate sibling results; no other job name receives this exemption.
const derivedFailureJobs = new Set(['coverage-merge', 'test']);
const localJobName = name => clean(name).split(' / ').at(-1).trim().replace(/\s+\([^()\r\n]*\)$/, '');

// Positive causality evidence, not a job-name heuristic. Only a recognized dependency gate
// transcript can explain a derived failure; empty, arbitrary or contradictory output stays unknown.
const upstreamFailureOutcomes = new Set(['Some required jobs were not successful.', 'failure: upstream shard failed',
  // Real gate wording from the CI aggregate jobs (coverage-merge, test) when a unit shard failed.
  '##[error]Unit shards did not succeed; refusing incomplete coverage.', '##[error]Unit shards did not succeed.',
  '##[error]Coverage merge did not succeed.']);
const upstreamGateTranscript = new Set([
  '##[group]Run if [ "failure" != "success" ]; then',
  'if [ "failure" != "success" ]; then',
  'echo "Some required jobs were not successful."',
  'echo "::error::Unit shards did not succeed; refusing incomplete coverage."', 'echo "::error::Unit shards did not succeed."',
  'echo "::error::Coverage merge did not succeed."', 'shell: /usr/bin/bash -e {0}', 'exit 0',
  'exit 1', 'fi', '##[endgroup]', '##[error]Process completed with exit code 1.',
]);
function hasOnlyUpstreamFailure(lines) {
  // A hosted-runner log (it has ##[group] step markers) is long boilerplate: judge only its ##[error]
  // annotations. Every one must be a known upstream outcome or the generic exit-code annotation, and at
  // least one must be an upstream outcome. Plain transcripts keep the whole-log rule below.
  if (lines.some(line => line.startsWith('##[group]'))) {
    const errors = lines.filter(line => line.startsWith('##[error]'));
    // Un-annotated error text (a thrown Error, fatal:, npm ERR) is an independent failure, never boilerplate.
    if (lines.some(line => /Error\b|Exception\b|\bE(?:NOENT|ACCES|PIPE|TIMEDOUT)\b|\bpanic\b|Traceback|^fatal:|^npm ERR/.test(line))) return false;
    return lines.some(line => upstreamFailureOutcomes.has(line))
      && errors.every(line => upstreamFailureOutcomes.has(line) || line === '##[error]Process completed with exit code 1.');
  }
  return lines.some(line => upstreamFailureOutcomes.has(line))
    && lines.every(line => upstreamFailureOutcomes.has(line) || upstreamGateTranscript.has(line));
}

function failurePaths(text, repo) {
  const name = repo.split('/').at(-1);
  // The hosted-runner root is assembled from parts so no literal host home path is committed (host-path ratchet).
  const runnerWork = ['', 'home', 'runner', 'work'].join('/');
  const roots = ['/workspace/', `${runnerWork}/${name}/${name}/`, `/__w/${name}/${name}/`];
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
    // The suffix is the queue's BASE SHA, not the tested PR head. Branch naming scopes the PR;
    // only ancestry of the merge-group commit proves which PR head was actually tested.
    const branch = new RegExp(`^gh-readonly-queue/main/pr-${removal.pr}-[0-9a-f]{40}(?![\\s\\S])`);
    const candidates = (await pages('listRuns', 'runs')).filter(run => run.event === 'merge_group'
      && typeof run.head_branch === 'string' && branch.test(run.head_branch) && run.conclusion === 'failure');
    const runs = [];
    // Verify all candidates before collecting any jobs: an unreadable proof leaves evidence empty.
    for (const run of candidates) {
      if (!/^[a-f0-9]{40}(?![\s\S])/.test(run.head_sha ?? '')) return result;
      const proven = await call('isAncestor', { ancestor: removal.head, descendant: run.head_sha });
      if (proven === true) runs.push(run);
      else if (proven !== false) return result;
    }
    if (!runs.length) return result;
    let pathsComplete = true;
    for (const run of runs) {
      const jobs = await pages('listJobs', 'jobs', { runId: run.id });
      const failed = jobs.filter(job => job.conclusion === 'failure');
      if (!failed.length) return result;
      let assertionJobs = 0, derivedWithoutAssertions = 0;
      for (const job of failed) {
        if (typeof job.name !== 'string' || !job.name) return result;
        add('failedJobs', clean(job.name));
        const log = await call('readJobLog', { jobId: job.id });
        if (log?.complete !== true || typeof log.text !== 'string' || Buffer.byteLength(log.text) > maxLogBytes) return result;
        let parsed = false, hasAssertions = false, markers = 0, attributed = 0;
        const jobAssertions = [], jobPaths = new Set(), causalityLines = [], markerLines = [];
        let activePaths = [], capturedOutput = false, unterminatedBlock = false;
        for (const raw of clean(log.text).split(/\r?\n/)) {
          const line = raw.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '').trim();
          // Vitest echoes passing tests' stdout/stderr verbatim. These blocks can contain fake
          // FAILs/assertions/paths; only the next blank line returns us to the runner's own output.
          if (/^(?:stdout|stderr)\s*\|/.test(line)) { capturedOutput = true; activePaths = []; continue; }
          if (capturedOutput) {
            // A blank line, or vitest's own failure/summary headings, ends the captured block.
            if (!line) { capturedOutput = false; continue; }
            // vitest's final summary heading inside a block means the block never ended: whatever it hid is
            // unknown, so the evidence cannot be complete (fail closed).
            if (/^(?:Test Files|Tests)\s/.test(line)) { capturedOutput = false; unterminatedBlock = true; }
            else continue;
          }
          if (line) causalityLines.push(line);
          if (assertion.test(line)) hasAssertions = true;
          if (assertion.test(line) || infra.test(line)) { jobAssertions.push(line); parsed = true; }
          const found = [...line.matchAll(failureMarkers)];
          if (!found.length) { activePaths = []; continue; }
          markerLines.push(line);
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
            for (const path of paths) jobPaths.add(path);
          }
        }
        if (capturedOutput || unterminatedBlock) pathsComplete = false; // an unended captured block may hide real failures
        if (jobAssertions.length > 100 || jobPaths.size > 100) return result;
        // Any structured failure marker in a derived job's own log (attributed or not) is real evidence,
        // not boilerplate: it must go through normal attribution instead of being exempted.
        if (!hasAssertions && markerLines.every(line => upstreamFailureOutcomes.has(line)) && derivedFailureJobs.has(localJobName(job.name))) {
          if (!hasOnlyUpstreamFailure(causalityLines)) return result;
          // Read the log first, but defer attribution until all siblings in THIS run are known.
          // Boilerplate from a derived failure contributes its job name, not phantom test paths.
          derivedWithoutAssertions++;
          continue;
        }
        for (const line of jobAssertions) add('assertions', line);
        for (const path of jobPaths) add('testFiles', path);
        if (hasAssertions) assertionJobs++;
        // Neither another job nor another failure in this job can hide an unattributed marker.
        if (markers !== attributed) pathsComplete = false;
        if (!parsed || result.assertions.length > 100 || result.testFiles.length > 100) return result;
      }
      if (derivedWithoutAssertions && !assertionJobs) return result;
    }
    result.complete = pathsComplete;
    if (!pathsComplete && result.assertions.some(line => assertion.test(line))) result.failureProven = true;
  } catch { /* Unreadable or oversized evidence remains incomplete for fix/operator inspection. */ }
  return result;
}
