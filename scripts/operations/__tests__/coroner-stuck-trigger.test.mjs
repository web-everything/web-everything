import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
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

describe('stuck trigger evidence and rendering regressions', () => {
  const observedRounds = () => Array.from({length:8}, (_,i) => ({
    createdAt:`2026-10-01T0${i}:00:00.000Z`, author:{login:'web-everything'},
    body:`🔁 review — changes requested\nRecorded by agent\nfor head \`${String(i).repeat(40)}\`\n### Findings\n**judge/correctness** (1)\n- \`src/a.js:2\` — missing guard`,
  }));

  it.each([
    ['missing state', {state:undefined}],
    ['missing opening time', {openedAt:undefined}],
    ['invalid opening time', {openedAt:'invalid'}],
    ['future opening time', {openedAt:'2027-01-01T00:00:00.000Z'}],
    ['closed PR', {state:'closed'}],
    ['already merged PR', {mergedAt:now}],
    ['incomplete core', {completeness:{core:'incomplete'}}],
    ['unknown core', {completeness:{core:'unknown'}}],
    ['missing core status', {completeness:{}}],
  ])('keeps every trigger unknown for %s even with eight trusted round markers', (_name, patch) => {
    const input = {...raw(), comments:observedRounds(), ...patch};
    expect(evaluateStuckTriggers(input,{now}).map(t => t.status)).toEqual(Array(6).fill('unknown'));
  });

  it('keeps unreadable evidence and invalid clocks unknown despite otherwise firing observations', () => {
    expect(evaluateStuckTriggers(null,{now}).map(t => t.status)).toEqual(Array(6).fill('unknown'));
    const input = {...raw(),comments:observedRounds()};
    expect(evaluateStuckTriggers(input,{now:'invalid'}).map(t => t.status)).toEqual(Array(6).fill('unknown'));
  });

  it('excludes attacker-controlled titles, comments, paths and metadata from rendered reports', () => {
    const hostile = '\u001b[31m$(touch /private/hostile-render-probe)\u0000';
    const input = {...raw(), title:hostile, url:hostile,
      comments:observedRounds().map(c => ({...c,body:`${c.body}\n${hostile}`,url:hostile})),
      commits:[{sha:hostile,commit:{message:hostile}}], files:[{filename:hostile}],
      labels:[{label:{name:hostile}}], warnings:[hostile]};
    const report = buildStuckPostmortem(input,{now});
    expect(report.triggers[1].status).toBe('fired');
    expect(report.markdown).toEqual(buildStuckPostmortem({...raw(),comments:observedRounds()},{now}).markdown);
    expect(report.markdown).not.toMatch(/\u001b|\u0000|\/private\/|touch|hostile-render-probe|missing guard|src\/a\.js/);
    expect(report.markdown).toMatch(/## What would have prevented this\n[\s\S]*48[\s\S]*eight[^#]*$/);
  });

  it('uses the current observation time by default for triggers and reports', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-03T00:00:00.000Z'));
      expect(evaluateStuckTriggers(raw())[0].status).toBe('clear');
      vi.setSystemTime(new Date(now));
      expect(evaluateStuckTriggers(raw())[0].status).toBe('fired');
      const report = buildStuckPostmortem(raw());
      expect(report).toEqual(buildStuckPostmortem(raw(),{now}));
      expect(report.observedAt).toBe(now);
      expect(report.markdown).toContain(`Observed at: ${now}`);
    } finally { vi.useRealTimers(); }
  });
});
