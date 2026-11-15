import { describe, it, expect } from 'vitest';
import { phaseAdmissionPlan, localPhaseReason } from '../verify-remote-routing.mjs';

const fileExists = () => true;
const const pkg = (standards) => () => JSON.stringify({ scripts: { 'test:unit': 'node scripts/readiness/heavy-admission.mjs run -- vitest run', 'check:standards': standards } });
const readPackageJson = pkg('node scripts/readiness/heavy-admission.mjs run -- node scripts/check-standards.mjs');
const plan = (command, read = readPackageJson) => phaseAdmissionPlan({ command, decision: { remote: true }, cwd: '/x', fileExists, readPackageJson: read });

describe('explicit verify gate routing: chain with a check:standards --scope segment', () => {
  it('routes the vitest segment remote and keeps the --scope segment verbatim on its own wrapper', () => {
    const p = plan('npx vitest run a.test.mjs b.test.mjs && npm run check:standards -- --scope=x');
    expect(p.takeLocalSlot).toBe(false);
    expect(p.command).toBe('npm run test:unit -- a.test.mjs b.test.mjs && npm run check:standards -- --scope=x');
  });
  it('a checkout whose check:standards is not self-wrapped keeps the whole chain local (needs the outer slot)', () => {
    const direct = pkg('node scripts/check-standards.mjs');
    expect(plan('npx vitest run a && npm run check:standards -- --scope=x', direct).takeLocalSlot).toBe(true);
    expect(plan('npx vitest run a && npm run check:standards -- --scope=x', () => { throw new Error('unreadable'); }).takeLocalSlot).toBe(true);
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
