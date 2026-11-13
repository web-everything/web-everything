import { it, expect } from 'vitest';
import { phaseAdmissionPlan } from '../verify-remote-routing.mjs';

const guard = "npx vitest run 'scripts/a.test.mjs' 'scripts/b.test.mjs' --reporter=default --reporter=json --outputFile.json='/tmp/we-verify/guard-report.json' --testTimeout=60000 --hookTimeout=60000";

it('the always-run guard phase is planned remote through the nested heavy-admission wrapper', () => {
  const plan = phaseAdmissionPlan({ command: guard, decision: { remote: true } });
  expect(plan.takeLocalSlot).toBe(false);
  expect(plan.command).toContain('node scripts/readiness/heavy-admission.mjs run -- npx vitest run');
  expect(plan.command).toContain("--outputFile.json='/tmp/we-verify/guard-report.json'");
});

it('the guard phase stays local without a remote decision', () => {
  const plan = phaseAdmissionPlan({ command: guard, decision: { remote: false } });
  expect(plan).toMatchObject({ command: guard, takeLocalSlot: true });
});

it('a json report with a config or a second outputFile stays local', () => {
  expect(phaseAdmissionPlan({ command: `${guard} --config vitest.soak.config.ts`, decision: { remote: true } }).takeLocalSlot).toBe(true);
  expect(phaseAdmissionPlan({ command: `${guard} --outputFile.json=/tmp/x.json`, decision: { remote: true } }).takeLocalSlot).toBe(true);
});

// The relaxation is narrow: each of these shapes must keep the segment on the local slot, unchanged.
const stayLocal = command => expect(phaseAdmissionPlan({ command, decision: { remote: true } })).toMatchObject({ command, takeLocalSlot: true });

it('vitest related with a json report stays local', () => {
  stayLocal("npx vitest related 'scripts/a.mjs' --run --reporter=json --outputFile.json='/tmp/we-verify/guard-report.json'");
});

it('an outputFile path containing a .. segment stays local', () => {
  stayLocal(guard.replace("'/tmp/we-verify/guard-report.json'", "'/tmp/we-verify/../guard-report.json'"));
});

it('a relative or unquoted-relative outputFile stays local', () => {
  stayLocal(guard.replace("'/tmp/we-verify/guard-report.json'", "'guard-report.json'"));
  stayLocal(guard.replace("'/tmp/we-verify/guard-report.json'", 'guard-report.json'));
});

it('an outputFile without the json reporter stays local', () => {
  stayLocal(guard.replace(' --reporter=json', ''));
});

it('a quoted option spelling stays local', () => {
  stayLocal(guard.replace('--testTimeout=60000', "'--testTimeout=60000'"));
});
