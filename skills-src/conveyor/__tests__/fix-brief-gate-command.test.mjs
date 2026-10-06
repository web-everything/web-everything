/**
 * @file skills-src/conveyor/__tests__/fix-brief-gate-command.test.mjs
 * @description Brief-lint (#4369): every verify-lane command a fix / ci-heal brief tells its agent to run must be
 *   one the agent's own guard permits for that dispatch kind, and step 4 must key its red branch to the `check`
 *   output. Fails if a brief names a command `dispatchedAgentVerificationReason` denies.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dispatchedAgentVerificationReason } from '../../../scripts/guard-bash.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function fill(text) {
  return text.replace(/\{\{WE_ROOT\}\}/g, '/we').replace(/\{\{GATE_COMMAND\}\}/g, 'node /we/scripts/verify-lane.mjs run --repo=.');
}

function fencedCommands(text) {
  const cmds = [];
  for (const m of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of m[1].split('\n')) {
      const cmd = line.replace(/\s+#.*$/, '').trim();
      if (cmd) cmds.push(cmd);
    }
  }
  return cmds;
}

for (const [file, kind] of [['fix-agent-brief.md', 'fix'], ['fix-agent-ci-brief.md', 'ci-heal']]) {
  describe(`${file} — gate commands vs the ${kind} guard`, () => {
    const filled = fill(readFileSync(join(HERE, '..', file), 'utf8'));
    const gateLines = fencedCommands(filled).filter((c) => /verify-lane|test:unit|heavy-admission/.test(c));

    it('names a verify-lane request and a check in its bash fences', () => {
      expect(gateLines.some((c) => /verify-lane\.mjs request\b/.test(c))).toBe(true);
      expect(gateLines.some((c) => /verify-lane\.mjs check --wait=540000 --json\b/.test(c))).toBe(true);
    });

    it('no gate/verify command in a bash fence is denied for this kind', () => {
      for (const c of gateLines) expect(dispatchedAgentVerificationReason(c, kind), c).toBeNull();
    });

    it('keys the red branch to the `check` output, not the request call', () => {
      const step4 = filled.split(/### 4\./)[1].split(/### 5\./)[0];
      expect(step4).toMatch(/`check` output/);
      expect(step4).toMatch(/`red` \(exit 2\)/);
    });
  });
}

for (const file of ['fix-agent-brief.md', 'fix-agent-ci-brief.md', 'delivery-agent-brief.md']) {
  it(`${file} instructs bounded waits that are feasible inside the Bash tool's foreground timeout`, () => {
    const text = readFileSync(join(HERE, '..', file), 'utf8');
    const waits = [...text.matchAll(/check --wait=(\d+)/g)].map((m) => Number(m[1]));
    const toolTimeouts = [...text.matchAll(/`timeout: (\d+)`/g)].map((m) => Number(m[1]));
    expect(waits.length).toBeGreaterThan(0);
    expect(toolTimeouts.length).toBeGreaterThan(0);
    // A wait longer than the tool's own timeout is killed before it can settle: every instructed wait must fit.
    for (const wait of waits) expect(wait).toBeLessThan(Math.min(...toolTimeouts));
    // …and the chunks must cover the dispatcher's admission + execution budget (~160 minutes), stated in the brief.
    expect(text).toMatch(/18 consecutive `timeout`s/);
    expect(Math.max(...waits) * 18).toBeGreaterThanOrEqual(150 * 60_000);
    expect(text).not.toMatch(/--wait=9600000|--wait=60000|completion\s+notification/);
    expect(text).toContain('infrastructure-failure');
  });
}

const readBrief = (file) => readFileSync(join(HERE, '..', file), 'utf8');

/** The literals of `required` that `text` does not contain — the brief-lint core, mutation-checked below. */
const missing = (text, required) => required.filter((literal) => !text.includes(literal));

/**
 * Assert every literal is present in the real brief text, and that removing any ONE of them is detected — so each
 * guard is proven to redden on a mutated brief, not just to pass on today's wording.
 */
