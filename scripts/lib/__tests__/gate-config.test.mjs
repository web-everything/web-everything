/**
 * @file gate-config.test.mjs — regression pins for the TRUST_CHAIN roster (scripts/lib/gate-config.mjs).
 *
 * WHY THIS FILE. The trust-chain roster is basename-matched config: registering a basename forces every PR
 * touching a file of that name to ESCALATE (get an independent review), and — for the POLICY tier — to force
 * `review:human`. The sibling `gate-invariants.test.mjs` proves the SAFETY PROPERTIES of the matcher over the
 * escalation surface (review-escalation.mjs). THIS file pins the ROSTER MEMBERSHIP itself, directly against
 * `gate-config.mjs`: it fails the moment a gate-deciding basename is dropped, so a change that silently
 * un-registers a member cannot pass green.
 *
 * WE #2480 — the phase-1 RESIDENT DRAIN DAEMON (plateau-app/tools/drain-daemon/) shipped the self-hosting
 * coordinator under NEW basenames. Its files that INVOKE the merge or CLEAR a review (daemon.mjs runPass →
 * spawns the sweep; cli.mjs `once` → real merge, `review-set-label` → clears a review; lib.mjs buildPassArgs
 * → merge argv, buildSetLabelArgs → review-clear argv) are gate-deciding and must stay registered as ENGINE
 * tier (escalate + agent-reviewable — they obey the gate the WE child defines, they do not define it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { scoreEscalation, producerReviewLabel } from '../review-escalation.mjs';
import {
  TRUST_CHAIN,
  TRUST_CHAIN_BASENAMES,
  POLICY_CORE_BASENAMES,
  ENGINE_BASENAMES,
  isTrustChainPath,
  isPolicyCorePath,
  isEngineTierPath,
  POLICY_LEASH,
  POLICY_SPEC_BASENAMES,
  POLICY_DERIVATION_BASENAMES,
  isPolicySpecPath,
  isPolicyDerivationPath,
  readPolicySpecRegistryAt,
} from '../gate-config.mjs';

// The phase-1 drain-daemon gate-deciding files (WE #2480). Each maps a registered basename to the shipped
// home path the daemon actually lives at, so the regression proves the basename match TRAVELS to the real
// plateau-app location (not just the bare basename).
const DAEMON_ENGINE_MEMBERS = [
  { file: 'daemon.mjs', home: 'plateau-app/tools/drain-daemon/daemon.mjs', why: 'runPass() spawns the merge sweep' },
  { file: 'cli.mjs', home: 'plateau-app/tools/drain-daemon/cli.mjs', why: '`once` merges; `review-set-label` clears a review' },
  { file: 'lib.mjs', home: 'plateau-app/tools/drain-daemon/lib.mjs', why: 'buildPassArgs (merge argv) + buildSetLabelArgs (review-clear argv)' },
];

describe('TRUST_CHAIN — drain-daemon gate-deciding files are registered (WE #2480)', () => {
  it('every daemon basename is a member of TRUST_CHAIN_BASENAMES', () => {
    for (const { file } of DAEMON_ENGINE_MEMBERS) {
      expect(TRUST_CHAIN_BASENAMES.has(file)).toBe(true);
    }
  });

  it('every daemon basename has a TRUST_CHAIN entry tagged ENGINE tier (obeys the gate, agent-reviewable)', () => {
    for (const { file } of DAEMON_ENGINE_MEMBERS) {
      const entry = TRUST_CHAIN.find((m) => m.file === file);
      expect(entry, `TRUST_CHAIN entry for ${file}`).toBeTruthy();
      expect(entry.tier).toBe('engine');
      expect(entry.desc).toMatch(/2480/); // the registration cites its ticket
    }
  });

  it('daemon files are ENGINE, not POLICY — they escalate but are NOT human-forced', () => {
    for (const { file } of DAEMON_ENGINE_MEMBERS) {
      expect(POLICY_CORE_BASENAMES.has(file)).toBe(false);
    }
  });

  it('the basename match TRAVELS to the shipped plateau-app path — the file escalates there', () => {
    for (const { home } of DAEMON_ENGINE_MEMBERS) {
      expect(isTrustChainPath(home)).toBe(true);  // a PR touching the real path always gets an independent review
      expect(isPolicyCorePath(home)).toBe(false); // engine tier — a converged agent panel may clear it (no human forced)
    }
  });
});

// The conveyor's own dispatch-loop machinery (WE #3401, under epic #3383). Before this, four of these five
// files were absent from TRUST_CHAIN entirely, and the fifth (runner.mjs) only escalated via the generic
// `skills-src/` blast-radius PATTERN (#2909) — agent-clearable but not a portable trust-chain member. Each
// maps a registered basename to its home path so the regression proves the basename match travels to the
// real WE location (not just the bare basename). `skills-src/conveyor/supervisor.mjs` is registered ahead of
// its own landing to `main` — it exists today only on `origin/lane/mechanical-dispatcher`.
const DISPATCH_LOOP_ENGINE_MEMBERS = [
  { file: 'tick-core.mjs', home: 'scripts/conveyor/tick-core.mjs', why: 'planTick decides which agents to spawn' },
  { file: 'dispatch-lane.mjs', home: 'scripts/operations/dispatch-lane.mjs', why: 'starts a real delivery agent unattended' },
  { file: 'dispatch-lane-io.mjs', home: 'scripts/operations/dispatch-lane-io.mjs', why: 'the sink/observer that realizes the dispatch' },
  { file: 'runner.mjs', home: 'skills-src/conveyor/runner.mjs', why: 'the headless runner that drives the loop, unattended' },
  { file: 'supervisor.mjs', home: 'skills-src/conveyor/supervisor.mjs', why: 'keeps the runner alive across crashes' },
];

describe('TRUST_CHAIN — conveyor dispatch-loop gate-deciding files are registered (WE #3401)', () => {
  it('every dispatch-loop basename is a member of TRUST_CHAIN_BASENAMES', () => {
    for (const { file } of DISPATCH_LOOP_ENGINE_MEMBERS) {
      expect(TRUST_CHAIN_BASENAMES.has(file)).toBe(true);
    }
  });

  it('every dispatch-loop basename has a TRUST_CHAIN entry tagged ENGINE tier (obeys the gate, agent-reviewable)', () => {
    for (const { file } of DISPATCH_LOOP_ENGINE_MEMBERS) {
      const entry = TRUST_CHAIN.find((m) => m.file === file);
      expect(entry, `TRUST_CHAIN entry for ${file}`).toBeTruthy();
      expect(entry.tier).toBe('engine');
      expect(entry.leash).toBeUndefined(); // engine members never carry a leash
      expect(entry.desc).toMatch(/3401/); // the registration cites its ticket
    }
  });

  it('dispatch-loop files are ENGINE, not POLICY — they escalate but are NOT human-forced', () => {
    for (const { file } of DISPATCH_LOOP_ENGINE_MEMBERS) {
      expect(POLICY_CORE_BASENAMES.has(file)).toBe(false);
    }
  });

  it('the basename match TRAVELS to the real WE path — the file escalates there', () => {
    for (const { home } of DISPATCH_LOOP_ENGINE_MEMBERS) {
      expect(isTrustChainPath(home)).toBe(true);  // a PR touching the real path always gets an independent review
      expect(isPolicyCorePath(home)).toBe(false); // engine tier — a converged agent panel may clear it (no human forced)
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE POLICY-TIER `leash` SPLIT (#2771 / #2785). The roster is now the single source of truth for TWO
// questions, not one: "is this the policy tier?" (`tier`) and "does it force a human?" (`leash`). These pins
// hold the second one to the ratified classification — the file-by-file table #2771 wrote down.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('TRUST_CHAIN — the declarative-leash / derivation-code split (#2771/#2785)', () => {
  // The exact classification #2771 Fork A ratified, as a table read directly off the roster.
  const RATIFIED = {
    // the DECLARATIVE LEASH — human
    'review-policy.contract.json': 'spec',
    'gate-config.mjs': 'spec',
    'gate-invariants.test.mjs': 'spec',
    'review-policy.conformance.test.mjs': 'spec',
    // the DERIVATION CODE — independent committee
    'review-escalation.mjs': 'code',
    'review-core.mjs': 'code',
    'review-policy.mjs': 'code',
    'disposition-land-seam.mjs': 'code',
    'auto-land-seam.mjs': 'code',
  };
  it('every basename #2771 named carries exactly the leash the ruling gave it', () => {
    for (const [file, leash] of Object.entries(RATIFIED)) {
      const entry = TRUST_CHAIN.find((m) => m.file === file);
      expect(entry, `TRUST_CHAIN entry for ${file}`).toBeTruthy();
      expect(entry.tier).toBe('policy');
      expect(entry.leash, `${file} leash`).toBe(leash);
    }
  });
  it('the derived sets agree with the roster entries, and the matchers agree with the sets', () => {
    for (const [file, leash] of Object.entries(RATIFIED)) {
      expect(POLICY_SPEC_BASENAMES.has(file)).toBe(leash === POLICY_LEASH.SPEC);
      expect(POLICY_DERIVATION_BASENAMES.has(file)).toBe(leash === POLICY_LEASH.CODE);
      expect(isPolicySpecPath(`scripts/lib/${file}`)).toBe(leash === POLICY_LEASH.SPEC);
      expect(isPolicyDerivationPath(`scripts/lib/${file}`)).toBe(leash === POLICY_LEASH.CODE);
      expect(isPolicyCorePath(`scripts/lib/${file}`)).toBe(true); // BOTH halves are still the policy tier
    }
  });
  it('the check:standards contract + conformance suite join the leash by KIND, not by name (#2769)', () => {
    // Registered after #2771 was ratified, so the ruling could not name them — but a contract and a conformance
    // suite are exactly the two artifact kinds #2771 calls declarative leash, so they classify as `spec`.
    for (const file of ['check-standards.contract.json', 'check-standards.conformance.test.mjs']) {
      expect(TRUST_CHAIN.find((m) => m.file === file).leash).toBe(POLICY_LEASH.SPEC);
    }
    // …while the check:standards IMPL stays engine tier and carries no leash at all.
    for (const file of ['check-standards.mjs', 'check-standards-rules.mjs']) {
      const entry = TRUST_CHAIN.find((m) => m.file === file);
      expect(entry.tier).toBe('engine');
      expect(entry.leash).toBeUndefined();
    }
  });
  it('the clearer-identity module joins the leash by its own argument, not #2771\'s original table (#2844/#3045)', () => {
    const entry = TRUST_CHAIN.find((m) => m.file === 'review-independence.mjs');
    expect(entry, 'TRUST_CHAIN entry for review-independence.mjs').toBeTruthy();
    expect(entry.tier).toBe('policy');
    expect(entry.leash).toBe(POLICY_LEASH.SPEC);
    expect(isPolicySpecPath('scripts/lib/review-independence.mjs')).toBe(true);
  });
  it('an unregistered basename is neither half (the split never invents membership)', () => {
    for (const p of ['scripts/pr-land.mjs', 'demos/spa.html', 'scripts/lib/rebase-drop-manifest.mjs']) {
      expect(isPolicySpecPath(p)).toBe(false);
      expect(isPolicyDerivationPath(p)).toBe(false);
    }
  });
});

describe('ENGINE_BASENAMES / isEngineTierPath — #2412 layer 4\'s "is this the lander?" question', () => {
  it('ENGINE_BASENAMES is derived from, and agrees with, every tier:\'engine\' TRUST_CHAIN entry', () => {
    const derived = TRUST_CHAIN.filter((m) => m.tier === 'engine').map((m) => m.file);
    expect(derived.length).toBeGreaterThan(0);
    for (const file of derived) expect(ENGINE_BASENAMES.has(file)).toBe(true);
    expect(ENGINE_BASENAMES.size).toBe(new Set(derived).size);
  });
  it('a known lander file is engine tier', () => {
    expect(isEngineTierPath('scripts/merge-ai-prs.mjs')).toBe(true);
    expect(isEngineTierPath('plateau-app/tools/drain-daemon/daemon.mjs')).toBe(true);
  });
  it('a known POLICY-tier file is NOT engine tier — the two sets are disjoint', () => {
    for (const file of POLICY_CORE_BASENAMES) expect(ENGINE_BASENAMES.has(file)).toBe(false);
    expect(isEngineTierPath('scripts/lib/review-escalation.mjs')).toBe(false);
    expect(isEngineTierPath('scripts/lib/gate-config.mjs')).toBe(false);
  });
  it('an unregistered basename is not engine tier (the roster never invents membership)', () => {
    for (const p of ['scripts/pr-land.mjs', 'demos/spa.html', 'docs/agent/platform-decisions.md']) {
      expect(isEngineTierPath(p)).toBe(false);
    }
  });
  it('the basename match TRAVELS across directories, like the rest of the trust chain', () => {
    expect(isEngineTierPath('packages/plateau-loop/src/merge-ai-prs.mjs')).toBe(true);
  });
});


describe('delivery policy trust boundary (#5113 Part A)', () => {
  describe('shipped human-review surfaces', () => {
    beforeEach(() => vi.stubEnv('WE_HUMAN_REVIEW_SURFACES', undefined));
    afterEach(() => vi.unstubAllEnvs());

    it.each([
      'webeverything.config.json',
      'config/deliveryPolicyDefaults.ts',
      'packages/project/webeverything.config.json',
      'packages/project/config/deliveryPolicyDefaults.ts',
      './webeverything.config.json',
      'config\\deliveryPolicyDefaults.ts',
    ])('%s requires human review with shipped settings and explicit presets', (path) => {
      const edit = path.endsWith('.json')
        ? '-{}\n+{"mergeGate":{"onMainRed":"off"}}'
        : "-    onMainRed: 'halt',\n+    onMainRed: 'off',";
      const diffHunks = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${edit}\n`;
      for (const humanSurfaces of [undefined, 'narrow', 'broad']) {
        for (const hunks of [diffHunks, null]) {
          for (const basis of [{ changedFiles: [path] }, { changedFiles: ['README.md'], humanBasisFiles: [path] }]) {
            const score = scoreEscalation({ ...basis, diffHunks: hunks, humanSurfaces });
            if (humanSurfaces === undefined) expect(score.humanSurfaces.preset).toBe('narrow');
            expect(score.humanRequired, `${path}, preset=${humanSurfaces ?? 'shipped'}, hunks=${hunks !== null}`).toBe(true);
            expect(producerReviewLabel(score)).toBe('review:human');
            expect(score.signals.permissionChange).toContain(path);
          }
        }
      }
    });
  });

  it.each(['webeverything.config.json', 'config/deliveryPolicyDefaults.ts'])('%s alone forces review:human as policy/spec', (path) => {
    const entry = TRUST_CHAIN.find(member => member.file === path.split('/').at(-1));
    expect(entry).toMatchObject({ tier: 'policy', leash: 'spec', homes: [path] });
    expect(isPolicySpecPath(path)).toBe(true);
    expect(producerReviewLabel(scoreEscalation({ changedFiles: [path], humanSurfaces: 'broad' }))).toBe('review:human');
  });

  async function fixture(run) {
    const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'delivery-registry-'));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    const registryPath = join(root, 'scripts/lib/gate-config.mjs');
    try {
      mkdirSync(join(root, 'scripts/lib'), { recursive: true });
      writeFileSync(registryPath, readFileSync(resolve('scripts/lib/gate-config.mjs')));
      writeFileSync(join(root, 'scripts/lib/rules-loader.cjs'), readFileSync(resolve('scripts/lib/rules-loader.cjs')));
      git('init', '--quiet');
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'base registry');
      const base = git('rev-parse', 'HEAD').trim();
      await run({ root, git, registryPath, base });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('a registered pointer target edited alone forces review:human with the root config untouched', async () => {
    await fixture(async ({ root, registryPath }) => {
      writeFileSync(join(root, 'repair-policy.json'), JSON.stringify({ onMainRed: 'off' }));
      writeFileSync(registryPath, readFileSync(registryPath, 'utf8').replace('export const TRUST_CHAIN = [', `export const TRUST_CHAIN = [
        { role: 'fixture-pointer', file: 'repair-policy.json', tier: 'policy', leash: 'spec', homes: ['repair-policy.json'] },`));
      // Run the real rubric with the fixture registry under Node, outside Vite's transform root.
      const rubricPath = resolve('scripts/lib/review-escalation.mjs');
      const require = createRequire(rubricPath);
      const rubricSource = readFileSync(rubricPath, 'utf8')
        .replace(/from '(\.\/[^']+)'/g, (_match, specifier) => {
          const path = specifier === './gate-config.mjs' ? registryPath : resolve('scripts/lib', specifier);
          return `from '${pathToFileURL(path).href}'`;
        })
        .replace("from 'markdown-it'", `from '${pathToFileURL(require.resolve('markdown-it')).href}'`);
      const fixtureRubricPath = join(root, 'scripts/lib/review-escalation.mjs');
      writeFileSync(fixtureRubricPath, rubricSource);
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        const registry = await import(process.argv[1]);
        const rubric = await import(process.argv[2]);
        const changedFiles = ['repair-policy.json'];
        const verdict = rubric.scoreEscalation({ changedFiles, humanSurfaces: 'broad' });
        process.stdout.write(JSON.stringify({
          registered: registry.isPolicySpecPath(changedFiles[0]),
          label: rubric.producerReviewLabel(verdict),
        }));
      `, pathToFileURL(registryPath).href, pathToFileURL(fixtureRubricPath).href], {
        cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      });
      expect(JSON.parse(output)).toEqual({ registered: true, label: 'review:human' });
    });
  });

  it('reads the base registry from a temp copy and never executes the PR registry or dependency', async () => {
    await fixture(async ({ root, registryPath, base }) => {
      const marker = join(root, 'pr-executed');
      const sideEffect = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`;
      writeFileSync(registryPath, `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); ${sideEffect} throw Error('PR registry executed');`);
      writeFileSync(join(root, 'scripts/lib/rules-loader.cjs'), sideEffect);
      const registry = await readPolicySpecRegistryAt(base, { root });
      expect(registry).not.toBeNull();
      expect(registry.has('webeverything.config.json')).toBe(true);
      expect(registry.has('deliveryPolicyDefaults.ts')).toBe(true);
      expect(registry.has('repair-policy.json')).toBe(false);
      expect(existsSync(marker)).toBe(false);
    });
  });

  it('refuses a PR-only registration when the requested base did not register the target', async () => {
    await fixture(async ({ root, registryPath, base }) => {
      writeFileSync(registryPath, readFileSync(registryPath, 'utf8').replace('export const TRUST_CHAIN = [', `export const TRUST_CHAIN = [
        { file: 'repair-policy.json', tier: 'policy', leash: 'spec' },`));
      const registry = await readPolicySpecRegistryAt(base, { root });
      expect(registry?.has('repair-policy.json')).toBe(false);
    });
  });

  it.each([
    ['empty', ''], ['whitespace', ' '], ['undefined', undefined], ['null', null], ['number', 42], ['object', {}], ['option-like', '--help'],
  ])('returns null without throwing for a %s registry ref', async (_name, ref) => {
    await fixture(async ({ root }) => {
      await expect(readPolicySpecRegistryAt(ref, { root })).resolves.toBeNull();
    });
  });

  it('returns null for missing, unreadable, incomplete or oversized base evidence so callers refuse all pointers', async () => {
    await fixture(async ({ root, registryPath, git }) => {
      expect(await readPolicySpecRegistryAt('missing-ref', { root })).toBeNull();
      for (const source of ['throw Error("unreadable");', 'export const POLICY_SPEC_BASENAMES = new Set();', 'export const POLICY_SPEC_BASENAMES = new Set([42]);', `/*${'x'.repeat(1024 * 1024)}*/export const POLICY_SPEC_BASENAMES = new Set(['oversized.json']);`]) {
        writeFileSync(registryPath, source);
        git('add', '.');
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'unreadable registry');
        expect(await readPolicySpecRegistryAt(git('rev-parse', 'HEAD').trim(), { root })).toBeNull();
      }
    });
  });
});
