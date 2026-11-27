/** Hermetic T-OPENPR regressions for duplicate labels and nonzero review handoffs. */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { REVIEW_LABELS, REVIEW_LABEL_META, READY_TO_MERGE_LABEL } from '../lib/review-escalation.mjs';
import '../pr-land.mjs'; // Keep the CLI fixture in vitest related's dependency graph.

describe('T-OPENPR skip-push review labels', () => {
  function runPublished({ skipPush = true, remote = 'matching', existing = false, audit = true,
    reviewHead = 'matching', sizeChange = '', lookup = 'ok', lockBusy = false, pushFails = false,
    sha = 'a'.repeat(40), skipFlag = '--skip-push', check = false, dryRun = false,
    labelRun = null } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'pr-land-published-'));
    const trace = join(dir, 'effects.jsonl');
    writeFileSync(trace, '');
    const cli = resolve(__dirname, '../pr-land.mjs');
    const record = `import { appendFileSync } from 'node:fs';
      const effect = value => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value) + '\\n');`;
    const stubs = {
      './operations/canonical-audit-gate.mjs': `${record} export const checkCanonicalAuditForOpen = () => {
        effect(['audit']); return { ok: ${audit}, reason: 'canonical-audit-missing', message: 'run canonical audit' }; };`,
      './lib/lane-verify.mjs': `export const readVerifyMarker = () => null;
        export const verifyGateDecision = () => ({ ok: true });
        export const resolveVerifyOptions = () => ({ requireVerified: true });
        export const repoSlugFromRemote = () => 'fixture/project';
        export const readCiCheckRuns = unexpected, readCiWorkflowRuns = unexpected;`,
      './lib/verify-ci-only.mjs': 'export const ciOnlyDecision = () => null; export const recordCiOnly = unexpected;',
      './lib/verify-lane-gate.mjs': `export const initializeVerifierIdentity = () => ({});
        export const verifySetting = () => 0;
        export const verifyPolicyKey = unexpected, verifyPolicyInputs = unexpected;
        export const verifySettingSource = () => 'fixture', laneRelevantChangeSinceForRecord = () => null;`,
      './lib/soak-precheck-at-open.mjs': `export const soakPrecheckEnabled = () => true;
        export const soakPrecheckAtOpen = () => ({ ok: true, reason: 'fixture' });
        export const parseSoakNameStatus = () => ['README.md'];`,
      './lib/pr-limit.mjs': `export const countOpenPrsForRepo = () => ({ count: 0, limit: 15 });
        export const isBranchAllowedLive = () => false; export const isGlobalOffLive = () => false;
        export const decideOpenPr = () => ({ allowed: true });`,
      './conveyor/fix-procedure.mjs': `${record} export const pushRefusal = () => {
        effect(['claim']); return globalThis.fixtureStage === 'claim-moved' ? { message: 'live fixer owns this branch' } : null;
        }; export const repoKeyForCheckout = () => 'we'; export const callerIdentity = () => ({});`,
      './conveyor/infra-blocked.mjs': `export const originSlugOf = () => 'fixture/project';
        export const classifyPrOpenFailure = unexpected, recordInfraBlockIO = unexpected,
          infraStorePath = unexpected, primaryRootFromClone = unexpected, infraHas = unexpected, readInfraStore = unexpected;`,
      './operations/build-pr-authorship.mjs': 'export const producerBuildContext = () => null; export const checkpointBuildPr = () => {};',
      './lib/gh-app-shim.mjs': `export const defaultShimDir = () => ${JSON.stringify(join(dir, 'shim'))};
        export const resolveOrgAwareShimDir = unexpected, pathWithOrgAwareShim = unexpected;`,
      './lib/gh-stderr-tail.mjs': 'export const ghStderrTail = () => "";',
      './lib/delegation-marker.mjs': `export const DELEGATION_TASK_TYPES = ['build'], DELEGATION_MARKER = '';
        export const buildDelegationMarker = unexpected;`,
      './lane-drain.mjs': 'export const numberPendingHashes = unexpected, isPostLandTreeDirty = unexpected;',
      './readiness/drain-lock.mjs': 'export const withNumberingLock = unexpected;',
      './lib/duplicate-id-tripwire.mjs': 'export const findDuplicateIds = unexpected, summarizeDuplicates = unexpected;',
      './merge-ai-prs.mjs': 'export const computeNetDiffSignals = unexpected; export const recordParkVerdict = () => ({ ok: true });',
      './lib/review-escalation.mjs': `export const REVIEW_LABELS = ${JSON.stringify(REVIEW_LABELS)},
          REVIEW_LABEL_META = ${JSON.stringify(REVIEW_LABEL_META)}, READY_TO_MERGE_LABEL = 'ready-to-merge', ROSTER_TIMING = {};
        export const scoreEscalation = unexpected, parseDeviationDisclosure = unexpected, producerReviewLabel = unexpected,
          shouldApplyReviewLabel = unexpected, reconcileEscalationReasonBlock = unexpected, reconcileRoster = unexpected,
          isReviewHoldLabel = unexpected, readyMergeConflictsWithHold = unexpected, hasUnclearedReviewLabel = unexpected,
          parseReviewedSha = unexpected;`,
      './lib/review-core.mjs': 'export const resolveJuryPlan = unexpected;',
      './lib/review-policy.mjs': 'export const POLICY_CARE_JURY = {};',
      './lib/constellation-repos.mjs': 'export const repoKeyForSlug = () => "we";',
      './readiness/heavy-admission.mjs': 'export const admittedArgv = unexpected;',
      './operations/coordination-root.mjs': `export const resolveCoordinationRoot = () => ${JSON.stringify(dir)};`,
      './lib/verify-shared-marker.mjs': 'export const readSharedGreen = () => null; export const resolveMarkerWithShared = () => null;',
      './lib/lane-verify-deferred.mjs': `export const deferredToCiDecision = () => ({ ok: false });
        export const readDeferredForSha = unexpected, appendDeferredDisclosure = unexpected, syncDeferredBody = unexpected,
          deferredLabelRefusal = unexpected;`,
      './lib/handoff-settings.mjs': 'export const resolveHandoffSettings = unexpected;',
      './lib/approval-record.mjs': 'export const readApprovalRecord = unexpected;',
      './conveyor/main-ci-red-core.mjs': 'export const MAIN_CI_RED_DEFAULTS = {};',
      './lib/pr-size-admission.mjs': `${record} export const createSizeAdmissionRunner = () => async request => {
        effect(['size-admission']); globalThis.fixtureStage = ${JSON.stringify(sizeChange)};
        return { body: request.body, status: 'small' }; };`,
      './lib/forge-land-provider.mjs': `${record}
        export const mergeMethodFlag = unexpected, buildCreateArgs = unexpected,
          buildMergeArgs = unexpected, buildAddLabelArgs = unexpected;
        export const createGhLandProvider = () => ({
          listOpenByHead: () => { effect(['lookup']);
            if (${JSON.stringify(lookup)} === 'throws') throw new Error('lookup unreadable');
            if (${JSON.stringify(lookup)} === 'ambiguous') return [{ number: 7 }, { number: 8 }];
            return ${existing} || globalThis.fixtureCreated ? [{ number: 7 }] : []; },
          create: p => { effect(['create', p]); globalThis.fixtureCreated = true; return 'https://example.invalid/pull/7'; },
          viewPr: (pr, fields) => { effect(['view', pr, fields]); return {
            headRefOid: ${JSON.stringify(reviewHead === 'matching' ? sha : 'b'.repeat(40))},
            state: 'OPEN', headRefName: 'lane/published-fixture', baseRefName: 'main',
            labels: [], comments: [], body: 'Prepared fixture description.' }; },
          ensureLabel: (...args) => effect(['ensure-label', ...args]),
          addLabel: (...args) => effect(['add-label', ...args]),
          editBody: (...args) => effect(['edit-body', ...args]),
          removeLabel: (...args) => effect(['remove-label', ...args]),
        });`,
    };
    if (labelRun) {
      // Exercise the real forge adapter, including its single-write hold/ready swap.
      // Only its gh transport is replaced; every process and mutable input stays in this fixture.
      const provider = pathToFileURL(resolve(__dirname, '../lib/forge-land-provider.mjs')).href;
      stubs['./lib/forge-land-provider.mjs'] = `${record}
        import { createGhLandProvider as makeProvider } from ${JSON.stringify(provider)};
        export { mergeMethodFlag, buildCreateArgs, buildMergeArgs, buildAddLabelArgs } from ${JSON.stringify(provider)};
        const scenario = ${JSON.stringify(labelRun)};
        let labels = ${JSON.stringify(existing ? [READY_TO_MERGE_LABEL] : [])};
        export const createGhLandProvider = ({ cwd }) => makeProvider({ cwd, exec: args => {
          effect(['gh', args]);
          if (args[0] === 'label') {
            effect(['ensure-label', args[2]]);
            const e = new Error('gh label create failed'); e.status = 1;
            e.stderr = Buffer.from(scenario.failure === 'denied' ? 'HTTP 403: forbidden'
              : scenario.failure === 'ambiguous' ? 'label creation result unknown'
              : 'label with name "' + (scenario.failure === 'other-label' ? 'unrelated' : args[2])
                + '" already exists; use --force to update its color and description');
            throw e;
          }
          if (args[1] === 'list') {
            effect(['lookup']); return JSON.stringify(${existing} || globalThis.fixtureCreated ? [{ number: 7 }] : []);
          }
          if (args[1] === 'create') {
            effect(['create']); globalThis.fixtureCreated = true; return 'https://example.invalid/pull/7';
          }
          if (args[1] === 'view') {
            effect(['view', args[2], args[4]]);
            return JSON.stringify({ headRefOid: ${JSON.stringify(sha)}, state: 'OPEN',
              headRefName: 'lane/published-fixture', baseRefName: 'main',
              labels: labels.map(name => ({ name })), comments: [], body: 'Prepared fixture description.',
              mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' });
          }
          if (args[1] === 'checks') {
            effect(['checks']); globalThis.fixtureStage = scenario.handoffChange || '';
            return JSON.stringify([{ bucket: scenario.outcome === 'check-red' ? 'fail' : 'pending' }]);
          }
          if (args[1] === 'edit') {
            const add = args.indexOf('--add-label'), remove = args.indexOf('--remove-label');
            if (add >= 0) { effect(['add-label', args[2], args[add + 1]]); labels.push(args[add + 1]); }
            if (remove >= 0) labels = labels.filter(name => name !== args[remove + 1]);
            effect(['labels-after-edit', labels]); return '';
          }
          throw new Error('unexpected gh: ' + JSON.stringify(args));
        } });`;
      stubs['./merge-ai-prs.mjs'] = `export const recordParkVerdict = () => ({ ok: true });
        export const computeNetDiffSignals = () => ({ scored: true, changedFiles: ['README.md'],
          diffLines: 1, humanBasisFiles: ['README.md'], cumulativeDiffLines: 1, diffHunks: [],
          netDiffText: { scored: true, base: 'fixture-base', rev: ${JSON.stringify(sha)} } });`;
      stubs['./lib/review-escalation.mjs'] = `export const REVIEW_LABELS = ${JSON.stringify(REVIEW_LABELS)},
          REVIEW_LABEL_META = ${JSON.stringify(REVIEW_LABEL_META)}, READY_TO_MERGE_LABEL = 'ready-to-merge', ROSTER_TIMING = {};
        export const scoreEscalation = () => ({ humanRequired: false, reasons: ['fixture escalation'] });
        export const parseDeviationDisclosure = () => null, producerReviewLabel = () => REVIEW_LABELS.pending;
        export const shouldApplyReviewLabel = (label, labels) => !labels.includes(label);
        export const reconcileEscalationReasonBlock = () => ({ changed: false });
        export const reconcileRoster = () => ({ humanAlignmentRequired: false, reasons: [] });
        export const isReviewHoldLabel = label => [REVIEW_LABELS.pending, REVIEW_LABELS.human].includes(label);
        export const hasUnclearedReviewLabel = labels => labels.some(isReviewHoldLabel);
        export const readyMergeConflictsWithHold = labels => labels.includes(READY_TO_MERGE_LABEL) && hasUnclearedReviewLabel(labels);
        export const parseReviewedSha = () => null;`;
    }
    const loader = join(dir, 'loader.mjs');
    const preload = join(dir, 'preload.mjs');
    writeFileSync(loader, `const stubs = ${JSON.stringify(stubs)};
      export async function resolve(specifier, context, next) {
        if (context.parentURL === ${JSON.stringify(pathToFileURL(cli).href)} && stubs[specifier]) {
          return { url: 'data:text/javascript,' + encodeURIComponent(
            'const unexpected = () => { throw new Error("unexpected fixture dependency"); };' + stubs[specifier]), shortCircuit: true };
        }
        return next(specifier, context);
      }`);
    writeFileSync(preload, `import cp from 'node:child_process';
      import { syncBuiltinESMExports, register } from 'node:module';
      ${record}
      const NativeDate = Date;
      globalThis.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [1800000000000])); }
        static now() { return 1800000000000; }
      };
      globalThis.fixtureStage = ''; globalThis.fixtureCreated = false;
      cp.execFileSync = (cmd, args) => {
        effect([cmd, args]);
        if (cmd === 'node') return ''; // independently tested locus lint
        if (cmd !== 'git') throw new Error('unexpected external call: ' + cmd);
        if (args[0] === 'rev-parse') {
          if (args.includes('--git-common-dir') || args.includes('--absolute-git-dir')) return ${JSON.stringify(dir)};
          return globalThis.fixtureStage === 'local-moved' ? 'b'.repeat(40) : ${JSON.stringify(sha)};
        }
        if (args[0] === 'ls-remote') {
          const mode = ${JSON.stringify(remote)};
          if (mode === 'unreadable' || mode === 'timeout') throw new Error(mode === 'timeout' ? 'ETIMEDOUT' : 'remote unavailable');
          if (mode === 'missing') return '';
          if (mode === 'malformed') return 'broken refs/heads/lane/published-fixture';
          if (mode === 'oversized') return 'x'.repeat(65537);
          const oid = mode === 'mismatch' || globalThis.fixtureStage === 'remote-moved'
            || (mode === 'moved-after-create' && globalThis.fixtureCreated) ? 'b'.repeat(40) : ${JSON.stringify(sha)};
          const row = oid + '\\trefs/heads/lane/published-fixture';
          return mode === 'ambiguous' ? row + '\\n' + row : mode === 'wrong-ref' ? oid + '\\trefs/heads/lane/other' : row;
        }
        if (args[0] === 'remote') return 'https://github.com/fixture/project.git';
        if (args[0] === 'log') return 'fix: published fixture';
        if (args[0] === 'diff') return args.includes('-z') ? 'M\\0README.md\\0' : 'README.md';
        if (args[0] === 'push') { if (${pushFails}) throw new Error('push rejected'); return ''; }
        if (args[0] === 'show') throw new Error('fixture has no manifest');
        throw new Error('unexpected git: ' + args.join(' '));
      };
      cp.execSync = cp.spawnSync = cp.spawn = cp.exec = cp.execFile = () => { throw new Error('unexpected process'); };
      syncBuiltinESMExports(); register(${JSON.stringify(pathToFileURL(loader).href)});`);
    if (lockBusy) mkdirSync(join(dir, 'open-pr-submit.lock'));
    try {
      const child = spawnSync(process.execPath, ['--import', preload, cli, `--repo=${dir}`,
        '--ref=lane/published-fixture', '--title=fix: published fixture', '--body=Prepared fixture description.',
        ...(labelRun?.mode === 'escalation' ? ['--no-wait']
          : labelRun?.mode === 'label-on-green' ? ['--label-on-green', '--timeout-min=-1'] : ['--park=review:pending']),
        '--json', ...(skipPush ? [skipFlag] : []),
        ...(check ? ['--check'] : []), ...(dryRun ? ['--dry-run'] : [])], {
        cwd: dir, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
        env: { PATH: dirname(process.execPath), HOME: dir, TMPDIR: dir, WE_COORDINATION_ROOT: dir,
          WE_POLICY_CASCADE_LOG: '0', WE_REVIEW_LEDGER_MODE: 'off' },
      });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.signal, child.stderr).toBeNull();
      expect(child.stdout.trim(), child.stderr).not.toBe('');
      const effects = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      return { status: child.status, result: JSON.parse(child.stdout.trim()), effects,
        pushes: effects.filter(([cmd, args]) => cmd === 'git' && args[0] === 'push'),
        writes: effects.filter(([cmd]) => ['create', 'add-label', 'edit-body', 'remove-label', 'ensure-label'].includes(cmd)) };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it.each(['park', 'escalation'])('skip-push %s tolerates an existing label and atomically replaces reused PR clearance with a hold', mode => {
    const { status, result, effects, pushes } = runPublished({ existing: true, labelRun: { mode } });
    expect(status).toBe(0);
    expect(result).toMatchObject({ reason: mode === 'park' ? 'parked' : 'opened', reviewLabel: REVIEW_LABELS.pending, reviewLabelApplied: true });
    expect(pushes).toEqual([]);
    const swaps = effects.filter(([cmd, args]) => cmd === 'gh' && args.includes('--add-label'));
    expect(swaps).toHaveLength(1);
    expect(swaps[0][1]).toEqual(['pr', 'edit', '7', '--add-label', REVIEW_LABELS.pending, '--remove-label', READY_TO_MERGE_LABEL]);
    expect(effects.filter(([cmd]) => cmd === 'labels-after-edit').at(-1)).toEqual(['labels-after-edit', [REVIEW_LABELS.pending]]);
  });
  it.each(['denied', 'ambiguous', 'other-label'])('skip-push refuses %s label creation evidence without applying the hold', failure => {
    const { status, result, writes } = runPublished({ existing: true, labelRun: { mode: 'park', failure } });
    expect(status).toBe(3);
    expect(result).toMatchObject({ reason: 'gh-error', incomplete: true });
    expect(result.detail).toContain('submission-write-unconfirmed');
    expect(writes.map(([cmd]) => cmd)).toEqual(['ensure-label']);
  });
  it.each(['check-red', 'check-timeout'])('skip-push %s still hands the opened PR off with review:pending', outcome => {
    const { status, result, writes, pushes } = runPublished({ labelRun: { mode: 'label-on-green', outcome } });
    expect(status).toBe(outcome === 'check-red' ? 2 : 3);
    expect(result).toMatchObject({ reason: outcome, pr: 7, handOffLabel: REVIEW_LABELS.pending });
    expect(writes.map(([cmd]) => cmd)).toEqual(['create', 'ensure-label', 'add-label']);
    expect(pushes).toEqual([]);
  });
  it('skip-push handoff refuses changed live remote evidence after the check read', () => {
    const { status, result, writes } = runPublished({ labelRun: {
      mode: 'label-on-green', outcome: 'check-red', handoffChange: 'remote-moved',
    } });
    expect(status).toBe(3);
    expect(result).toMatchObject({ reason: 'pr-head-mismatch', incomplete: true });
    expect(result.detail).toContain('remote-ref-mismatch');
    expect(writes.map(([cmd]) => cmd)).toEqual(['create']);
  });

});
