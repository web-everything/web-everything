/**
 * Pre-install soak scope: seed the harness tree and config, then follow local
 * imports and literal repository paths (including scripts launched/read by tests).
 * This is a conservative source scan, never an execution of PR code. Unreadable
 * evidence makes the CLI request the soak rather than silently skipping it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ciGreenOnSha } from '../../lib/lane-verify.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
// Code folders: a named path here is followed even when missing (a deleted dependency).
const CODE_ROOT = /^(?:scripts|src|tools|skills-src)\//;

// WM2 suite policy. This is a versioned contract, not an environment override.
// Changing the suite requires a new receipt name; older receipts remain historical evidence.
export const SOAK_SUITE_POLICY = Object.freeze({
  phase: 'postmerge', receipt: 'postmerge-soak-v1', maxAttempts: 2,
  maxPages: 3, maxCalls: 24, requestMs: 10_000, deadlineMs: 60_000,
});
const FULL_SHARDS = '[1,2,3,4,5,6,7,8]';
const fullSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const releaseHold = reason => ({ ok: false, reason, owner: 'repository-maintainers',
  recovery: 'Keep release/adoption held; rerun the same main CI run once (at most two attempts). If exhausted or evidence exceeds bounds, repository maintainers must investigate and merge a corrective commit.' });

/** @param {{event?:string, ref?:string}} input @returns {'premerge'|'postmerge'|'refuse'} */
export function soakGatePhase({ event, ref } = {}) {
  if (['pull_request', 'merge_group'].includes(event)) return 'premerge';
  if (['push', 'workflow_dispatch'].includes(event) && ref === 'refs/heads/main') return SOAK_SUITE_POLICY.phase;
  return 'refuse';
}

/** Validate the native Actions receipt producer; no API writes or personal credentials.
 * @param {object} input @returns {{ok:boolean, reason:string, owner?:string, recovery?:string}}
 */
export function postmergeReceiptGate({ event, ref, sha, runId, attempt, scopeResult, run, shards, shardResult, aggregateResult } = {}) {
  if (event !== 'push' || soakGatePhase({ event, ref }) !== 'postmerge' || !fullSha(sha)
    || !positiveId(runId) || !positiveId(attempt) || attempt > SOAK_SUITE_POLICY.maxAttempts) return releaseHold('postmerge-producer-identity-or-attempt');
  if (scopeResult !== 'success' || run !== 'true' || shards !== FULL_SHARDS
    || shardResult !== 'success' || aggregateResult !== 'success') return releaseHold('postmerge-full-suite-incomplete');
  return { ok: true, reason: SOAK_SUITE_POLICY.receipt };
}

/** Read-only release/adoption gate. Call inside the consumer's action lock immediately before effects.
 * Native Actions owns the durable pending/completed journal: absent, crashed or skipped receipts HOLD.
 * All IO, repository identity and time are explicit; no checkout, environment, git or host probes.
 * @param {{repo:string, sha:string, now:()=>number, request:Function}} input
 * @returns {Promise<object>} A named hold with recovery, or an exact SHA/run/attempt receipt.
 */
