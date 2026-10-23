/**
 * @file Injected prototype admission transaction.
 * WHY (incident 2026-10-22): preserve main, reject incomplete evidence, and retain mutable
 * registrations even after adoption: a containment snapshot cannot authorize deleting a moving ref.
 * Real deps bind only in defaultDeps.
 */
import { execFileSync } from 'node:child_process';
import nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlatformPreferences, resolveCascade, formatCascadeSourcesLine } from '../lib/policy-cascade.mjs';
import { cloneKey } from '../lib/daemon-overlays.mjs';
import { safeRef, safeRegistrationRef, validSha, jsonLines, readyEvidence, combinedReadyEvidence, changedPaths, comparePaths, nextMergeRef, refusal } from './prototype-load.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Same request protocol / gated rebuild as daemon-load-overlay, without touching registrations. */
export async function retriggerRegistered({ root, ref, env, by }, deps = {}) {
  const runtime = deps.runtime || await import('../lib/daemon-version-runtime.mjs');
  const ctx = runtime.resolveVersionedContext({ root, env });
  if (ctx) return { source: 'submitRequest', requestId: await runtime.submitRequest(ctx, { ref, by }) };
  const rebuild = deps.rebuild || (await import('../lib/daemon-rebuild.mjs')).rebuildClone;
  return { source: 'rebuildClone', result: await rebuild({ root, env, mainOnly: false }) };
}

