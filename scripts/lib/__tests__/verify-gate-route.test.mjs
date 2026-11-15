import { describe, it, expect } from 'vitest';
import { phaseAdmissionPlan, localPhaseReason } from '../verify-remote-routing.mjs';

const fileExists = () => true;
const readPackageJson = () => JSON.stringify({ scripts: { 'test:unit': 'node scripts/readiness/heavy-admission.mjs run -- vitest run' } });
const plan = (command) => phaseAdmissionPlan({ command, decision: { remote: true }, cwd: '/x', fileExists, readPackageJson });

describe('explicit verify gate routing: chain with a check:standards --scope segment', () => {
  it('routes the vitest segment remote and keeps the --scope segment verbatim on its own wrapper', () => {
    const p = plan('npx vitest run a.test.mjs b.test.mjs && npm run check:standards -- --scope=x');
    expect(p.takeLocalSlot).toBe(false);
    expect(p.command).toBe('npm run test:unit -- a.test.mjs b.test.mjs && npm run check:standards -- --scope=x');
  });
  it('a --scope segment with a non-vitest unknown segment stays local', () => {
    const p = plan('echo hi && npm run check:standards -- --scope=x');
    expect(p.takeLocalSlot).toBe(true);
  });
  it('a --scope value with shell metacharacters stays local', () => {
    expect(plan('npx vitest run a && npm run check:standards -- --scope=x;rm').takeLocalSlot).toBe(true);
    expect(plan('npx vitest run a && npm run check:standards -- --scope=x --evil').takeLocalSlot).toBe(true);
  });
  it('an unknown shape is still logged as raw-command', () => {
    expect(localPhaseReason('echo hi && ls', { cwd: '/x', fileExists })).toBe('raw-command');
  });
});
