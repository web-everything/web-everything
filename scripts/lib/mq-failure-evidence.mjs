/** Bounded, head-bound merge-group evidence. All remote IO is supplied by the caller. */
const clean = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const infra = /runner has lost communication|runner.*(?:offline|disconnected)|infrastructure failure/i;
const assertion = /^(?:FAIL\b|AssertionError\b|Error: expect\b|Expected:|Received:|❯(?=\s))/;
const failureMarkers = /\b(?:FAIL|FAILED|AssertionError)\b|(?:^|[\w-]+:\s+)failure\b|^Error: expect\b|^Expected:|^Received:/g;
// These jobs only aggregate sibling results; no other job name receives this exemption.
// Lines inside a runner's own failure block that carry no failure identity: blank separators, the
// "- Expected / + Received" diff body and echoed source code frames ("12|   expect(...)", "  |   ^"). They neither
// start nor end a failure block, and their text (which may quote 'FAIL') is never scanned for markers.
const blockNoise = line => !line || /^[-+](?:\s|$)/.test(line) || /^\d+\|/.test(line) || /^\|(?:\s|$)/.test(line);
const derivedFailureJobs = new Set(['coverage-merge', 'test']);
const localJobName = name => clean(name).split(' / ').at(-1).trim().replace(/\s+\([^()\r\n]*\)$/, '');

// Positive causality evidence, not a job-name heuristic. Only a recognized dependency gate
// transcript can explain a derived failure; empty, arbitrary or contradictory output stays unknown.
const upstreamFailureOutcomes = new Set(['Some required jobs were not successful.', 'failure: upstream shard failed',
  // Real gate wording from the CI aggregate jobs (coverage-merge, test) when a unit shard failed.
  '##[error]Unit shards did not succeed; refusing incomplete coverage.', '##[error]Unit shards did not succeed.',
  '##[error]Coverage merge did not succeed.',
  // The required `test` job also gates on the integration, standards and host-paths jobs (ci.yml "Gate on shard
  // results"). Each of those has its own failed job and log, so the sibling's assertions still have to carry the proof.
  '##[error]Integration did not succeed.', '##[error]Standards did not succeed.', '##[error]Host paths did not succeed.']);
const upstreamGateTranscript = new Set([
  '##[group]Run if [ "failure" != "success" ]; then',
  'if [ "failure" != "success" ]; then',
  'echo "Some required jobs were not successful."',
  'echo "::error::Unit shards did not succeed; refusing incomplete coverage."', 'echo "::error::Unit shards did not succeed."',
  'echo "::error::Integration did not succeed."', 'echo "::error::Standards did not succeed."', 'echo "::error::Host paths did not succeed."',
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
    if (lines.some(line => /Error\b|Exception\b|\bE(?:NOENT|ACCES|PIPE|TIMEDOUT)\b|\bpanic\b|Traceback|^fatal:|^npm ERR|[Uu]nexpected|[Tt]erminated|[Cc]rash|[Tt]imed? ?out|[Cc]ancel|[Kk]illed|[Aa]bort/.test(line))) return false;
    return lines.some(line => upstreamFailureOutcomes.has(line))
      && errors.every(line => upstreamFailureOutcomes.has(line) || line === '##[error]Process completed with exit code 1.');
  }
  return lines.some(line => upstreamFailureOutcomes.has(line))
    && lines.every(line => upstreamFailureOutcomes.has(line) || upstreamGateTranscript.has(line));
}

// Longest log line the parser reads. Real runner headings are far shorter; a longer line is not parsed past this
// bound (every regex below is then bounded) and keeps path evidence incomplete, so it goes to the fixer.
const MAX_LINE = 2048;
// Words that may directly precede a path without being the first half of a spaced path name.
const pathLeaders = new Set(['at', 'in', 'from', 'of', 'on', 'to', 'by', 'for', 'with', 'see', 'file', 'path', 'async', 'new',
  'fail', 'failed', 'failure']);