/** The sole real IO binding; constructing an injected loader performs no ambient reads. */
export function defaultDeps() {
  return { exec: execFileSync, fs: nodeFs, now: () => Date.now(), sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    env: { ...process.env, HOME: homedir() }, settings: undefined, cloneKey };
}
export function createPrototypeLoader({ exec, fs, now, sleep, env, settings, cloneKey: keyForClone = cloneKey, retrigger = retriggerRegistered }) {
  const expand = (p) => p.startsWith('~/') ? join(env.HOME, p.slice(2)) : p;
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
  const tool = settings || JSON.parse(read(join(repo, 'scripts/settings/prototype-load.json')));
  const platform = readPlatformPreferences({ env, readFile: (p, encoding) => fs.readFileSync(p, encoding) });
  const policy = resolveCascade({ standard: {}, platform: platform.prefs.prototypeLoad, tool });
  const config = policy.value;
  // Explicit allowlist: no operator bypasses, credentials, git config injection or NODE_OPTIONS.
  const childEnv = Object.fromEntries(['HOME', 'PATH', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'XDG_CONFIG_HOME'].filter((key) => typeof env[key] === 'string').map((key) => [key, env[key]]));
  // Keep system Git reachable with a minimal caller PATH (macOS installs it in /usr/bin).
  if (!childEnv.PATH?.split(delimiter).includes('/usr/bin')) {
    childEnv.PATH = [childEnv.PATH, '/usr/bin'].filter(Boolean).join(delimiter);
  }
  // Preserve a stricter caller policy without forwarding overrides that could weaken file policy.
  if (env.WE_OVERLAY_NO_PR?.trim() === 'refuse') childEnv.WE_OVERLAY_NO_PR = 'refuse';
  // A state location is safe configuration, unlike credential or admission-bypass variables.
  if (env.WE_DAEMON_OVERLAY_DIR) childEnv.WE_DAEMON_OVERLAY_DIR = expand(env.WE_DAEMON_OVERLAY_DIR);
  const execute = (command, args) => {
    try { return { code: 0, stdout: String(exec(command, args, { cwd: repo, env: childEnv, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) || '') }; }
    catch (e) { return { code: Number.isInteger(e.status) ? e.status : -1, stdout: String(e.stdout || ''), error: String(e.stderr || e.message || e) }; }
  };
  const git = (...args) => execute('git', args);
  const requireGit = (...args) => { const r = git(...args); if (r.code !== 0) throw new Error(r.error || `git ${args[0]} failed (${r.code})`); return r.stdout.trim(); };
  const ancestor = (tip, sha) => { const r = git('merge-base', '--is-ancestor', tip, sha); if (![0, 1].includes(r.code)) throw new Error(r.error || 'ancestry unverifiable'); return r.code === 0; };
  const loader = (action, clone, ref, extra = []) => execute('node', [resolve(repo, config.loaderCli), action, `--clone=${clone}`, ...(ref ? [`--ref=${ref}`] : []), ...extra, ...(action === 'remove' ? [] : ['--json'])]);
  const lastJson = (r) => { try { return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)); } catch { return null; } };
  const check = (clone, ref, expectedSha) => {
    const result = loader('add', clone, ref, ['--check', ...(expectedSha ? [`--expected-sha=${expectedSha}`] : [])]);
    const data = lastJson(result);
    if (![0, 3].includes(result.code) || data?.check?.ok !== true || typeof data.check.clean !== 'boolean'
      // A clean check carries no `files`/`conflicting` (the loader only adds them on a conflict); default them.
      || (data.check.files !== undefined && (!Array.isArray(data.check.files) || !data.check.files.every((file) => typeof file === 'string')))
      || (data.check.conflicting !== undefined && !Array.isArray(data.check.conflicting))
      || (!data.check.clean && (!Array.isArray(data.check.files) || !Array.isArray(data.check.conflicting)))
      || (expectedSha && data.check.candSha !== expectedSha)
      || result.code !== (data.check.clean ? 0 : 3)) return { ok: false, ...result, reason: data?.check?.reason || 'incomplete loader check' };
    return { files: [], conflicting: [], ...data.check, exit: result.code, wouldRegister: data.wouldRegister };
  };
  return async function load(input) {
    const out = { ok: false, daemon: input.daemon, clone: null, cloneSource: null, registered: false, adopted: false,
      stopReason: null, branch: input.branch, sha: input.sha, effectiveRef: input.branch, effectiveSha: input.sha,
      dryRun: !!input.dryRun, stale: [], removed: [], removedTips: {}, why: input.why || '',
      settings: { sources: policy.sources, values: policy.value, log: formatCascadeSourcesLine('prototypeLoad', policy), errors: platform.errors } };
    let stage = 'bad-input';
    const stop = (reason, details = {}) => { Object.assign(out, details, { stopReason: reason }); return out; };
    // Once the replacement is registered, failures name the retained registrations and explain
    // how to recover if a stale registration prevents the daemon from adopting the replacement.
    const keptNote = () => {
      if (!out.registered) return '';
      const kept = (out.contained || []).filter((ref) => !out.removed.includes(ref));
      const stale = out.adopted ? [] : kept.filter((ref) => out.stale.includes(ref));
      return (kept.length ? ` Prior registrations retained: ${kept.join(', ')}.` : '')
        + (stale.length ? ` If stale registrations block adoption, rebase and retest them, include their new tips in a tested replacement, and rerun: ${stale.join(', ')}.` : '');
    };
    try {
      const daemon = Object.hasOwn(config.daemons || {}, input.daemon) ? config.daemons[input.daemon] : null;
      if (!daemon) return stop('unknown-daemon');
      if (daemon.clone) {
        out.clone = resolve(expand(config.workspaceRoot), expand(daemon.clone));
        out.cloneSource = `settings:prototype-load.json#daemons.${input.daemon}.clone`;
      } else {
        const plist = execute('plutil', ['-convert', 'json', '-o', '-', join(expand(config.launchAgentsDir), `${daemon.label}.plist`)]);
        if (plist.code !== 0) return stop('bad-input', { resolution: plist });
        const wd = JSON.parse(plist.stdout).WorkingDirectory;
        if (typeof wd !== 'string' || !wd.startsWith('/')) return stop('bad-input', { resolution: 'missing absolute WorkingDirectory' });
        out.clone = wd; out.cloneSource = `plist:${daemon.label}`;
      }
      if (!safeRef(input.branch) || !validSha(input.sha) || !Number.isFinite(config.adoption?.timeoutMs) || config.adoption.timeoutMs < 0
        || !Number.isFinite(config.adoption.pollMs) || config.adoption.pollMs <= 0) return stop('bad-input');
      stage = 'no-ready';
      let readyText = null;
      try { readyText = fs.readFileSync(expand(config.readyRecordPath), 'utf8'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const readyRecords = jsonLines(readyText || '');
      out.gate = readyEvidence(readyRecords, input);
      let state, readyRows;
      const statePath = () => state ||= join(expand(env.WE_DAEMON_OVERLAY_DIR || join(env.HOME, '.claude/daemon-overlays')), keyForClone(out.clone));
      if (!out.gate) {
        const strictLines = (text) => String(text || '').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
        strictLines(readyText); // A partial trail cannot establish when records began.
        const events = strictLines(read(`${statePath()}.events.jsonl`));
        // With neither part records nor registration events there is nothing to prove via Git.
        if (!events.some((e) => e?.kind === 'added') && !readyRecords.some((r) => r?.ref !== input.branch && validSha(r?.sha))) return stop('no-ready');
        const listing = loader('list', out.clone);
        readyRows = lastJson(listing)?.list;
        if (listing.code !== 0 || !Array.isArray(readyRows) || readyRows.some((r) => !safeRegistrationRef(r?.ref))) return stop('no-ready', { listing });
        requireGit('fetch', 'origin', input.branch);
        if (requireGit('rev-parse', `origin/${input.branch}`) !== input.sha) return stop('no-ready');
        const parts = [];
        for (const ref of [...new Set(readyRows.map((r) => r.ref))]) {
          if (ref === input.branch) continue;
          requireGit('fetch', 'origin', ref);
          const sha = requireGit('rev-parse', `origin/${ref}`);
          if (!validSha(sha)) return stop('no-ready');
          if (ancestor(sha, input.sha)) parts.push({ ref, sha });
        }
        if (!parts.length && readyRows.some((r) => r.ref === input.branch)) parts.push({ ref: input.branch, sha: input.sha });
        out.gate = combinedReadyEvidence(readyRecords, parts, events, readyText === null);
        if (!out.gate) return stop('no-ready');
      }
      requireGit('fetch', 'origin', input.branch);
      const tip = requireGit('rev-parse', `origin/${input.branch}`);
      if (tip !== input.sha) return stop('no-ready', { gate: { ...out.gate, reason: 'sha-not-branch-tip', tip } });
      stage = 'check-unverifiable';
      requireGit('fetch', 'origin', 'main', input.branch);
      const own = changedPaths(requireGit('diff', '--name-status', '-z', `origin/main...${input.sha}`));
      const contains = ancestor('origin/main', input.sha);
      out.mainCheck = { contains, own };
      let comparison = input.sha;
      if (!contains) {
        const merge = git('merge-tree', '--write-tree', 'origin/main', input.sha);
        if (merge.code === 1) {
          const files = merge.stdout.split(/\r?\n/).flatMap((line) => /^\d{6} [a-f0-9]+ [123]\t(.+)$/.exec(line)?.slice(1) || []);
          return stop('behind-main-conflict', { mainCheck: { ...out.mainCheck, files: [...new Set(files)], evidence: merge.stdout, message: 'Resolve with Codex, retest touched files, write fresh readiness evidence, rerun.' } });
        }
        if (merge.code !== 0) throw new Error(merge.error || 'merge-tree unverifiable');
        const tree = merge.stdout.split(/\r?\n/)[0];
        if (!validSha(tree)) throw new Error('invalid merge tree');
        comparison = tree;
        const ref = nextMergeRef(input.branch, requireGit('ls-remote', 'origin', `${input.branch}-m*`));
        out.wouldMerge = { ref, tree };
        // Prove the resulting tree before publishing it; a refused main guard never pushes.
      }
      const effectivePaths = changedPaths(requireGit('diff', '--name-status', '-z', 'origin/main', comparison));
      const difference = comparePaths(own, effectivePaths);
      out.mainCheck = { ...out.mainCheck, effectivePaths, ...difference };
      if (difference.outside.length || difference.missing.length) return stop('reverts-main', { offendingPaths: difference.outside, missingPaths: difference.missing });
      let priorListing;
      if (out.wouldMerge) {
        priorListing = loader('list', out.clone);
        const priorRows = lastJson(priorListing)?.list;
        if (priorListing.code !== 0 || !Array.isArray(priorRows) || priorRows.some((r) => !safeRegistrationRef(r?.ref))) return stop('check-unverifiable', { listing: priorListing });
        if (priorRows.some((r) => r.ref === input.branch)) out.registered = 'already';
      }
      if (out.wouldMerge && !input.dryRun && out.registered !== 'already') {
        const commit = requireGit('commit-tree', comparison, '-p', 'origin/main', '-p', input.sha, '-m', `Merge origin/main into ${input.branch}`);
        if (!validSha(commit)) throw new Error('invalid merge commit');
        requireGit('push', 'origin', `${commit}:refs/heads/${out.wouldMerge.ref}`);
        out.effectiveRef = out.wouldMerge.ref; out.effectiveSha = commit;
      }
      out.check = check(out.clone, out.effectiveRef, out.effectiveSha);
      const listing = priorListing || loader('list', out.clone);
      const rows = lastJson(listing)?.list;
      if (listing.code !== 0 || !Array.isArray(rows) || rows.some((r) => !safeRegistrationRef(r?.ref))) return stop('check-unverifiable', { listing });
      const established = [...new Set(rows.map((r) => r.ref))];
      const contained = [], blocking = [];
      out.staleChecks = {};
      for (const ref of established.filter((ref) => ref !== out.effectiveRef)) {
        const evidence = check(out.clone, ref);
        out.staleChecks[ref] = evidence;
        if (!evidence.ok) return stop('check-unverifiable');
        if (git('fetch', 'origin', ref).code !== 0) return stop('check-unverifiable', { detail: `could not fetch registered ref ${ref}` });
        const included = ancestor(`origin/${ref}`, out.effectiveSha);
        if (included) contained.push(ref);
        if (!evidence.clean) { out.stale.push(ref); if (!included) blocking.push(ref); }
      }
      out.contained = contained;
      if (blocking.length) return stop('stale-registration', { message: blocking.map((ref) => `stale-registration: ${ref}`).join('; '), blocking });
      if (!out.check.ok) return stop('check-unverifiable');
      if (!out.check.clean) return stop('check-conflict');
      out.swap = { contained };
      if (rows.some((row) => row.ref === out.effectiveRef)) out.registered = 'already';
      if (input.dryRun) {
        out.wouldRegister = out.registered !== 'already'; out.wouldRemove = []; out.wouldRetain = contained;
        if (contained.length) out.wouldStopReason = 'swap-remove-failed';
        out.ok = true; return out;
      }
      stage = 'register-failed';
      const registeredAt = now();
      stage = 'no-ready';
      requireGit('fetch', 'origin', out.effectiveRef);
      const movedTip = requireGit('rev-parse', `origin/${out.effectiveRef}`);
      if (movedTip !== out.effectiveSha) return stop('no-ready', { detail: 'sha-moved', tip: movedTip });
      stage = 'register-failed';
      if (out.registered !== 'already') {
        const result = loader('add', out.clone, out.effectiveRef, [`--expected-sha=${out.effectiveSha}`, `--reason=${input.why || `prototype-load: ${input.daemon} ${out.effectiveRef}`}`, `--by=${env.USER || 'unknown'}`]);
        out.registration = result;
        if (result.code !== 0) return stop('register-failed');
        out.registered = true;
        const evidence = lastJson(result)?.conflictCheck;
        if (evidence?.ok !== true || evidence.clean !== true || evidence.candSha !== out.effectiveSha) {
          return stop('register-failed', { detail: 'admitted-sha-unverified', fallback: 'Inspect the candidate registration and loader evidence before retrying; prior registrations were retained.' });
        }
      }
      const finishSwap = (refs) => {
        for (const ref of refs) {
          // The preview predates the real add (which can fetch newer, cleanly merging tips).
          // Refresh for diagnostic evidence only. Even this immutable SHA cannot prove that
          // the mutable registration still names the same work when a later removal executes.
          out.swap = { contained, removed: out.removed, failed: ref };
          requireGit('fetch', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`);
          const currentTip = requireGit('rev-parse', '--verify', `refs/remotes/origin/${ref}^{commit}`);
          if (!validSha(currentTip)) throw new Error(`invalid current tip for ${ref}`);
          if (!ancestor(currentTip, out.effectiveSha)) {
            return stop('swap-remove-failed', { detail: 'replacement-not-contained', swap: { ...out.swap, tip: currentTip },
              fallback: `Retain the remaining registrations; include their current tips in a new tested replacement and retry.${keptNote()}` });
          }
        }
        out.swap = { contained, removed: out.removed };
        // The loader deletes by name, while branch writers do not hold the registry lock.
        // Neither another fetch nor a registration-identity check can close that race. Until
        // replacement can atomically retire immutable registrations, retain every entry and
        // report an incomplete swap rather than claim that an old SHA was safely removed.
        if (refs.length) return stop('swap-remove-failed', {
          detail: 'mutable-registration', swap: { ...out.swap, retained: refs },
          fallback: `The replacement was adopted, but automatic cleanup cannot safely retire mutable registrations. Keep them registered until their changes land on main and normal rebuild cleanup retires them.${keptNote()}`,
        });
        return null;
      };
      // A stale preview is not proof that the replacement can pass live smoke. Keep every prior
      // registration until adoption; a blocked rebuild times out with recovery guidance below.
      stage = 'check-unverifiable';
      statePath();
      const deadline = registeredAt + config.adoption.timeoutMs;
      // Rebuilds currently emit to the self-sync state directory. Also read the requested overlay
      // sibling trail, so both the loader events and rebuild refusals are observed.
      const rebuildAlerts = join(env.WE_DAEMON_STATE_DIR || join(env.HOME, '.claude/daemon-self-sync-state'), `${basename(state)}.alerts.jsonl`);
      for (;;) {
        const alerts = refusal(jsonLines(read(`${state}.alerts.jsonl`)), out.effectiveRef, registeredAt, true)
          || refusal(jsonLines(read(rebuildAlerts)), out.effectiveRef, registeredAt, true)
          || refusal(jsonLines(read(`${state}.events.jsonl`)), out.effectiveRef, registeredAt);
        if (alerts) return stop('adoption-refused', { adoption: { refusal: alerts }, fallback: `Fix the refused replacement and rerun.${keptNote()}` });
        let probe = git('-C', out.clone, 'merge-base', '--is-ancestor', out.effectiveSha, 'HEAD');
        let missing = false;
        if (probe.code === 128) {
          // A newly admitted commit need not exist in the daemon clone until its next fetch.
          // Quiet verification distinguishes that pending object from execution/repository errors.
          const candidate = git('-C', out.clone, 'rev-parse', '--verify', '--quiet', `${out.effectiveSha}^{commit}`);
          if ([0, 1].includes(candidate.code) && git('-C', out.clone, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}').code === 0) {
            missing = candidate.code === 1;
            // Fetch may have completed between the ancestry failure and diagnostic verification.
            if (!missing) probe = git('-C', out.clone, 'merge-base', '--is-ancestor', out.effectiveSha, 'HEAD');
          }
        }
        out.adoption = { code: probe.code, at: new Date(now()).toISOString(), ...(missing ? { pending: 'candidate-object-missing' } : {}) };
        if (probe.code === 0) { out.adopted = true; break; }
        if (probe.code !== 1 && !missing) return stop('check-unverifiable', { adoption: probe, fallback: `Inspect the daemon clone adoption probe and rerun.${keptNote()}` });
        if (out.registered === 'already' && !out.retrigger) {
          out.retrigger = true;
          out.trigger = await retrigger({ root: out.clone, ref: out.effectiveRef, env: childEnv, by: env.USER || 'unknown' });
          continue;
        }
        const remaining = deadline - now();
        if (remaining <= 0) return stop('adoption-timeout', { fallback: `Check the daemon rebuild for the replacement and rerun.${keptNote()}` });
        await sleep(Math.min(config.adoption.pollMs, remaining));
      }
      stage = 'swap-remove-failed';
      const unswapped = finishSwap(contained);
      if (unswapped) return unswapped;
      out.ok = true;
      return out;
    } catch (e) { return stop(stage, { error: String(e.message || e), fallback: `Inspect the failed step evidence and rerun after resolving it.${keptNote()}` }); }
    finally {
      const record = { at: new Date(now()).toISOString(), ...out };
      try { const file = expand(config.recordPath); fs.mkdirSync(dirname(file), { recursive: true }); fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8'); }
      catch (e) { out.ok = false; out.stopReason ||= 'check-unverifiable'; out.recordError = String(e.message || e); }
    }
  };
}
