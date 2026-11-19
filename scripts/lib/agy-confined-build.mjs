/** R1062/S7: sandbox-exec enforced filesystem confinement plus patch/transcript checks.
 * The launcher alone applies admitted hunks; agy's git operations remain forbidden. */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { escapingSymlinks, gitControlFiles, snapshotCheckout, changedControl, changedCheckouts,
  stateChangingToolCalls, READ_ONLY_AGY_TOOLS, scrubPaths, MODULE_REPO_ROOT } from './agy-review-juror.mjs';
import { buildScratchCloneArgv, summarizeAgyEvents, runAgyDirectExec } from '../gemini-direct-task.mjs';
import { AGY_STATE_WRITE_DIRS, buildSandboxEnv, buildSandboxProfile, sandboxedSpawnArgv, sandboxSecretPaths } from './agy-sandbox.mjs';
import { readAgyHold, saveAgyHold } from './antigravity-run-evidence.mjs';
import { resolveCascade, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { isAdmissibleTargetPath } from './agy-fix-admission.mjs';
import { fenceUntrusted, FENCED_DATA_RULE } from './mandate-fence.mjs';

// The juror's SAFE_GIT is private; keep its pins at every git boundary, including injected exec.
const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false',
  '-c', 'core.attributesFile=/dev/null', '-c', 'core.pager=cat', '-c', 'diff.external='];