function expectEachGuarded(text, required) {
  expect(missing(text, required)).toEqual([]);
  for (const literal of required) expect(missing(text.replaceAll(literal, ''), required), `dropping "${literal}"`).toEqual([literal]);
}

const REVERIFY_WORKER = 'Only `web-everything/web-everything` has a reverify worker';

// The exit's three eligibility conditions (failures only outside the change, each passing alone, a repo that has a
// reverify worker) plus the tokens and the fallback — dropping any one tells an agent to hand off a genuinely failing
// change, or to wait on a worker that does not exist.
const LOAD_FLAKE_REQUIRED = {
  'fix-agent-brief.md': [
    'red ONLY on timeouts',
    'pass alone',
    REVERIFY_WORKER,
    'so use the gate-red exit below there',
    'FULL 40-character head sha',
    '--reason=load-flake',
    '--alt-sha=',
    'blocked-on-load-flake',
  ],
  'fix-agent-ci-brief.md': [
    'red ONLY on failures in files your heal did not touch',
    'each of those files passes when run alone',
    REVERIFY_WORKER,
    'for any other repo use the gate-red exit below',
    'FULL 40-character head sha',
    '--reason=load-flake',
    '--alt-sha=',
    'blocked-on-load-flake',
  ],
};

/** The "Load-flake exception." paragraph, up to its bash fence — so a literal elsewhere in the brief cannot satisfy a guard. */
function loadFlakeParagraph(text) {
  const start = text.indexOf('**Load-flake exception.**');
  expect(start, 'brief has a Load-flake exception paragraph').toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf('```bash', start));
}

describe('ci-heal load-flake exit', () => {
  for (const [file, required] of Object.entries(LOAD_FLAKE_REQUIRED)) {
    it(`${file} states every load-flake eligibility condition, each guarded against removal`, () => {
      const text = readBrief(file);
      const paragraph = loadFlakeParagraph(text);
      // Conditions live in the paragraph; the command tokens live in the fence that follows it.
      expectEachGuarded(paragraph, required.filter((l) => !/^(--|blocked-on)/.test(l)));
      expect(text).toContain('--reason=load-flake');
      expect(text).toContain('--alt-sha=');
      expect(text).toContain('blocked-on-load-flake');
    });
  }

  it('ci-heal load-flake exit precedes the gate-red exit and preserves the saved heal', () => {
    const text = readBrief('fix-agent-ci-brief.md');
    expect(text).toContain('--outcome=gate-red');
    expect(text.indexOf('--reason=load-flake')).toBeLessThan(text.indexOf('--outcome=gate-red'));
    expect(text).toContain('Otherwise a red gate is a hard stop');
    // The exit is only safe under its three eligibility conditions: this ordering test must redden if any is dropped,
    // not only the dedicated eligibility test above (the paragraph precedes the command, which precedes the hard stop).
    const paragraph = loadFlakeParagraph(text);
    expectEachGuarded(paragraph, [
      'files your heal did not touch',
      'passes when run alone',
      REVERIFY_WORKER,
    ]);
    expect(text.indexOf(paragraph)).toBeLessThan(text.indexOf('--reason=load-flake'));
    expect(text.indexOf('--reason=load-flake')).toBeLessThan(text.indexOf('Otherwise a red gate is a hard stop'));
  });
});

// Each normative sentence's distinctive literal is asserted positively; a `not.toMatch` alone passes whether or not
// the sentence exists, so it can never be the guard.
const FIX_THE_CLASS_REQUIRED = [
  'Fix the class, not the instance',
  'next variant',
  'is must-fix before re-push',
  'You may dismiss a self-review finding only as "not the same class" or "outside `{{SCOPE}}`',
  'Deferring ("later", "follow-up") is not a dismissal.',
  'Variants considered:',
];

describe('fix the class', () => {
  it('requires variant discovery, adversarial review, and evidence without deferral', () => {
    expectEachGuarded(readBrief('fix-agent-brief.md'), FIX_THE_CLASS_REQUIRED);
  });

  it('does not restore the old "fix it, or dismiss it with a one-line reason" loophole', () => {
    expect(readBrief('fix-agent-brief.md')).not.toMatch(/fix it, or dismiss it/i);
  });
});