export async function postmergeReleaseGate({ repo, sha, now, request } = {}) {
  try {
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !fullSha(sha)
      || typeof now !== 'function' || typeof request !== 'function') return releaseHold('postmerge-input-unreadable');
    const [owner, repository] = repo.split('/');
    const started = now();
    let calls = 0;
    const read = async (route, args = {}) => {
      const time = now();
      if (!Number.isFinite(started) || !Number.isFinite(time) || time < started || time - started >= SOAK_SUITE_POLICY.deadlineMs) throw new Error('postmerge-clock-or-deadline');
      if (++calls > SOAK_SUITE_POLICY.maxCalls) throw new Error('postmerge-call-budget');
      const controller = new AbortController();
      let timer;
      try {
        const response = await Promise.race([
          request(route, { owner, repo: repository, ...args, request: { timeout: SOAK_SUITE_POLICY.requestMs, signal: controller.signal } }),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('postmerge-request-timeout')); }, SOAK_SUITE_POLICY.requestMs); }),
        ]);
        if (response?.status !== 200 || !response.data || typeof response.data !== 'object'
          || JSON.stringify(response.data).length > 2 * 1024 * 1024) throw new Error('postmerge-response-unreadable-or-oversized');
        const finished = now();
        if (!Number.isFinite(finished) || finished < started || finished - started >= SOAK_SUITE_POLICY.deadlineMs) throw new Error('postmerge-clock-or-deadline');
        return response.data;
      } finally { clearTimeout(timer); }
    };
    const pages = async (route, field, args = {}) => {
      const rows = [];
      let total;
      for (let page = 1; page <= SOAK_SUITE_POLICY.maxPages; page++) {
        const data = await read(route, { ...args, per_page: 100, page });
        if (!Number.isSafeInteger(data.total_count) || data.total_count < 0 || data.total_count > 100 * SOAK_SUITE_POLICY.maxPages
          || (total !== undefined && total !== data.total_count) || !Array.isArray(data[field])) throw new Error('postmerge-pagination-unreadable-or-oversized');
        total = data.total_count;
        if (data[field].length !== Math.min(100, total - rows.length)) throw new Error('postmerge-pagination-incomplete');
        rows.push(...data[field]);
        if (rows.length === total) {
          if (rows.some(row => !positiveId(row?.id)) || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('postmerge-record-identity-unreadable');
          return rows;
        }
      }
      throw new Error('postmerge-page-budget');
    };
    const snapshot = async () => {
      const head = await read('GET /repos/{owner}/{repo}/git/ref/heads/main');
      if (head.object?.sha !== sha) return releaseHold('postmerge-main-head-moved-or-unreadable');
      const workflows = await pages('GET /repos/{owner}/{repo}/actions/workflows/ci.yml/runs', 'workflow_runs', { head_sha: sha, event: 'push' });
      if (!workflows.length || workflows.some(w => !positiveId(w?.id) || !positiveId(w.check_suite_id)
        || w.head_sha !== sha || w.event !== 'push' || w.head_branch !== 'main'
        || w.repository?.full_name !== repo || w.head_repository?.full_name !== repo
        || w.path !== '.github/workflows/ci.yml') || new Set(workflows.map(w => w.id)).size !== workflows.length) return releaseHold('postmerge-workflow-identity-unreadable');
      const latest = workflows.reduce((a, b) => a.id > b.id ? a : b);
      if (!positiveId(latest.run_attempt) || latest.run_attempt > SOAK_SUITE_POLICY.maxAttempts
        || latest.status !== 'completed' || latest.conclusion !== 'success') return releaseHold('postmerge-workflow-incomplete-or-attempt-exhausted');
      const checks = await pages('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', 'check_runs', { ref: sha, filter: 'all' });
      const verified = ciGreenOnSha({ headSha: sha, workflowRuns: [latest], checkRuns: checks,
        required: ['test', 'smoke', 'daemon-soak', SOAK_SUITE_POLICY.receipt] });
      if (!verified.ok) return releaseHold('postmerge-trusted-receipt-missing-or-unsuccessful');
      const jobs = await pages('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', 'jobs',
        { run_id: latest.id, attempt_number: latest.run_attempt });
      if (jobs.some(job => job.head_sha !== sha || job.run_id !== latest.id || job.run_attempt !== latest.run_attempt
        || job.status !== 'completed')) return releaseHold('postmerge-job-unbound-or-active');
      const requiredJobs = [SOAK_SUITE_POLICY.receipt, ...Array.from({ length: 8 }, (_, i) => `soak-shard (${i + 1})`)];
      const selected = [];
      for (const name of requiredJobs) {
        const matching = jobs.filter(job => job.name === name);
        if (matching.length !== 1) return releaseHold('postmerge-full-suite-job-missing-or-ambiguous');
        const job = matching[0];
        if (job.head_sha !== sha || job.run_id !== latest.id || job.run_attempt !== latest.run_attempt
          || job.status !== 'completed' || job.conclusion !== 'success') return releaseHold('postmerge-job-unbound-or-unsuccessful');
        selected.push(job.id);
      }
      return { ok: true, sha, runId: latest.id, attempt: latest.run_attempt, suite: SOAK_SUITE_POLICY.receipt,
        sources: verified.sources, jobs: selected };
    };
    const first = await snapshot();
    if (!first.ok) return first;
    const live = await snapshot();
    if (!live.ok) return live;
    if (JSON.stringify(first) !== JSON.stringify(live)) return releaseHold('postmerge-evidence-changed-during-admission');
    const head = await read('GET /repos/{owner}/{repo}/git/ref/heads/main');
    if (head.object?.sha !== sha) return releaseHold('postmerge-main-head-moved-at-action');
    return live;
  } catch (error) {
    // External errors may contain credentials or control text; expose only our named reasons.
    const reason = /^postmerge-[a-z-]+$/.test(error?.message) ? error.message : 'postmerge-request-failed';
    return releaseHold(`postmerge-evidence-unreadable: ${reason}`);
  }
}

