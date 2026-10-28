/** PR #5964: retirement must honor explicit shadow and fresh per-ref evidence. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareRebuild } from '../../../lib/daemon-rebuild/prepare.mjs';
import { rebuildClone } from '../../../lib/daemon-rebuild.mjs';
import { ACTIVE_BUILD_TOKENS, releaseBuildLease } from '../../../lib/daemon-rebuild/lease.mjs';
import { readRebuildState, writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';
import { addOverlay, overlayFilePath, persistTipShas, readOverlayState, registrationIdentity, removeOverlay, writeOverlays } from '../../../lib/daemon-overlays.mjs';
import { autoRetireOverlays } from '../../../lib/daemon-overlay-auto-retire.mjs';

export default {
  id: 'overlay-auto-retire-evidence',
  title: 'stale overlays preserve registrations and adopted pins without repeating shadow audit',
  card: 'PR #5964',
  fixedBy: { sha: 'pr-5964-repair', where: 'lane/overlay-auto-retire', paths: [
    'scripts/lib/daemon-overlay-auto-retire.mjs', 'scripts/lib/daemon-rebuild/prepare.mjs',
    'scripts/lib/daemon-rebuild/edge-fetch.mjs', 'scripts/lib/daemon-overlays.mjs',
  ] },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/lib/daemon-overlay-auto-retire.mjs'), 'utf8').includes("r.sources.mode === 'tool'")
        && readFileSync(join(root, 'scripts/lib/daemon-rebuild/prepare.mjs'), 'utf8').includes('refEvidence: fetchResult.refEvidence')
        && readFileSync(join(root, 'scripts/lib/daemon-rebuild/prepare.mjs'), 'utf8').includes('plan = unavailablePinned ??')
        && readFileSync(join(root, 'scripts/lib/daemon-overlays.mjs'), 'utf8').includes('expectedRequiredOverlay')
        && readFileSync(join(root, 'scripts/lib/daemon-overlays.mjs'), 'utf8').includes('retiredSources')
        && readFileSync(join(root, 'scripts/lib/daemon-rebuild/prepare.mjs'), 'utf8').includes('supersededSnapshots(overlaysBefore)')
        && readFileSync(join(root, 'scripts/lib/daemon-rebuild/prepare.mjs'), 'utf8').includes('sameRegistration(o, raw)')
        && readFileSync(join(root, 'scripts/lib/daemon-overlay-auto-retire.mjs'), 'utf8').includes('persistTipShas');
    } catch { return false; }
  },
  async run() {
    const root = mkdtempSync(join(tmpdir(), 'overlay-retire-soak-'));
    const violations = [];
    const violation = (invariant, detail) => violations.push({ invariant, detail, daemon: 'rebuild', tick: 0 });
    const env = {
      WE_DAEMON_OVERLAY_DIR: join(root, 'store'), WE_DAEMON_STATE_DIR: join(root, 'state'),
      WE_DAEMON_EVENTS: join(root, 'events.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(root, 'prefs.json'),
      WE_DAEMON_AUTO_REBASE: '0', WE_DAEMON_OVERLAY_AUTO_RETIRE: 'shadow',
      WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'), WE_DAEMON_REBUILD_SKIP_UNRELATED: '0',
    };
    const git = (args) => spawnSync('git', ['-c', 'user.name=Soak', '-c', 'user.email=soak@example.test', ...args], {
      cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    const ok = (...args) => {
      const result = git(args);
      if (result.status !== 0) throw new Error(String(result.stderr));
      return String(result.stdout).trim();
    };
    const commit = (file) => {
      writeFileSync(join(root, file), file);
      ok('add', file); ok('commit', '-qm', file);
      return ok('rev-parse', 'HEAD');
    };
    const prepare = async (run = git) => {
      const prepared = await prepareRebuild({ root, env, run, now: Date.now, mainOnly: false,
        prState: async () => 'OPEN', prBaseChain: async () => [] });
      // These probes stop at planning. Cancel their build leases before the next probe, as rebuildClone
      // does on exit; otherwise a successful probe blocks the next one as rebuild-in-progress.
      if (prepared.lease) {
        try {
          const state = readRebuildState(root, env);
          releaseBuildLease(state, prepared.lease);
          writeRebuildState(root, state, env);
        } finally { ACTIVE_BUILD_TOKENS.delete(prepared.lease.token); }
      }
      return prepared;
    };
    try {
      writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
      ok('init', '-q', '-b', 'main');
      const initial = commit('base');
      ok('update-ref', 'refs/remotes/origin/main', initial);
      const overlays = [{ ref: 'deleted', sha: initial }];
      writeOverlays(root, overlays, { env });
      const refEvidence = new Map([['deleted', 'missing']]);
      const shadow = await autoRetireOverlays({ root, env, overlays, git, refEvidence, now: () => Date.parse('2026-10-29T12:00:00Z') });
      if (shadow.retired.length || readOverlayState(root, { env }).overlays.length !== 1) {
        violation('explicit-shadow-promoted', 'operator shadow removed a registration after the tool graduation date');
      }
      const auditFile = overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl');
      const firstAudit = readFileSync(auditFile, 'utf8');
      await autoRetireOverlays({ root, env, overlays, git, refEvidence });
      if (readFileSync(auditFile, 'utf8') !== firstAudit) {
        violation('shadow-audit-unbounded', 'a second observation appended the same ref, sha and reason');
      }
      env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'on';
      ok('clone', '--bare', '-q', root, join(root, 'origin.git'));
      ok('remote', 'add', 'origin', join(root, 'origin.git'));
      writeOverlays(root, overlays, { env });
      const previousEvents = readFileSync(auditFile, 'utf8').trim().split('\n').length;
      for (const mode of ['off', 'shadow', 'on']) {
        env.WE_DAEMON_OVERLAY_AUTO_RETIRE = mode;
        writeOverlays(root, overlays, { env });
        const prepared = await prepare();
        if (prepared.result?.reason !== 'up-to-date') {
          violation('stale-registration-blocks-main', `${mode}: deleted landed registration blocked preparation (${prepared.result?.reason})`);
        }
      }
      const retiredEvents = readFileSync(auditFile, 'utf8').trim().split('\n').slice(previousEvents).map(JSON.parse);
      if (readOverlayState(root, { env }).overlays.length || !retiredEvents.some((e) => e.by === 'auto-retire' && e.ref === 'deleted')) {
        violation('deleted-landed-overlay-retained', 'a confirmed missing branch with a recorded main commit was not retired');
      }
      // A live remote branch whose fetch fails must not be retired using its stale cached main tip.
      ok('checkout', '-qb', 'feature');
      commit('feature');
      ok('push', '-q', 'origin', 'feature');
      ok('checkout', '-q', 'main');
      ok('update-ref', 'refs/remotes/origin/feature', initial);
      const uncertain = [{ ref: 'feature', sha: initial }];
      writeOverlays(root, uncertain, { env });
      const held = await prepare((args) => args[0] === 'fetch' && args.some((arg) => arg.includes('refs/heads/feature:'))
        ? { status: 1, stderr: 'transient fetch error' } : git(args));
      if (held.result?.reason !== 'up-to-date' || held.result?.plan?.decisions.length
        || !readOverlayState(root, { env }).overlays.some((o) => o.ref === 'feature')) {
        violation('failed-fetch-lost-registration', 'an unconfirmed overlay blocked main, used a cached tip or lost its registration');
      }
      // Containment was proved against this registration, then a different registration took its name.
      ok('checkout', '-qb', 'lower');
      const lower = commit('lower');
      ok('update-ref', 'refs/remotes/origin/lower', lower);
      const top = commit('top');
      ok('update-ref', 'refs/remotes/origin/top', top);
      const stack = [{ ref: 'lower', sha: lower }, { ref: 'top', sha: top }];
      writeOverlays(root, stack, { env });
      const replaced = await autoRetireOverlays({ root, env, overlays: stack, git,
        refEvidence: new Map(stack.map((o) => [o.ref, 'refreshed'])),
        removeOverlay: (r, ref, opts) => {
          writeOverlays(root, [stack[0], { ref: 'top', sha: initial, addedAt: 'replacement' }], { env });
          return removeOverlay(r, ref, opts);
        },
      });
      if (replaced.retired.length || !readOverlayState(root, { env }).overlays.some((o) => o.ref === 'lower')) {
        violation('replaced-container-lost-source', 'the source was removed after its containing registration was replaced');
      }
      // Only lower is on origin. The recorded top contains it but cannot carry this rebuild.
      ok('push', '-q', 'origin', `${lower}:refs/heads/lower`);
      ok('checkout', '-q', 'main');
      writeOverlays(root, stack, { env });
      const available = await prepare();
      if (available.terminal || available.plan?.applied.map((o) => o.ref).join(',') !== 'lower'
        || !readOverlayState(root, { env }).overlays.some((o) => o.ref === 'lower')) {
        violation('missing-container-lost-available-source', 'a missing recorded top retired the refreshed lower overlay out of the rebuild');
      }
      ok('checkout', '-q', 'main');
      const nextMain = commit('main-advanced');
      ok('push', '-q', 'origin', 'main');
      ok('reset', '--hard', initial);
      const stale = [{ ref: 'missing-no-sha' }, { ref: 'unsafe@name' }, { ref: 'feature' }];
      writeOverlays(root, stale, { env });
      const healthy = await prepare();
      if (healthy.terminal || healthy.plan?.mainSha !== nextMain || healthy.plan?.applied.map((o) => o.ref).join(',') !== 'feature'
        || readOverlayState(root, { env }).overlays.length !== stale.length) {
        violation('single-stale-registration-blocks-healthy-overlay', `a deleted no-sha or unsafe registration stopped the healthy overlay plan (${healthy.result?.reason ?? 'non-terminal plan'})`);
      }
      // Adopt a pinned feature, then lose only its refresh while main advances. The running
      // feature must survive the outage, and the next healthy tick must catch up with main.
      writeOverlays(root, [{ ref: 'feature', pinned: true }], { env });
      const rebuild = (run = git) => rebuildClone({ root, env, run,
        runSmoke: async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } }),
        prState: async () => 'OPEN', prBaseChain: async () => [], lockOpts: { waitMs: 2000, pollMs: 20 } });
      const adopted = await rebuild();
      if (!adopted.adopted || readFileSync(join(root, 'feature'), 'utf8') !== 'feature') {
        throw new Error(`pinned fixture was not adopted: ${adopted.reason}`);
      }
      const pinnedHead = ok('rev-parse', 'HEAD');
      const advanced = ok('commit-tree', `${nextMain}^{tree}`, '-p', nextMain, '-m', 'advance main during outage');
      ok('push', '-q', 'origin', `${advanced}:refs/heads/main`);
      const failed = await rebuild((args) => args[0] === 'fetch' && args.some((a) => a.includes('refs/heads/feature:'))
        ? { status: 1, stdout: '', stderr: 'injected refresh failure' } : git(args));
      if (failed.moved || failed.reason !== 'pinned-overlay-unavailable' || ok('rev-parse', 'HEAD') !== pinnedHead
        || readRebuildState(root, env).held?.lastGood !== pinnedHead
        || readFileSync(join(root, 'feature'), 'utf8') !== 'feature'
        || !readOverlayState(root, { env }).overlays.some((o) => o.ref === 'feature' && o.pinned)) {
        violation('failed-refresh-loses-adopted-pin', `expected last-good hold, got ${failed.reason}`);
      }
      const recovered = await rebuild();
      if (!recovered.adopted || readFileSync(join(root, 'feature'), 'utf8') !== 'feature'
        || readRebuildState(root, env).held) {
        violation('pinned-refresh-does-not-recover', `healthy retry failed: ${recovered.reason}`);
      }
    } catch (error) { violation('crash', String(error?.message ?? error)); }
    finally { rmSync(root, { recursive: true, force: true }); }
    await retirementRecovery(violation);
    await retirementRecovery(violation, { rewrite: true });
    await registrationLifecycle(violation);
    await registrationLifecycle(violation, { sequential: true });
    for (const check of await registrationEvidenceReplay()) {
      if (!check.ok) violation(check.name, JSON.stringify(check.observed));
    }
    return { violations };
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};

/** Send-back #5964 replay: real list locks/storage, injected Git evidence, no Git writes or network.
 * Exported so restricted repair lanes can run the same scenario before and after source edits. */
