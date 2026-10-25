import { describe, it, expect } from 'vitest';
import { evaluateStuckTriggers, buildStuckPostmortem } from '../coroner-stuck-trigger.mjs';

const openedAt = '2026-10-01T00:00:00.000Z';
const now = '2026-10-04T00:00:00.000Z';
const raw = () => ({ repo:'example/repo', pr:7, state:'open', openedAt, mergedAt:null,
  comments:[], commits:[], checks:[], labels:[], fixLoop:[], files:[], completeness:{core:'complete'} });
describe('R90 stuck triggers', () => {
  it('fires only above 48 hours, using an injected clock', () => {
    expect(evaluateStuckTriggers(raw(),{now})[0]).toMatchObject({trigger:'open-age',status:'fired'});
    expect(evaluateStuckTriggers(raw(),{now:'2026-10-03T00:00:00.000Z'})[0].status).toBe('clear');
  });
  it.each(['openedAt','state'])('fails closed on missing %s evidence', key => {
    const input = raw(); delete input[key];
    expect(evaluateStuckTriggers(input,{now}).every(t => t.status === 'unknown')).toBe(true);
  });
  it('fails closed on unreadable, incomplete, future, merged, and invalid-clock evidence', () => {
    for (const input of [null,{...raw(),completeness:{core:'incomplete'}},{...raw(),openedAt:'2027-01-01'}, {...raw(),mergedAt:now}])
      expect(evaluateStuckTriggers(input,{now}).every(t => t.status === 'unknown')).toBe(true);
    expect(evaluateStuckTriggers(raw(),{now:'invalid'}).every(t => t.status === 'unknown')).toBe(true);
  });
  it('counts eight distinct observed rounds and rejects spoofed markers', () => {
    const input = raw();
    input.comments = Array.from({length:8},(_,i) => ({createdAt:`2026-10-01T0${i}:00:00.000Z`,author:{login:'web-everything'},
      body:`🔁 review — changes requested\nRecorded by agent\nfor head \`${String(i).repeat(40)}\`\n### Findings\n**judge/correctness** (1)\n- \`src/a.js:2\` — missing guard`}));
    expect(evaluateStuckTriggers(input,{now})[1]).toMatchObject({trigger:'fix-rounds',status:'fired'});
    input.comments.forEach(c => {c.author.login = 'untrusted';});
    expect(evaluateStuckTriggers(input,{now})[1].status).toBe('unknown');
  });
  it('does not infer recurrence, fix causation, daemon reasons, dependencies, or cap hits from prose or proximity', () => {
    const input = raw(); input.comments = [{createdAt:openedAt,author:{login:'web-everything'},body:'already fixed; waiting on PR #4; round cap; daemon idle'}];
    expect(evaluateStuckTriggers(input,{now}).slice(1).map(t => t.status)).toEqual(Array(5).fill('unknown'));
  });
  it('ends deterministic portable reports with evidence-based prevention and never includes hostile PR text', () => {
    const input = {...raw(),title:'\u001b[31m$(touch /private/hostile)'};
    const report = buildStuckPostmortem(input,{now});
    expect(report).toEqual(buildStuckPostmortem(input,{now}));
    expect(report.markdown).toMatch(/## What would have prevented this\n[\s\S]*48/);
    expect(report.markdown).not.toMatch(/\u001b|\/private\/|touch/);
  });
});