// Decode JavaScript string escapes in one left-to-right pass, so an escaped backslash before
// `u0064` is never read as a Unicode escape: `\u{…}`, `\uXXXX`, `\xXX`, legacy octal (CommonJS
// sloppy mode), line continuations, the single-letter controls and identity escapes (`\/`,
// `\'`). An out-of-range `\u{…}` stays raw.
const JS_ESCAPE = /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[\n\r\p{Zl}\p{Zp}])|([^]))/gu;
const CONTROL = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
function unescapeJs(text) {
  return text.replace(JS_ESCAPE, (whole, braced, unicode, hex, octal, continuation, other) => {
    if (braced !== undefined) {
      const point = Number.parseInt(braced, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    if (unicode !== undefined || hex !== undefined) return String.fromCharCode(Number.parseInt(unicode ?? hex, 16));
    if (octal !== undefined) return String.fromCharCode(Number.parseInt(octal, 8));
    if (continuation !== undefined) return '';
    return CONTROL[other] ?? other;
  });
}

// Literal shapes. Each regex has exactly two groups (quote, body) and starts in a lookahead,
// so a quoted keyword (`'import'`) or a stray apostrophe cannot consume a real literal after it.
// PLAIN is the original shape (no quote of any kind inside). STRING and TEMPLATE add the other
// quote, `\'`, escapes, line continuations and (templates only) raw newlines; `forms` decodes
// their bodies. All shapes are scanned and unioned, so scope only widens.
// Linear cost: an escape-aware start is a quote after an even run of backslashes (none, or an
// escaped backslash as in `C:\\'./x'`), so it is never an escaped quote, and it ends at the
// next unescaped quote of its kind; two starts of one kind never scan the same text. The quote
// is tested before the backslash-run lookbehind, so that lookbehind runs only at quotes.
const PLAIN = /(?=(['"`])([^'"`\r\n]+)\1)/.source;
const STRING = /(?=(['"])((?:(?!\1)[^\\\r\n]|\\(?:\r\n|[^]))+)\1)/.source;
const TEMPLATE = /(?=(`)((?:[^`\\]|\\[^])+)\1)/.source;
const shapes = (prefix, escapedPrefix = prefix) => [
  new RegExp(prefix + PLAIN, 'g'),
  new RegExp(escapedPrefix + STRING, 'g'),
  new RegExp(escapedPrefix + TEMPLATE, 'g'),
];
// `import'x'`, `export*from"x"` and `import(\`x\`)` are valid: whitespace is optional, and
// dynamic import/require may take a template literal. A keyword start is never escaped.
const IMPORT_SHAPES = shapes(/(?:\bfrom|\bimport(?:\s*\()?|\brequire\s*\()\s*/.source);
const URL_SHAPES = shapes(/\bnew\s+URL\s*\(\s*/.source);
const LITERAL_SHAPES = [/(['"`])([^'"`\r\n]+)\1/g, ...shapes('', /(?=['"`])(?<=(?:^|[^\\])(?:\\\\)*)/.source).slice(1)];

// The URL parser trims leading and trailing C0 controls and spaces (code points 0-32) only.
function urlTrim(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end -= 1;
  return text.slice(start, end);
}

export function computeSoakClosure({ root = DEFAULT_ROOT } = {}) {
  root = resolve(root);
  const closure = new Set();
  const scanned = new Set();
  const pending = [];
  const inside = (path) => {
    const rel = relative(root, path);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const add = (path, scan = true) => {
    if (!inside(path)) return;
    const key = relative(root, path).split(sep).join('/');
    closure.add(key);
    // A file first seen unscanned (a soak unit test) is still scanned once a soak file imports it.
    if (scan && !scanned.has(key)) { scanned.add(key); pending.push(path); }
  };
  // The soak tooling's own unit tests are in scope as files, but the soak never runs them, so
  // their fixture literals are not soak dependencies (and would make their own assertions vacuous).
  const UNIT_TESTS = 'scripts/conveyor/soak/__tests__/';
  const seed = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) seed(path);
      else if (entry.isFile()) add(path, !relative(root, path).split(sep).join('/').startsWith(UNIT_TESTS));
      else throw new Error('Unsupported soak seed entry');
    }
  };
  // Any top-level folder or file can be a runtime dependency (the soak world copies
  // `schemas/…`, `package.json`, `.gitignore` by name), not only the code folders.
  const topLevel = new Set(readdirSync(root).filter((name) => name !== '.git' && name !== 'node_modules'));
  // What the engine loads, in its order: the language decodes string escapes first (`\x64ep`
  // is `dep`). Then an import specifier goes through the URL parser, which drops tab/LF/CR,
  // trims C0 controls and spaces, and reads `\` as `/`. Then `?`/`#` end the path and `%xx`
  // decodes: `./x.mjs?fresh=1#v` and `./a%20b.mjs` load `x.mjs` and `a b.mjs`. Keep every
  // intermediate form too (a plain fs path may legitimately contain `\`, `?`, `#`, `%` or spaces).
  const forms = (specifier) => {
    // Fast path: without these characters every form below equals the specifier itself.
    if (!/[\\?#%\x00-\x1f]|^\x20|\x20$/.test(specifier)) return [specifier];
    const all = new Set();
    for (const text of [specifier, unescapeJs(specifier)]) {
      const url = urlTrim(text.replace(/[\t\n\r]/g, '')).replaceAll('\\', '/');
      for (const value of [text, url]) {
        const cut = value.search(/[?#]/);
        const bare = cut < 0 ? value : value.slice(0, cut);
        let decoded = bare;
        // Guarded: a thrown URIError (a stray `%` in a long body) is costly at scan scale.
        if (/%[0-9a-fA-F]{2}/.test(bare)) {
          try { decoded = decodeURIComponent(bare); } catch { /* malformed escape: keep the raw form */ }
        }
        all.add(value).add(bare).add(decoded);
      }
    }
    // A NUL (`\0`, `%00`) cannot name a file, and the fs calls throw on it rather than ENOENT.
    return [...all].filter((form) => form && !form.includes('\0'));
  };
  const isFile = (path) => {
    try { return statSync(path).isFile(); }
    catch (error) {
      // A name too long for the filesystem cannot exist (a multi-line template literal body).
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ENAMETOOLONG') return false;
      throw error;
    }
  };
  // Several literal shapes name most literals more than once; the outcome depends only on `base`.
  const followed = new Set();
  const follow = (base) => {
    if (followed.has(base)) return;
    followed.add(base);
    // Always try the suffixes: a dotted basename (`./vitest.shared`) has an extname but is
    // still extensionless to the resolver. Each candidate is checked: `<root>.mjs` (from a
    // literal naming the root itself) lies outside the repository and is never touched.
    const candidates = [base];
    for (const suffix of ['.mjs', '.js', '.cjs', '.ts', '.mts', '.tsx', '/index.mjs', '/index.js', '/index.ts']) {
      candidates.push(`${base}${suffix}`);
    }
    candidates.splice(0, candidates.length, ...candidates.filter(inside));
    for (const candidate of candidates) {
      if (isFile(candidate)) { add(candidate); return; }
    }
    // A deleted dependency is still in scope. Preserve every resolution candidate
    // without trying to read it; this also covers extensionless deleted imports.
    for (const candidate of candidates) add(candidate, false);
  };

  seed(resolve(root, 'scripts/conveyor/soak'));
  const config = resolve(root, 'vitest.soak.config.ts');
  if (!isFile(config)) throw new Error('Missing soak configuration');
  add(config);
  // The files the soak world copies by name (red-green.mjs#RUNTIME_PATHS, which mirrors
  // sim/world.mjs#buildWeTemplate) are in scope even when a PR deletes one. Folders in that
  // list are covered by the import graph. The list must be exactly one non-empty array of
  // plain quoted strings: a spread, a template entry or a second definition could hide entries,
  // so any other shape throws and the CLI requests the soak (run=true).
  const runtimeSource = readFileSync(resolve(root, 'scripts/conveyor/soak/red-green.mjs'), 'utf8');
  const definitions = [...runtimeSource.matchAll(/\bRUNTIME_PATHS\s*=(?!=)/g)].length;
  const runtime = /^export const RUNTIME_PATHS = Object\.freeze\(\[([^\]]*)\]\);$/m.exec(runtimeSource);
  const ENTRY = String.raw`\s*(?:'[^'"\\\r\n$]+'|"[^'"\\\r\n$]+")\s*`;
  if (definitions !== 1 || !runtime || !new RegExp(`^(?:${ENTRY},)*${ENTRY},?\\s*$`).test(runtime[1])) {
    throw new Error('Unreadable soak runtime path list');
  }
  for (const [, , path] of runtime[1].matchAll(/(['"])([^'"]+)\1/g)) {
    const target = resolve(root, path);
    if (!inside(target)) continue;
    let directory = false;
    try { directory = statSync(target).isDirectory(); } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    if (!directory) add(target);
  }
  while (pending.length) {
    const file = pending.pop();
    if (!SOURCE.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    // Over-approximate: literals in comments/fixtures may widen scope too.
    // `require('.')` and `require('..')` load that folder's index file.
    const isRelative = (specifier) => specifier.startsWith('./') || specifier.startsWith('../')
      || specifier === '.' || specifier === '..';
    const matches = (patterns) => patterns.flatMap((pattern) => [...source.matchAll(pattern)]);
    for (const match of matches(IMPORT_SHAPES)) {
      for (const form of forms(match[2])) {
        if (isRelative(form)) follow(resolve(dirname(file), form));
      }
    }
    // `new URL('data.json', import.meta.url)` is file-relative without a `./` prefix, and so is
    // a same-scheme reference against the `file:` base (`new URL('file:dep.json', base)`).
    for (const match of matches(URL_SHAPES)) {
      for (const form of forms(match[2])) {
        const reference = form.replace(/^file:(?!\/)/i, '');
        if (!/^[a-z][a-z0-9+.-]*:|^\/|\$\{/i.test(reference)) follow(resolve(dirname(file), reference));
      }
    }
    for (const match of matches(LITERAL_SHAPES)) {
      // Non-import literals: file-relative (`setupFiles: ['./x']`, `new URL('../x', import.meta.url)`)
      // and repo-root (spawn/readFile/copy targets, `new URL('./scripts/x', ROOT_URL)`).
      for (const form of forms(match[2])) {
        if (isRelative(form)) follow(resolve(dirname(file), form));
        const path = form.replace(/^\.\//, '');
        if (CODE_ROOT.test(path)) { follow(resolve(root, path)); continue; }
        // Elsewhere only an existing file counts: test fixtures name many fake paths
        // (`backlog/1-x.md`), and a bare folder word (`'docs'`) is not a file dependency.
        // `inside` first: `docs/../../x` names a top-level folder but resolves outside the repo.
        if (!topLevel.has(path.split('/')[0])) continue;
        const target = resolve(root, path);
        if (inside(target) && isFile(target)) add(target);
      }
    }
  }
  return closure;
}

export function soakScopeRun({ root = DEFAULT_ROOT, changed } = {}) {
  try {
    if (!Array.isArray(changed) || changed.some((path) => typeof path !== 'string')) return true;
    // Even with core.quotePath=false, git C-quotes a path holding `"`, `\` or a control
    // character (`"fixture/dep\"s.mjs"`). Such a line never equals a scope key: run the soak.
    if (changed.some((path) => path.startsWith('"'))) return true;
    const closure = computeSoakClosure({ root });
    return changed.some((path) => closure.has(path));
  } catch {
    return true;
  }
}

// Keep the pre-install safeguards executable in CI without npm dependencies.
async function selfTest() {
  const { test } = await import('node:test');
  const assert = await import('node:assert/strict');
  const { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const cli = fileURLToPath(import.meta.url);
  const dependency = 'fixture/dependency.mjs';
  const scopeCase = (name, prepare, changed, expected, check = () => {}) => test(name, () => {
    const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'soak-scope-self-test-'));
    const seed = join(root, 'scripts/conveyor/soak');
    try {
      mkdirSync(seed, { recursive: true });
      mkdirSync(join(root, 'fixture'));
      writeFileSync(join(root, 'vitest.soak.config.ts'), 'export default {};');
      writeFileSync(join(seed, 'red-green.mjs'), "export const RUNTIME_PATHS = Object.freeze(['schemas/rt.json']);");
      writeFileSync(join(root, dependency), 'export const value = true;');
      writeFileSync(join(seed, 'scope.soak.test.mjs'), "import '../../../fixture/dependency.mjs';");
      prepare({ root, seed });
      assert.equal(soakScopeRun({ root, changed: [changed] }), expected);
      const result = spawnSync(process.execPath, [cli], {
        input: `${changed}\n`, encoding: 'utf8', timeout: 25_000,
        maxBuffer: 1024 * 1024, env: { ...process.env, SOAK_SCOPE_ROOT: root },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `run=${expected}\n`);
      check({ root });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await scopeCase('unreadable seed evidence requests the soak', ({ seed }) => {
    rmSync(seed, { recursive: true });
    // A self-referential link deterministically causes ELOOP, even under root.
    symlinkSync('soak', seed, 'dir');
  }, 'backlog/unrelated.md', true);
  await scopeCase('unreadable dependency evidence requests the soak', ({ root }) => {
    rmSync(join(root, dependency));
    symlinkSync('dependency.mjs', join(root, dependency));
  }, 'backlog/unrelated.md', true);
  await scopeCase('deleted dependency outside legacy scope requests the soak', ({ root }) => {
    rmSync(join(root, dependency));
  }, dependency, true);
  await scopeCase('deleted extensionless dependency requests the soak', ({ root, seed }) => {
    writeFileSync(join(seed, 'scope.soak.test.mjs'), "import '../../../fixture/dependency';");
    rmSync(join(root, dependency));
  }, dependency, true);
  // run=true alone cannot tell scanning from executing (a throw also fails open), so check the
  // closure directly and that the dependency's side effect never happened.
  await scopeCase('discovers dependencies without executing their source', ({ root }) => {
    writeFileSync(join(root, dependency), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(join(root, 'executed'))}, 'ran');`,
      "throw new Error('executed');",
      "import'./transitive.mjs';",
    ].join('\n'));
    writeFileSync(join(root, 'fixture/transitive.mjs'), 'export const t = 1;');
  }, 'fixture/transitive.mjs', true, ({ root }) => {
    assert.ok(computeSoakClosure({ root }).has('fixture/transitive.mjs'));
    assert.equal(existsSync(join(root, 'executed')), false);
  });
  await scopeCase('a deleted runtime copy-list file requests the soak', () => {}, 'schemas/rt.json', true);
  await scopeCase('import URL query strings still reach the dependency', ({ seed }) => {
    writeFileSync(join(seed, 'scope.soak.test.mjs'), "import '../../../fixture/dependency.mjs?fresh=1#v';");
  }, dependency, true);
  await scopeCase('an escaped import specifier still reaches the dependency', ({ seed }) => {
    writeFileSync(join(seed, 'scope.soak.test.mjs'), "import '../../../fixture/\\x64ependency.mjs';");
  }, dependency, true);
  await scopeCase('a git-quoted changed path requests the soak', () => {}, '"fixture/dep\\"s.mjs"', true);
  await scopeCase('an unreadable runtime copy list requests the soak', ({ seed }) => {
    writeFileSync(join(seed, 'red-green.mjs'), 'export const RUNTIME_PATHS = computed();');
  }, 'backlog/unrelated.md', true);
  await scopeCase('unrelated changes skip the soak with readable evidence', () => {}, 'backlog/unrelated.md', false);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--gate-phase') {
    const phase = soakGatePhase({ event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF });
    process.stdout.write(`phase=${phase}\n`);
    if (phase === 'refuse') { process.stderr.write('postmerge-phase-unknown: repository maintainers must investigate\n'); process.exitCode = 1; }
    if (phase === 'postmerge' && !/^[12]$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '')) {
      process.stderr.write('postmerge-attempt-exhausted-or-unreadable: keep release held; repository maintainers must investigate and merge a corrective commit\n');
      process.exitCode = 1;
    }
  } else if (process.argv[2] === '--postmerge-receipt') {
    let result;
    try { result = postmergeReceiptGate(JSON.parse(process.env.SOAK_RECEIPT_INPUT)); }
    catch { result = releaseHold('postmerge-producer-input-unreadable'); }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } else if (process.argv[2] === '--self-test') {
    await selfTest();
  } else {
    let run = true;
    try {
      const changed = readFileSync(0, 'utf8').split('\n').filter(Boolean);
      run = soakScopeRun({ root: process.env.SOAK_SCOPE_ROOT || DEFAULT_ROOT, changed });
    } catch { /* Missing stdin is incomplete evidence: run the soak. */ }
    process.stdout.write(`run=${run}\n`);
  }
}