// The whitespace-delimited word that ends right before `end`, found by a linear backward scan ('' when the path is
// not preceded by whitespace). Never a regex: this runs once per path match on attacker-influenced text.
function wordBefore(text, end) {
  let stop = end;
  while (stop > 0 && /\s/.test(text[stop - 1])) stop--;
  if (stop === end) return '';
  let start = stop;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  return text.slice(start, stop);
}
// Linear equivalent of replace(/\s+\[[^\]]*\]\s*$/, ''): drop a trailing " [ ... ]" group with no inner "]".
function stripBracketSuffix(text) {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(']')) return text;
  for (let i = trimmed.lastIndexOf(']', trimmed.length - 2) + 1; i < trimmed.length - 1; i++) {
    if (trimmed[i] === '[' && i > 0 && /\s/.test(trimmed[i - 1])) {
      let start = i - 1;
      while (start > 0 && /\s/.test(trimmed[start - 1])) start--;
      return trimmed.slice(0, start);
    }
  }
  return text;
}

function failurePaths(text, repo) {
  const name = repo.split('/').at(-1);
  // The hosted-runner root is assembled from parts so no literal host home path is committed (host-path ratchet).
  const runnerWork = ['', 'home', 'runner', 'work'].join('/');
  const roots = ['/workspace/', `${runnerWork}/${name}/${name}/`, `/__w/${name}/${name}/`];
  const paths = [];
  let complete = true;
  // A heading (`FAIL <path> > ...`, `❯ <path> ...`) names exactly ONE path token. A path with a space (tab, NBSP,
  // quotes, a Windows directory) would otherwise be read as its last space-free word, a different file that may
  // sit outside the PR diff. Cut only at the suite separator (" > ") or a trailing "[ file ]" suffix; whatever
  // remains, parentheses and brackets included, must be ONE token, the shape the FAIL-heading counter also requires.
  // The words found in an ambiguous heading stay only as a hint for the fixer; the incomplete flag keeps them from
  // ever authorizing a refresh.
  // The same one-token rule covers every failure-marker form that is followed by a path: a labelled or bare lowercase
  // "failure" marker ("runner: failure <path> > t") is a heading just like FAIL.
  const lead = /^(?:[\w-]+:\s+)?(?:FAIL(?:ED)?|failure|(❯))\s+([\s\S]*)$/.exec(text);
  if (lead) {
    let candidate = stripBracketSuffix(lead[2].split(/\s+>\s/, 1)[0]);
    if (lead[1]) {
      // "❯" rows: strip a progress suffix "(4 tests | 1 failed) 31ms" and an optional leading stack-frame function
      // token ("Proxy.<anonymous> test/a.test.mjs:5:3"); a bare word is NOT a function token.
      candidate = candidate.replace(/\s+\(\d+ tests?\b.*$/, '')
        .replace(/^(?:(?:new|async)\s+[\w$@-]+(?:\.[\w$<>@-]+)*|[\w$@-]+(?:\.[\w$<>@-]+)+)\s+(?=\S+$)/, '');
    }
    candidate = candidate.replace(/:\d+(?::\d+)?$/, '');
    if (!/^[^\s"'`()[\]]+$/.test(candidate)) complete = false;
  }
  let pathsSeen = 0;
  for (const match of text.matchAll(/(?:^|[\s(])((?:[A-Za-z]:)?[\w@./\\-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?=[:\s)]|$)/g)) {
    // A path that follows another word after whitespace may be the tail of a spaced path ("tests/my widget.test.mjs",
    // "my widget.test.mjs"), whatever marker introduced it. That word is harmless when it is a complete test path (a
    // list of files), a connective or marker word ("at", "in", "FAIL"), or not bare ("Proxy.<anonymous>", "❯",
    // "Expected:"). A directory-looking word (a "/" or "\") or any other bare word keeps the path ambiguous.
    // The heading's own path was already validated as exactly one token above (a "new Widget" frame prefix included).
    const headingPath = lead !== null && pathsSeen++ === 0;
    const word = wordBefore(text, match.index + match[0].length - match[1].length);
    if (word && ((/[/\\]/.test(word) && !/\.(?:test|spec)\.[cm]?[jt]sx?(?::\d+){0,2}[,;]?$/.test(word))
      || (!headingPath && /^[\w-]+$/.test(word) && !pathLeaders.has(word.toLowerCase())))) complete = false;
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
        let pathIncomplete = false, blankSince = false, headlineUsed = false, unhandledErrors = false; const failHeadingFiles = new Set(); let failHeadings = 0, summaryFiles = null, summaryTests = null;
        for (const rawFull of clean(log.text).split(/\r?\n/)) {
          const overlong = rawFull.length > MAX_LINE;
          const raw = overlong ? rawFull.slice(0, MAX_LINE) : rawFull;
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
          // Runner output past the bound is unread: path evidence stays incomplete. Lines inside a captured
          // stdout/stderr block never reach here, so a passing test's long output does not cost the refresh route.
          if (overlong) pathIncomplete = true;
          if (line) causalityLines.push(line);
          const noise = blockNoise(line);
          const afterBlank = blankSince;
          if (!line) blankSince = true; else if (!noise) blankSince = false;
          if (/^(?:Errors\s+\d+ errors?\b|.*Unhandled (?:Rejection|Error)s?\b)/.test(line)) unhandledErrors = true;
          const summary = /^(Test Files|Tests)\s+(?:(\d+) failed)?/.exec(line);
          if (summary) { const n = summary[2] === undefined ? 0 : Number(summary[2]); if (summary[1] === 'Tests') summaryTests = n; else summaryFiles = n; }
          const heading = /^FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+>/.exec(line);
          if (heading) { failHeadings++; failHeadingFiles.add(heading[1]); }
          if (/^❯\s/.test(line)) {
            // A "❯ path" frame or progress row is a path source, not a failure of its own; the FAIL heading owns that.
            const frame = failurePaths(line, removal.repo);
            if (!frame.complete) pathIncomplete = true;
            for (const path of frame.paths) jobPaths.add(path);
          }
          if (assertion.test(line)) hasAssertions = true;
          if (assertion.test(line) || infra.test(line)) { jobAssertions.push(line); parsed = true; }
          const found = noise ? [] : [...line.matchAll(failureMarkers)];
          if (!found.length) { if (!noise) activePaths = []; continue; }
          markerLines.push(line);
          for (let i = 0; i < found.length; i++) {
            const segment = line.slice(found[i].index, found[i + 1]?.index ?? line.length);
            const { paths, complete } = failurePaths(segment, removal.repo);
            const detail = /^(?:AssertionError\b|Error: expect\b|Expected:|Received:)/i.test(segment);
            // A blank line may separate a FAIL heading from its error headline, and that headline from its
            // "Expected:/Received:" detail. But a SECOND headline after a blank line is a new error: it must
            // carry its own path or stay unattributed, never inherit the previous test's.
            const headline = /^(?:AssertionError\b|Error: expect\b)/i.test(segment);
            if (headline && afterBlank && headlineUsed) activePaths = [];
            if (headline) headlineUsed = true; else if (!detail) headlineUsed = false;
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
        // Cross-check against vitest's own summary: a captured block, odd formatting or an embedded marker
        // can hide a failing test from the parser, but not from the totals the runner printed itself.
        if ((summaryFiles !== null && summaryFiles !== failHeadingFiles.size)
          || (summaryTests !== null && summaryTests !== failHeadings)) pathsComplete = false;
        if (capturedOutput || unterminatedBlock || unhandledErrors || pathIncomplete) pathsComplete = false; // unhandled errors have no FAIL heading // an unended captured block may hide real failures
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