const DEFAULTS = { allowedKinds: ['doc-fix', 'test-fix'], maxSize: 1, kindMaxSize: 3 };
// Measured live 2026-11-18 (agy 1.5.11): the native edit tool is `edit_file` and the plain read is `read_file`, both with a `Path` parameter.
const WRITE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'edit_file']);
// `read_file` needs the same required, clone-contained path as a write, so it takes the same rewrite-and-audit route.
const PATH_CHECKED_READS = new Set(['read_file']);
const inScope = (p, scope) => scope.some(s => p === s || p.startsWith(`${s}/`));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Plain filesystem evidence only: never resolve attacker-controlled git routing with git.
// Missing optional controls are recorded; unreadable, redirected or special controls throw.
function cloneGitControls(clone) {
  const out = {};
  const record = (rel, type, recursive = false) => {
    const path = join(clone, rel);
    let st;
    try { st = lstatSync(path); }
    catch (e) { if (e.code !== 'ENOENT') throw e; out[rel] = null; return; }
    if (st.isSymbolicLink() || (type === 'dir' ? !st.isDirectory()
      : type === 'file' ? !st.isFile() : !st.isDirectory() && !st.isFile()))
      throw new Error('unsafe clone git control');
    out[rel] = st.isDirectory() ? `dir:${st.dev}:${st.ino}:${st.mode}`
      : `${st.mode}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    if (recursive && st.isDirectory())
      for (const name of readdirSync(path).sort()) record(`${rel}/${name}`, 'any', true);
  };
  record('.git', 'dir');
  if (out['.git'] === null) throw new Error('missing clone git directory');
  for (const p of ['info', 'objects', 'objects/info', 'refs']) record(`.git/${p}`, 'dir');
  for (const p of ['commondir', 'HEAD', 'config', 'info/attributes', 'info/exclude', 'objects/info/alternates', 'shallow'])
    record(`.git/${p}`, 'file');
  for (const p of ['worktrees', 'modules', 'refs/replace', 'hooks']) record(`.git/${p}`, 'dir', true);
  record('.gitattributes', 'file');
  return out;
}
const defaultExec = (bin, args, opts) => {
  try { return execFileSync(bin, args, opts); }
  catch (e) { if (opts.diffExit && e.status === 1) return String(e.stdout); throw e; }
};

// Absent denied directories still need a canonical rule: resolve the nearest existing ancestor.
// Unreadable paths and broken symlinks fail closed rather than silently dropping a deny rule.
function canonicalPath(path) {
  if (!isAbsolute(path) || /["\\\x00-\x1f\x7f-\x9f]/.test(path)) throw new Error('unsafe sandbox path');
  try { return realpathSync(path); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    try { lstatSync(path); throw new Error('unresolved sandbox symlink'); }
    catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
    return join(canonicalPath(dirname(path)), basename(path));
  }
}

export async function defaultSpawnAgy(options) {
  const homeDir = realpathSync(homedir());
  const temp = realpathSync(tmpdir());
  const requested = options.cli ?? 'agy';
  const candidates = isAbsolute(requested) ? [requested]
    : (process.env.PATH ?? '').split(':').filter(isAbsolute).map(p => join(p, requested));
  const executable = candidates.find(p => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } });
  if (!executable) throw new Error('agy executable unavailable; use another provider or request operator review');
  const cli = realpathSync(executable);
  const profileDir = mkdtempSync(join(temp, 'we-agy-sandbox-'));
  try {
    const workspaceDir = canonicalPath(join(homeDir, 'workspace'));
    if ([options.dir, options.laneDir, workspaceDir, join(homeDir, 'workspace')].some(p => profileDir === p || profileDir.startsWith(`${canonicalPath(p)}/`)))
      throw new Error('sandbox profile must be outside clone, lane and workspace');
    // A redirected log root would grant writes beyond the measured real-HOME directory.
    for (const rel of AGY_STATE_WRITE_DIRS) {
      const path = join(homeDir, rel);
      if (canonicalPath(path) !== path)
        throw new Error('agy log directory is redirected; use another provider or request operator review');
    }
    const privateTempDir = mkdtempSync(join(profileDir, 'tmp-'));
    const profile = buildSandboxProfile({ transcriptDir: realpathSync(dirname(options.logFile)), cloneDir: realpathSync(options.dir), homeDir, privateTempDir,
      laneDir: realpathSync(options.laneDir), workspaceDir, agyBinDir: dirname(cli),
      homebrewPrefix: cli.match(/^(.*)\/(?:Cellar|Caskroom)\//)?.[1],
      workspaceOps: canonicalPath(join(homeDir, 'workspace/.operations')),
      deniedPaths: sandboxSecretPaths(homeDir).map(canonicalPath) });
    const profileFile = join(profileDir, 'profile.sb');
    writeFileSync(profileFile, profile, { mode: 0o600, flag: 'wx' });
    return await runAgyDirectExec({ ...options, exclusiveLog: true, cli, readHold: readAgyHold, saveHold: saveAgyHold, spawnFn: (bin, args, opts) => {
      const [, ...argv] = sandboxedSpawnArgv(profileFile, [bin, ...args]);
      return spawn('/usr/bin/sandbox-exec', argv, { ...opts,
        env: buildSandboxEnv(process.env, privateTempDir, homeDir) });
    } });
  } finally { rmSync(profileDir, { recursive: true, force: true }); }
}

// Reclassify ONLY known native file edits for the juror's path-containment check. Unknown tools,
// shell commands and malformed parameters remain state-changing and therefore void the build.
function auditTranscript(text, clone) {
  const lines = text.trim().split('\n');
  const events = lines.map(line => JSON.parse(line)); // partial/malformed evidence is never enough
  const results = events.filter(e => e?.event === 'result');
  const terminal = results[0]?.result;
  if (results.length !== 1 || events.at(-1) !== results[0] || !terminal || Array.isArray(terminal)
    || terminal.status !== 'SUCCESS' || typeof terminal.response !== 'string' || terminal.error
    || [terminal.is_error, results[0].is_error].some(v => v !== undefined && v !== false)
    || [terminal.subtype, results[0].subtype].some(s => s !== undefined && s !== 'success'))
    throw new Error('incomplete or unsuccessful terminal transcript');
  for (const event of events) {
    const s = event?.step_update;
    if (s?.step_type !== 'tool') continue;
    const name = s.tool_name ?? s.tool_info?.name;
    if (/git/i.test(name ?? '') || /\bgit\b/i.test(JSON.stringify(s.tool_info?.parameters ?? {}))
      && /command|shell|exec/i.test(name ?? '')) throw new Error('agy git call');
    if (!WRITE_TOOLS.has(name) && !PATH_CHECKED_READS.has(name) && !READ_ONLY_AGY_TOOLS.includes(name))
      throw new Error('tool call outside the permitted native file tools');
    // Status never exempts a tool update from the containment audit.
    delete s.tool_info?.error;
    delete s.status;
    delete s.state;
    if (!WRITE_TOOLS.has(name) && !PATH_CHECKED_READS.has(name)) continue;
    const params = typeof s.tool_info?.parameters === 'string'
      ? JSON.parse(s.tool_info.parameters) : s.tool_info?.parameters;
    if (!params || Array.isArray(params) || typeof params !== 'object'
      || !Object.entries(params).some(([k, v]) => /^(TargetFile|AbsolutePath|FilePath|Path)$/i.test(k)
        && typeof v === 'string' && v.length)) throw new Error('opaque write parameters');
    // Keep ALL parameters: nested/alternative path keys must pass the same containment test too.
    s.tool_name = 'view_file';
    s.tool_info = { ...s.tool_info, name: 'view_file', parameters: params };
  }
  // Audit every update separately: a later update must not hide an earlier outside path by
  // reusing its step index, changing its parameters, or reporting an error afterwards.
  const updates = events.filter(e => e?.step_update?.step_type === 'tool').map((e, i) => ({
    ...e, event: 'step_update', step_update: { ...e.step_update, step_index: i, conversation_id: 'build-audit' },
  }));
  if (stateChangingToolCalls(updates.map(e => JSON.stringify(e)).join('\n'), { allowedRoots: [clone] }).length)
    throw new Error('tool call outside the permitted native file tools or clone');
  return events;
}

export async function runConfinedAgyBuild({ task, laneDir, scope, kind, size, model, effort, deps = {} } = {}) {
  const { exec = defaultExec, readFile = p => readFileSync(p, 'utf8'), env = process.env,
    spawnAgy = defaultSpawnAgy, mkTempDir = mkdtempSync,
    platform = process.platform, sandboxExists = existsSync,
    removeDir = p => rmSync(p, { recursive: true, force: true }), log = console.error } = deps;
  let clone, transcriptDir;
  const result = (status, reasons = [], extra = {}) => ({ status, applied: [],
    reasons: reasons.map(r => scrubPaths(r, [clone, laneDir, MODULE_REPO_ROOT, tmpdir()])
      .replace(/[\x00-\x1f\x7f]/g, ' ')), ...extra });
  // Strip inherited git routing/config injection; source checkout config is never copied by clone.
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' });
  const git = (args, opts = {}) => String(exec('git', [...SAFE_GIT, ...args], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024, env: gitEnv, ...opts,
  }));
  const snapExec = (_bin, args) => git(args);
  try {
    let settings;
    try { settings = JSON.parse(readFile(join(MODULE_REPO_ROOT, 'scripts/settings/agy-build.json'))); }
    catch { return result('refused', ['agy build settings missing or unreadable; ask the operator to repair settings']); }
    if (!settings || Array.isArray(settings) || typeof settings !== 'object') return result('refused', ['invalid agy build settings']);
    const resolved = resolveCascade({ standard: DEFAULTS, tool: settings,
      envValues: {
        allowedKinds: env.WE_AGY_BUILD_KINDS === undefined ? undefined : env.WE_AGY_BUILD_KINDS.split(',').map(s => s.trim()),
        maxSize: env.WE_AGY_BUILD_MAX_SIZE === undefined ? undefined
          : env.WE_AGY_BUILD_MAX_SIZE.trim() ? Number(env.WE_AGY_BUILD_MAX_SIZE) : NaN,
        kindMaxSize: env.WE_AGY_BUILD_KIND_MAX_SIZE === undefined ? undefined
          : env.WE_AGY_BUILD_KIND_MAX_SIZE.trim() ? Number(env.WE_AGY_BUILD_KIND_MAX_SIZE) : NaN,
      }, valid: { allowedKinds: v => Array.isArray(v) && v.length > 0 && v.every(k => typeof k === 'string' && /^[a-z][a-z0-9-]*$/.test(k)),
        kindMaxSize: v => Number.isInteger(v) && v > 0,
        maxSize: v => typeof v === 'number' && Number.isFinite(v) && v >= 0 } });
    log(formatCascadeSourcesLine('agyBuild', resolved));
    if (resolved.invalid.length || typeof kind !== 'string' || !kind.trim() || !Number.isFinite(size) || size < 0
      || !Array.isArray(scope) || !scope.length || scope.length > 20 || !Array.from(scope).every(isAdmissibleTargetPath)
      || typeof laneDir !== 'string' || !laneDir.trim() || typeof task !== 'string' || !task.trim())
      return result('refused', ['missing or invalid kind/size/scope/task/lane; use another fix provider or request human review']);
    if (!(resolved.value.allowedKinds.includes(kind) && size <= resolved.value.kindMaxSize)
      && size > resolved.value.maxSize)
      return result('refused', ['kind and size exceed agy build admission; use another fix provider or request operator review']);
    if (spawnAgy === defaultSpawnAgy && (platform !== 'darwin' || !sandboxExists('/usr/bin/sandbox-exec')))
      return result('refused', [
      'Antigravity build requires macOS sandbox-exec; use another fix provider or request human review',
    ]);
    laneDir = resolve(laneDir);
    const before = { [laneDir]: snapshotCheckout(laneDir, snapExec) };
    if (before[laneDir].unreadable) return result('refused', ['real lane snapshot unreadable']);
    clone = mkTempDir(join(tmpdir(), 'we-agy-build-'));
    if (resolve(clone) === laneDir || resolve(clone).startsWith(`${laneDir}/`))
      return result('refused', ['scratch clone must be outside the real lane']);
    const argv = buildScratchCloneArgv({ repoRoot: laneDir, dest: clone });
    argv.splice(1, 0, '--no-hardlinks', '--template=');
    git(argv);
    const startHead = git(['-C', clone, 'rev-parse', 'HEAD']).trim();
    if (startHead !== before[laneDir].head) return result('refused', ['lane HEAD changed during clone']);
    if (escapingSymlinks(clone).length) return result('refused', ['clone contains escaping symlinks']);
    const control = cloneGitControls(clone);
    const cloneGit = (args, opts = {}) => git(args, { ...opts, env: { ...gitEnv,
      GIT_DIR: join(clone, '.git'), GIT_COMMON_DIR: join(clone, '.git'), GIT_WORK_TREE: clone,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
    } });
    // Launcher-owned sibling of the clone and sandbox temp; never grant worker writes here.
    transcriptDir = realpathSync(mkdtempSync(join(tmpdir(), 'we-agy-transcript-')));
    chmodSync(transcriptDir, 0o700);
    const transcriptFile = join(transcriptDir, 'agy-build.jsonl');
    let outcome, spawnError;
    try {
      outcome = await spawnAgy({ dir: clone, laneDir, model, effort, logFile: transcriptFile, stream: false,
        task: `Implement the repair described by the task data. Use only native file tools inside this checkout. Never run shell commands or git. ${FENCED_DATA_RULE}\n${fenceUntrusted('task', task)}\nAllowed paths: ${JSON.stringify(scope)}` });
    } catch (e) { spawnError = e; }
    const reasons = [];
    if (!same(control, cloneGitControls(clone)))
      return result('voided', ['clone git controls changed; use another fix provider or request human review']);
    const controls = { [laneDir]: gitControlFiles(laneDir) };
    if (changedControl(before, controls).length) reasons.push('real lane git controls changed');
    else if (changedCheckouts(before, { [laneDir]: snapshotCheckout(laneDir, snapExec) }).length)
      reasons.push('real lane changed during agy run');
    let events;
    try {
      const transcript = readFile(transcriptFile);
      // Require the on-disk evidence to match the launcher's captured stream.
      if (typeof outcome?.stdout !== 'string' || transcript !== outcome.stdout) throw new Error('transcript differs from captured stream');
      events = auditTranscript(transcript, clone);
    }
    catch { reasons.push('missing, unreadable or unsafe transcript (including git calls)'); }
    if (escapingSymlinks(clone).length) reasons.push('clone contains escaping symlinks after run');
    // Do not invoke git after detecting changed controls or incomplete escape evidence.
    if (reasons.length) return result('voided', reasons);
    if (cloneGit(['-C', clone, 'rev-parse', 'HEAD']).trim() !== startHead) return result('voided', ['clone HEAD moved']);
    if (spawnError || outcome?.code !== 0 || outcome?.timedOut) return result('failed', ['agy build failed; use the next fix provider']);
    const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-renames'];
    const raw = cloneGit(['-C', clone, 'diff', '--raw', '-z', ...diffFlags, startHead]).split('\0');
    const paths = [];
    const rejectPath = p => !isAdmissibleTargetPath(p) || !inScope(p, scope);
    for (let i = 0; i < raw.length && raw[i]; i += 2) {
      const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([AMD])$/.exec(raw[i]);
      const p = raw[i + 1];
      if (!match || rejectPath(p)) return result('voided', ['unsafe or out-of-scope changed path']);
      const [, oldMode, newMode] = match;
      if (![oldMode, newMode].every(m => ['000000', '100644', '100755'].includes(m))
        || oldMode !== '000000' && newMode !== '000000' && oldMode !== newMode)
        return result('voided', ['symlink, submodule or mode change rejected']);
      paths.push(p);
    }
    let patch = cloneGit(['-C', clone, 'diff', '--binary', ...diffFlags, startHead]);
    const untracked = cloneGit(['-C', clone, 'ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    for (const p of untracked) {
      if (rejectPath(p)) return result('voided', ['unsafe or out-of-scope untracked path']);
      const st = lstatSync(join(clone, p));
      if (!st.isFile() || st.isSymbolicLink()) return result('voided', ['untracked symlink or special file rejected']);
      patch += cloneGit(['diff', '--no-index', '--binary', ...diffFlags, '--', '/dev/null', p], { cwd: clone, diffExit: true });
      paths.push(p);
    }
    if (/^(GIT binary patch|Binary files )/m.test(patch)) return result('voided', ['binary diff rejected']);
    // A dirty lane is allowed, but an intervening edit and any apply conflict fail atomically.
    if (changedControl(before, { [laneDir]: gitControlFiles(laneDir) }).length
      || changedCheckouts(before, { [laneDir]: snapshotCheckout(laneDir, snapExec) }).length)
      return result('voided', ['real lane changed before apply']);
    if (patch) git(['-C', laneDir, 'apply', '--whitespace=nowarn',
      ...scope.flatMap(s => [`--include=${s}`, `--include=${s}/*`]), '-'], { input: patch });
    const summary = summarizeAgyEvents(events);
    return result('ok', [], { applied: [...new Set(paths)], finalMessage: summary.finalResponse || summary.agentMessages.at(-1) || '', stdout: outcome.stdout ?? '' });
  } catch {
    return result('voided', ['confinement or atomic apply evidence failed; use another fix provider or request human review']);
  } finally {
    try { if (clone) removeDir(clone); }
    finally { if (transcriptDir) rmSync(transcriptDir, { recursive: true, force: true }); }
  }
}
