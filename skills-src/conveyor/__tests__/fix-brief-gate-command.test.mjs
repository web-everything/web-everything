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

describe('ci-heal load-flake exit', () => {
  it('ci-heal load-flake exit precedes the gate-red exit and preserves the saved heal', () => {
    for (const file of ['fix-agent-brief.md', 'fix-agent-ci-brief.md']) {
      const text = readFileSync(join(HERE, '..', file), 'utf8');
      expect(text).toContain('--reason=load-flake');
      expect(text).toContain('--alt-sha=');
      expect(text).toContain('blocked-on-load-flake');
    }
    const text = readFileSync(join(HERE, '..', 'fix-agent-ci-brief.md'), 'utf8');
    expect(text).toContain('--outcome=gate-red');
    expect(text.indexOf('--reason=load-flake')).toBeLessThan(text.indexOf('--outcome=gate-red'));
    expect(text).toContain('Otherwise a red gate is a hard stop');
  });
});

describe('fix the class', () => {
  it('requires variant discovery, adversarial review, and evidence without deferral', () => {
    const text = readFileSync(join(HERE, '..', 'fix-agent-brief.md'), 'utf8');
    expect(text).toContain('Fix the class, not the instance');
    expect(text).toContain('next variant');
    expect(text).toContain('Variants considered:');
    expect(text).not.toMatch(/dismiss[^.]*\bowed\b/i);
  });
});