export async function registrationEvidenceReplay() {
  const root = mkdtempSync(join(tmpdir(), 'overlay-registration-replay-'));
  const env = { WE_DAEMON_OVERLAY_DIR: join(root, 'store'), WE_DAEMON_EVENTS: join(root, 'events.jsonl'),
    WE_PLATFORM_PREFERENCES_FILE: join(root, 'prefs.json'), WE_DAEMON_OVERLAY_AUTO_RETIRE: 'shadow' };
  const landed = 'a'.repeat(40), needed = 'b'.repeat(40), mergedTree = 'c'.repeat(40), mainTree = 'd'.repeat(40);
  const checks = [];
  const check = (name, ok, observed) => checks.push({ name, ok, observed });
  const entries = () => readOverlayState(root, { env }).overlays;
  const git = (args) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: args.at(-1).endsWith('^{tree}') ? mainTree
      : args.at(-1).startsWith(needed) ? needed : landed };
    if (args[0] === 'for-each-ref') return { status: 0, stdout: `refs/remotes/origin/feature ${landed}` };
    if (args[0] === 'merge-base') return { status: args[2] === landed ? 0 : 1, stdout: '' };
    if (args[0] === 'cherry') return { status: 0, stdout: `+ ${needed}` };
    if (args[0] === 'merge-tree') return { status: 0, stdout: mergedTree };
    throw new Error(`unexpected Git call ${args[0]}`);
  };
  try {
    writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
    const old = { ref: 'feature', sha: landed, headSha: landed, tipSha: landed,
      adoptedTip: landed, stackBases: ['old-base'], registeredAt: 'old' };
    writeOverlays(root, [old], { env });
    let refreshed;
    await autoRetireOverlays({ root, env, overlays: [old], git, refEvidence: new Map([['feature', 'refreshed']]),
      persistTipShas: (_root, tips) => { refreshed = tips; } });
    check('refresh-carries-registration-identity', refreshed.get('feature')?.reg?.registeredAt === 'old', refreshed.get('feature'));
    addOverlay(root, { ref: 'feature' }, { env });
    const replacementEntry = entries()[0];
    check('reregistration-clears-inherited-evidence',
      ['tipSha', 'sha', 'headSha', 'adoptedTip', 'stackBases'].every((key) => !Object.hasOwn(replacementEntry, key)), replacementEntry);
    const persisted = persistTipShas(root, refreshed, { env });
    check('replacement-rejects-old-refresh', persisted.written === 0 && entries()[0].tipSha === undefined, { persisted, entry: entries()[0] });
    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'on';
    const retired = await autoRetireOverlays({ root, env, overlays: entries(), git, refEvidence: new Map([['feature', 'missing']]) });
    check('missing-replacement-stays-registered', retired.retired.length === 0
      && entries()[0]?.registrationId === replacementEntry.registrationId, { retired: retired.retired, entries: entries() });
    const fresh = persistTipShas(root, new Map([['feature', {
      sha: needed, reg: registrationIdentity(replacementEntry),
    }]]), { env });
    const neededResult = await autoRetireOverlays({ root, env, overlays: entries(), git,
      refEvidence: new Map([['feature', 'missing']]) });
    check('replacement-accepts-only-new-tip', fresh.written === 1 && neededResult.retired.length === 0
      && entries()[0]?.tipSha === needed, { fresh, neededResult, entries: entries() });

    const input = { ref: 'same', now: '2026-10-27T12:00:00Z' };
    const first = addOverlay(root, input, { env }).find((o) => o.ref === 'same');
    const tips = new Map([['same', { sha: landed, reg: registrationIdentity(first) }]]);
    const matching = persistTipShas(root, tips, { env });
    const second = addOverlay(root, input, { env }).find((o) => o.ref === 'same');
    check('same-metadata-reregistration-is-distinct', JSON.stringify(registrationIdentity(first)) !== JSON.stringify(registrationIdentity(second)), { first, second });
    const stale = persistTipShas(root, tips, { env });
    check('matching-only-tip-persistence', matching.written === 1 && stale.written === 0, { matching, stale });

    const noEvidence = addOverlay(root, { ref: 'missing' }, { env }).find((o) => o.ref === 'missing');
    const adoptedFallback = await autoRetireOverlays({ root, env, overlays: [noEvidence], git,
      refEvidence: new Map([['missing', 'missing']]), recordedShas: new Map([['missing', landed]]) });
    check('replacement-rejects-unbound-adopted-tip', adoptedFallback.retired.length === 0
      && entries().some((o) => o.ref === 'missing'), adoptedFallback);

    const oldArchive = { entry: { ref: 'source', sha: landed, retiredSources: [{ entry: { ref: 'nested' }, sha: landed }] }, sha: landed };
    const replacement = { ref: 'source', sha: needed };
    for (const retireInto of [true, false]) {
      writeOverlays(root, [{ ref: 'carrier', retiredSources: [oldArchive] },
        retireInto ? replacement : { ref: 'swap', retiredSources: [{ entry: replacement, sha: needed }] }], { env });
      removeOverlay(root, retireInto ? 'source' : 'swap', { env, requireRef: 'carrier', retireInto, retiredSha: needed });
      const archives = entries()[0].retiredSources;
      removeOverlay(root, 'carrier', { env });
      const restoredSource = entries().find((o) => o.ref === 'source');
      removeOverlay(root, 'source', { env });
      check(`repeated-archive-preserves-nested-source-${retireInto}`, archives.length === 2 && restoredSource?.tipSha === needed
        && entries().some((o) => o.ref === 'nested'), { archives, restoredSource, restored: entries() });
    }

    // Cached and recorded landed tips cannot authorize retirement without this tick's fetch evidence.
    for (const overlay of [{ ref: 'feature' }, { ref: 'gone', sha: landed }]) {
      writeOverlays(root, [overlay], { env });
      const unverified = await autoRetireOverlays({ root, env, overlays: entries(), git });
      check(`omitted-freshness-preserves-${overlay.ref}`, unverified.retired.length === 0
        && entries().some((o) => o.ref === overlay.ref), { retired: unverified.retired, entries: entries() });
    }

    writeOverlays(root, [{ ref: 'gone', sha: landed }], { env });
    const failedEvent = await autoRetireOverlays({ root, env, overlays: entries(), git,
      refEvidence: new Map([['gone', 'missing']]),
      appendDaemonEvent: async () => { throw new Error('injected daemon event failure'); } });
    check('daemon-event-failure-is-reported', entries().length === 0 && failedEvent.retired.length === 1
      && failedEvent.auditFailures[0]?.kind === 'overlay-retired'
      && failedEvent.auditFailures[0]?.error === 'injected daemon event failure', failedEvent);

    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'shadow';
    writeOverlays(root, [old], { env });
    const failedTips = await autoRetireOverlays({ root, env, overlays: entries(), git,
      refEvidence: new Map([['feature', 'refreshed']]), persistTipShas: () => { throw new Error('injected tip failure'); } });
    check('tip-failure-is-reported', failedTips.auditFailures[0]?.kind === 'tip-sha', failedTips.auditFailures);

    env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'off';
    const calls = [];
    const forbidden = (name) => () => { calls.push(name); throw new Error(name); };
    const disabled = await autoRetireOverlays({ root, env, overlays: entries(), git: forbidden('git'),
      appendOverlayEvent: forbidden('audit'), appendDaemonEvent: forbidden('event'),
      removeOverlay: forbidden('remove'), persistTipShas: forbidden('tips') });
    check('off-has-zero-side-effects', calls.length === 0 && disabled.kept.length === 1, { calls, disabled });
    return checks;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** PR #5964 advisory round, 'on' mode: a registration added without a sha retires once its landed branch is
 *  deleted, and a container closed on a later tick leaves the source retired into it registered. */
async function retirementRecovery(violation, { rewrite = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'overlay-retire-on-soak-'));
  const env = {
    WE_DAEMON_OVERLAY_DIR: join(root, 'store'), WE_DAEMON_STATE_DIR: join(root, 'state'),
    WE_DAEMON_EVENTS: join(root, 'events.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(root, 'prefs.json'),
    WE_DAEMON_AUTO_REBASE: '0', WE_DAEMON_OVERLAY_AUTO_RETIRE: 'on',
  };
  const git = (args) => spawnSync('git', ['-c', 'user.name=Soak', '-c', 'user.email=soak@example.test', ...args], {
    cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  const ok = (...args) => {
    const result = git(args);
    if (result.status !== 0) throw new Error(String(result.stderr));
    return String(result.stdout).trim();
  };
  const commit = (file) => {
    writeFileSync(join(root, file), file);
    ok('add', file); ok('commit', '-qm', file);
    return ok('rev-parse', 'HEAD');
  };
  const refs = () => readOverlayState(root, { env }).overlays.map((o) => o.ref).join(',');
  const prepare = async (prState = async () => 'OPEN') => {
    const prepared = await prepareRebuild({ root, env, run: git, now: Date.now, mainOnly: false, prState, prBaseChain: async () => [] });
    if (prepared.lease) {
      try {
        const state = readRebuildState(root, env);
        releaseBuildLease(state, prepared.lease);
        writeRebuildState(root, state, env);
      } finally { ACTIVE_BUILD_TOKENS.delete(prepared.lease.token); }
    }
    return prepared;
  };
  try {
    writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
    ok('init', '-q', '-b', 'main');
    const initial = commit('base');
    ok('checkout', '-qb', 'feature'); commit('feature');
    ok('checkout', '-qb', 'lower', initial); const lower = commit('lower');
    ok('checkout', '-qb', 'top', lower); commit('top');
    ok('checkout', '-q', 'main');
    ok('clone', '--bare', '-q', root, join(root, 'origin.git'));
    ok('remote', 'add', 'origin', join(root, 'origin.git'));
    // A daemon clone already knows origin/main before preparation's local-commit safety check.
    // Creating a bare remote alone leaves this hand-built fixture without any tracking refs.
    ok('fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    addOverlay(root, { ref: 'feature', pr: 1 }, { env });
    addOverlay(root, { ref: 'lower', pr: 2 }, { env });
    addOverlay(root, { ref: 'top', pr: 3 }, { env });
    const first = await prepare();
    if (first.terminal) violation('retirement-preparation-refused', `first preparation stopped before the candidate build (${first.result?.reason})`);
    if (refs() !== 'feature,top') violation('contained-source-not-retired', `expected feature,top after the first tick, got ${refs()}`);
    // feature squash-lands and GitHub deletes its branch; top's PR is closed unmerged on the same tick.
    ok('checkout', '-q', 'feature', '--', 'feature'); ok('commit', '-qm', 'squash feature');
    ok('push', '-q', 'origin', 'main');
    ok('push', '-q', 'origin', '--delete', 'feature');
    // A force push keeps top's PR open but replaces its tree with unrelated content. Both paths must
    // restore lower into THIS preparation's candidate, not merely leave a registration for a later tick.
    if (rewrite) {
      ok('checkout', '-qb', 'rewrite-top', initial);
      const unrelated = commit('unrelated');
      ok('checkout', '-q', 'main');
      ok('push', '-q', '--force', 'origin', `${unrelated}:refs/heads/top`);
    }
    const second = await prepare(async (pr) => (!rewrite && pr === 3 ? 'CLOSED' : 'OPEN'));
    const after = readOverlayState(root, { env }).overlays.map((o) => o.ref);
    if (after.includes('feature')) violation('deleted-landed-branch-never-retires', 'an addOverlay registration stayed after its landed branch was deleted');
    if (!after.includes('lower')) violation('closed-container-loses-retired-source', `lower's open PR content left the registry with its closed container (${after.join(',')})`);
    const candidate = second.plan ?? second.result?.plan;
    if (!candidate?.applied.some((o) => o.ref === 'lower')
      || git(['merge-base', '--is-ancestor', lower, candidate.finalSha]).status !== 0
      || git(['cat-file', '-e', `${candidate.finalSha}:lower`]).status !== 0) {
      violation(rewrite ? 'force-pushed-container-loses-source-in-build' : 'closed-container-loses-source-in-build',
        `the next candidate must carry lower's commit and file (${second.result?.reason ?? 'candidate'})`);
    }
  } catch (error) { violation('crash', String(error?.message ?? error)); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

/** PR #5964 send-back round 13, real Git and real preparation: which registration of a reused ref is current.
 *  1. X/PR1 retires into C1; X is re-registered as PR2 and retires into C2; PR1, C1 and C2 then close. Recovery
 *     must restore X/PR2 from C2, never the obsolete X/PR1 from C1, and the build must proceed — also when C2
 *     closes a tick before C1 (`sequential`): the registered X/PR2 then supersedes C1's X/PR1 archive.
 *  2. Y/PR21 is adopted carrying a mechanism file and squash-lands; Y is re-registered as PR22 with its branch
 *     gone. The new registration must not inherit PR21's adopted pin (no pinned-overlay-unavailable hold). */
async function registrationLifecycle(violation, { sequential = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'overlay-lifecycle-soak-'));
  const env = {
    WE_DAEMON_OVERLAY_DIR: join(root, 'store'), WE_DAEMON_STATE_DIR: join(root, 'state'),
    WE_DAEMON_EVENTS: join(root, 'events.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(root, 'prefs.json'),
    WE_DAEMON_AUTO_REBASE: '0', WE_DAEMON_OVERLAY_AUTO_RETIRE: 'on',
  };
  const git = (args) => spawnSync('git', ['-c', 'user.name=Soak', '-c', 'user.email=soak@example.test', ...args], {
    cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  const ok = (...args) => {
    const result = git(args);
    if (result.status !== 0) throw new Error(String(result.stderr));
    return String(result.stdout).trim();
  };
  const commit = (file) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), file);
    ok('add', file); ok('commit', '-qm', file);
    return ok('rev-parse', 'HEAD');
  };
  const entries = () => readOverlayState(root, { env }).overlays;
  const refs = () => entries().map((o) => o.ref).join(',');
  const closed = new Set();
  const prepare = async () => {
    const prepared = await prepareRebuild({ root, env, run: git, now: Date.now, mainOnly: false,
      prState: async (pr) => (closed.has(pr) ? 'CLOSED' : 'OPEN'), prBaseChain: async () => [] });
    if (prepared.lease) {
      try {
        const state = readRebuildState(root, env);
        releaseBuildLease(state, prepared.lease);
        writeRebuildState(root, state, env);
      } finally { ACTIVE_BUILD_TOKENS.delete(prepared.lease.token); }
    }
    return prepared;
  };
  try {
    writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
    ok('init', '-q', '-b', 'main');
    const initial = commit('base');
    ok('checkout', '-qb', 'x', initial); const pr1 = commit('x-pr1');
    ok('checkout', '-qb', 'c1', pr1); commit('c1');
    ok('checkout', '-q', 'main');
    ok('clone', '--bare', '-q', root, join(root, 'origin.git'));
    ok('remote', 'add', 'origin', join(root, 'origin.git'));
    ok('fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    addOverlay(root, { ref: 'x', pr: 1 }, { env });
    addOverlay(root, { ref: 'c1', pr: 11 }, { env });
    await prepare();
    if (refs() !== 'c1') violation('lifecycle-pr1-not-archived', `expected X/PR1 retired into c1, got ${refs()}`);
    // PR1 is abandoned; PR2 reuses branch x with different content and is carried by C2.
    ok('checkout', '-qB', 'x', initial); const pr2 = commit('x-pr2');
    ok('checkout', '-qb', 'c2', pr2); commit('c2');
    ok('checkout', '-q', 'main');
    ok('push', '-q', '--force', 'origin', 'x', 'c2');
    closed.add(1);
    addOverlay(root, { ref: 'x', pr: 2 }, { env });
    addOverlay(root, { ref: 'c2', pr: 12 }, { env });
    await prepare();
    if (refs() !== 'c1,c2') violation('lifecycle-pr2-not-archived', `expected X/PR2 retired into c2, got ${refs()}`);
    if (sequential) {
      // C2 closes first and X/PR2 comes back from it; C1 closes on a later tick. X/PR2, now registered, is the
      // current X: C1's X/PR1 archive is no longer owed (X/PR2 does not carry it, and it can never be restored).
      closed.add(12);
      const first = await prepare();
      if (refs() !== 'c1,x' || first.result?.reason === 'overlay-source-unavailable') {
        violation('sequential-close-pr2-not-restored', `C2 closing must restore X/PR2 beside C1, got ${refs()} (${first.result?.reason ?? 'candidate'})`);
      }
    }
    closed.add(11); closed.add(12);
    const recovered = await prepare();
    const x = entries().find((o) => o.ref === 'x');
    const plan = recovered.plan ?? recovered.result?.plan;
    if (recovered.result?.reason === 'overlay-source-unavailable' || x?.pr !== 2) {
      violation('obsolete-archive-restored', `closing both carriers restored ${x ? `X/PR${x.pr}` : 'nothing'} (${recovered.result?.reason ?? 'candidate'})`);
    }
    if (!plan?.applied?.some((o) => o.ref === 'x' && o.pr === 2)
      || git(['merge-base', '--is-ancestor', pr2, plan.finalSha]).status !== 0) {
      violation('newest-archive-missing-from-build', `the candidate must carry X/PR2 (${recovered.result?.reason ?? 'candidate'})`);
    }
    if (sequential) return;

    writeOverlays(root, [], { env });
    ok('checkout', '-qb', 'y', initial); const mechanism = commit('scripts/lib/daemon-rebuild.mjs');
    ok('checkout', '-q', 'main');
    ok('push', '-q', 'origin', 'y');
    addOverlay(root, { ref: 'y', pr: 21 }, { env });
    const built = await prepare();
    const builtPlan = built.plan ?? built.result?.plan;
    const input = builtPlan?.applied?.find((o) => o.ref === 'y');
    const pr21 = entries().find((o) => o.ref === 'y');
    if (input?.sha !== mechanism || input.registrationId !== pr21?.registrationId) {
      violation('adopted-input-lacks-registration', `the applied input must name its registration (${JSON.stringify(input)})`);
    }
    // PR21 squash-lands and its branch is deleted; the clone still runs the build that applied it.
    ok('checkout', '-q', 'y', '--', 'scripts/lib/daemon-rebuild.mjs'); ok('commit', '-qm', 'squash y');
    ok('push', '-q', 'origin', 'main');
    ok('push', '-q', 'origin', '--delete', 'y');
    writeRebuildState(root, { ...readRebuildState(root, env), adopted: { head: ok('rev-parse', 'HEAD'),
      mainSha: initial, applied: builtPlan?.applied ?? [], inputsKey: builtPlan?.inputsKey ?? null } }, env);
    closed.add(21);
    addOverlay(root, { ref: 'y', pr: 22 }, { env });
    const reregistered = await prepare();
    if (reregistered.result?.reason === 'pinned-overlay-unavailable') {
      violation('reregistration-inherits-adopted-pin', 'Y/PR22 was held on the mechanism pin of the adopted Y/PR21 input');
    }
    if (entries().find((o) => o.ref === 'y')?.pr !== 22) violation('reregistration-lost', `Y/PR22 left the registry (${refs()})`);
  } catch (error) { violation('crash', String(error?.message ?? error)); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
