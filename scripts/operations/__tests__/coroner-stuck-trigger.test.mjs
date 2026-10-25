import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { evaluateStuckTriggers, buildStuckPostmortem } from '../coroner-stuck-trigger.mjs';
import { classifyEvent, normalizeComment } from '../coroner-rounds.mjs';
import { buildPostmortem } from '../coroner-pr-postmortem.mjs';
import { buildFixBeginComment, buildFixEndComment } from '../../conveyor/fix-procedure.mjs';

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

describe('R90 structured timeline evidence (implementation pending)', () => {
  const at = hour => new Date(Date.parse(openedAt) + hour * 3600000).toISOString();
  const head = round => String(round).repeat(40);
  const comment = (hour, body) => ({ createdAt:at(hour), author:{login:'web-everything'}, body });
  const key = JSON.stringify(['judgeCorrectnessAdvisory', 'src/a.js', 2, 'missing guard']);
  const referral = (round, findingKey = key) => comment(round * 3,
    `Mandatory review owner: 7 (correctness).\nAttempt recorded: true. Rulings: ${JSON.stringify([{key:findingKey,result:'block'}])}\n<!-- mandatory-referrals-v1: ${encodeURIComponent(JSON.stringify({version:1,head:head(round)}))} -->`);
  const repair = round => [
    comment(round * 3 + 1, `🔒 conveyor fix-begin\n**Who:** \`fixer\`\n**Branch:** \`lane/test\` at \`${head(round)}\``),
    comment(round * 3 + 2, '🔓 conveyor fix-end\n`fixer` released'),
  ];
  const returned = count => ({...raw(), comments:Array.from({length:count}, (_, i) =>
    [referral(i + 1), ...(i < count - 1 ? repair(i + 1) : [])]).flat()});
  const review = (round, category = 'breaks-change') => comment(round * 3,
    `🔁 review — changes requested\nRecorded by agent\nfor head \`${head(round)}\`\n### Findings\n**judge/${category}** (1)\n- \`src/round-${round}.js:2\` — guard regression`);
  const status = (input, trigger) => evaluateStuckTriggers(input,{now}).find(t => t.trigger === trigger).status;
  // buildPostmortem currently requires a merged endpoint. Use the observation time
  // only to inspect its structured output; evaluateStuckTriggers gets the open input.
  const postmortem = input => buildPostmortem({...input,mergedAt:now});

  it('fires recurrence when the identical finding key returns blocked after two repairs', () => {
    const input = returned(3);
    expect(classifyEvent(normalizeComment(input.comments[0]))).toMatchObject({
      type:'round', trigger:'referral-block', rulings:[{file:'src/a.js',line:2,claim:'missing guard',result:'block'}],
    });
    expect(postmortem(input).rounds.map(r => r.fixSessions.length)).toEqual([1,1,0]);
    expect(status(input,'recurrence')).toBe('fired');
  });

  it('fires recurrence using production fix comments with abbreviated repair heads', () => {
    const input = {...raw(),comments:[1,2,3].flatMap(round => [
      referral(round),
      ...(round < 3 ? [
        comment(round * 3 + 1, buildFixBeginComment({who:'fixer',branch:'lane/test',headSha:head(round)})),
        comment(round * 3 + 2, buildFixEndComment({who:'fixer',headSha:head(round + 1)})),
      ] : []),
    ])};
    const triggers = evaluateStuckTriggers(input,{now:at(24)});
    expect(triggers.find(t => t.trigger === 'recurrence').status).toBe('fired');
    expect(triggers.filter(t => t.status === 'fired').map(t => t.trigger)).toEqual(['recurrence']);
    expect(buildStuckPostmortem(input,{now:at(24)}).markdown).toContain('- recurrence: fired');
  });

  it.each([7,9,12,40])('matches completed repairs recorded with %i-character heads', length => {
    const input = returned(3);
    for (const round of [1,2]) {
      const begin = input.comments[(round - 1) * 3 + 1];
      begin.body = begin.body.replace(head(round),head(round).slice(0,length));
    }
    expect(status(input,'recurrence')).toBe('fired');
  });

  it.each(['different','missing','ambiguous'])('does not count %s repair heads as recurrence evidence', variant => {
    const input = returned(3);
    for (const round of [1,2]) {
      const repairHead = variant === 'missing' ? null : variant === 'different' ? 'f'.repeat(40) : head(round);
      input.comments[(round - 1) * 3 + 1] = comment(round * 3 + 1,
        buildFixBeginComment({who:'fixer',branch:'lane/test',headSha:repairHead}));
      if (variant === 'ambiguous') {
        const collision = referral(round,JSON.stringify(['judgeCorrectnessAdvisory','src/other.js',2,'other finding']));
        collision.body = collision.body.replace(encodeURIComponent(JSON.stringify({version:1,head:head(round)})),
          encodeURIComponent(JSON.stringify({version:1,head:head(round).slice(0,9) + 'f'.repeat(31)})));
        input.comments.push(collision);
      }
    }
    expect(status(input,'recurrence')).toBe('clear');
  });

  it.each([123,{},'1'])('ignores malformed unrelated referral heads during repair resolution: %j', invalidHead => {
    const input = returned(3), malformed = referral(4);
    malformed.body = malformed.body.replace(encodeURIComponent(JSON.stringify({version:1,head:head(4)})),
      encodeURIComponent(JSON.stringify({version:1,head:invalidHead})));
    input.comments.push(malformed);
    expect(status(input,'recurrence')).toBe('fired');
  });

  it.each([1,2])('clears recurrence with complete evidence and only %i appearances of the key', count => {
    expect(status(returned(count),'recurrence')).toBe('clear');
  });

  it('clears recurrence when three blocked keys have different claims despite identical locations', () => {
    const input = {...raw(),comments:[1,2,3].flatMap(i => [
      referral(i,JSON.stringify(['judgeCorrectnessAdvisory','src/a.js',2,`distinct claim ${i}`])),
      ...(i < 3 ? repair(i) : []),
    ])};
    expect(status(input,'recurrence')).toBe('clear');
  });

  it('does not count duplicate referral comments on one head as two recurrences', () => {
    const input = returned(2);
    input.comments.push(referral(2),referral(2));
    expect(status(input,'recurrence')).toBe('clear');
  });

  it.each([0,1])('clears recurrence after three identical blocks with only %i completed repairs', completed => {
    const input = {...raw(),comments:[1,2,3].flatMap(i => [
      referral(i), ...(i < 3 ? (i <= completed ? repair(i) : [repair(i)[0]]) : []),
    ])};
    expect(status(input,'recurrence')).toBe('clear');
  });

  it('clears recurrence when the full finding identity differs only in its judge', () => {
    const input = {...raw(),comments:[1,2,3].flatMap(i => [
      referral(i,JSON.stringify([`judge-${i}`,'src/a.js',2,'missing guard'])),
      ...(i < 3 ? repair(i) : []),
    ])};
    expect(status(input,'recurrence')).toBe('clear');
  });

  it('compares recurrence claims beyond the display parser truncation boundary', () => {
    const input = {...raw(),comments:[1,2,3].flatMap(i => [
      referral(i,JSON.stringify(['judgeCorrectnessAdvisory','src/a.js',2,`${'x'.repeat(240)} distinct ${i}`])),
      ...(i < 3 ? repair(i) : []),
    ])};
    expect(status(input,'recurrence')).toBe('clear');
  });

  it.each(['recurrence','fix-causation'])('keeps %s unknown when one unreadable event accompanies sufficient valid evidence', trigger => {
    const input = trigger === 'recurrence' ? returned(3) : {...raw(),comments:[review(1),review(2),review(3)]};
    input.comments.push({...review(4,'correctness'),createdAt:'invalid'});
    expect(status(input,trigger)).toBe('unknown');
  });

  it('keeps fix-causation unknown when malformed finding groups interrupt qualifying rounds', () => {
    const malformed = review(3);
    malformed.body = malformed.body.replace('**judge/breaks-change** (1)','**judge/breaks-change** (invalid)');
    expect(status({...raw(),comments:[review(1),review(2),malformed,review(4)]},'fix-causation')).toBe('unknown');
  });

  it('fires fix-causation for explicit breaks-change findings in three consecutive rounds', () => {
    const input = {...raw(),comments:[review(1),...repair(1),review(2),...repair(2),review(3)]};
    expect(postmortem(input).rounds.map(r => r.causes)).toEqual(Array.from({length:3}, () =>
      [{cause:'review-finding',lens:'judge',theme:'breaks-change'}]));
    expect(status(input,'fix-causation')).toBe('fired');
  });

  it.each([1,2])('clears fix-causation below three consecutive breaks-change rounds (%i)', count => {
    expect(status({...raw(),comments:Array.from({length:count}, (_, i) => review(i+1))},'fix-causation')).toBe('clear');
  });

  it('clears fix-causation when a different finding theme interrupts three breaks-change rounds', () => {
    expect(status({...raw(),comments:[review(1),review(2),review(3,'correctness'),review(4)]},'fix-causation')).toBe('clear');
  });

  it('does not count duplicate reviews on one head as consecutive causation rounds', () => {
    expect(status({...raw(),comments:[review(1),review(1),review(1)]},'fix-causation')).toBe('clear');
  });

  it.each(['recurrence','fix-causation'])('keeps %s unknown when structured evidence is absent', trigger => {
    expect(status(raw(),trigger)).toBe('unknown');
  });

  it.each(['recurrence','fix-causation'])('keeps %s unknown for unauthenticated otherwise sufficient markers', trigger => {
    const input = trigger === 'recurrence' ? returned(3) : {...raw(),comments:[review(1),review(2),review(3)]};
    input.comments = input.comments.map(c => ({...c,author:{login:'untrusted'}}));
    expect(status(input,trigger)).toBe('unknown');
  });

  it.each(['recurrence','fix-causation'])('keeps %s unknown for malformed event timestamps', trigger => {
    const input = trigger === 'recurrence' ? returned(3) : {...raw(),comments:[review(1),review(2),review(3)]};
    input.comments = input.comments.map(c => ({...c,createdAt:'invalid'}));
    expect(status(input,trigger)).toBe('unknown');
  });

  it('keeps recurrence unknown for malformed finding keys', () => {
    expect(status({...raw(),comments:[referral(1,'{'),...repair(1),referral(2,'{'),...repair(2),referral(3,'{')]},'recurrence')).toBe('unknown');
  });

  it('keeps fix-causation unknown for malformed finding groups', () => {
    const comments = [review(1),review(2),review(3)].map(c => ({...c,body:c.body.replace('**judge/breaks-change** (1)','**judge/breaks-change** (invalid)')}));
    expect(status({...raw(),comments},'fix-causation')).toBe('unknown');
  });

  it('never fires from recurrence or breaks-change prose alone', () => {
    const input = {...raw(),comments:[1,2,3].map(i => comment(i,
      'same finding key returned unfixed; already fixed claim proven false; breaks-change'))};
    expect(status(input,'recurrence')).toBe('unknown');
    expect(status(input,'fix-causation')).toBe('unknown');
  });

  it('keeps two round-cap claims unknown without structured cap-hit records', () => {
    // Missing source: classifyEvent has no cap-hit event; buildPostmortem has
    // no cap-hit count. A fixLoop park reason does not identify a review round cap.
    const input = {...raw(),comments:[comment(1,'round cap hit'),comment(2,'round cap hit')],
      fixLoop:[1,2].map(i => ({v:1,repo:'example/repo',pr:7,kind:'park',head:head(i),at:at(i),reason:'round cap hit'}))};
    expect(status(input,'fix-rounds')).toBe('unknown');
  });

  it('keeps two allegedly disproven already-fixed claims unknown without adjudication records', () => {
    // Missing source: neither classified fix-end events nor postmortem
    // falseFindings record a keyed already-fixed claim and its proven refutation.
    const input = {...raw(),comments:[comment(1,'already fixed — proven false'),comment(2,'already fixed — proven false')]};
    expect(status(input,'recurrence')).toBe('unknown');
  });

  it.each([2,3])('keeps daemon-idle unknown after %i quiet hours with repeated reason prose', hours => {
    // Missing source: collected PR timelines contain no daemon reason samples
    // or completeness for daemon observations. Silence is not a repeated reason.
    const input = {...raw(),comments:[comment(70-hours,'daemon idle: same reason'),comment(72-hours,'daemon idle: same reason')]};
    expect(status(input,'daemon-idle')).toBe('unknown');
  });

  it.each([6,7])('keeps dependency-or-cap unknown after %i hours of alleged dependency wait', hours => {
    // Missing source: no structured dependency PR identity, wait-start/end, or
    // dependency completeness is collected; ordinary comments cannot supply it.
    expect(status({...raw(),comments:[comment(72-hours,'waiting on PR #4')]},'dependency-or-cap')).toBe('unknown');
  });

  it.each(['fix-rounds','daemon-idle','dependency-or-cap'])('keeps %s unknown with absent or malformed source arrays', trigger => {
    for (const patch of [{comments:undefined,fixLoop:undefined},{comments:[],fixLoop:null}])
      expect(status({...raw(),...patch},trigger)).toBe('unknown');
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

  it('fires fix-rounds from eight valid heads despite an additional invalid-timestamp event', () => {
    const comments = observedRounds();
    comments.push({...comments[0],createdAt:'invalid'});
    const triggers = evaluateStuckTriggers({...raw(),comments},{now});
    expect(triggers[1]).toMatchObject({trigger:'fix-rounds',status:'fired',observedRounds:8});
    expect(triggers.slice(2).map(t => t.status)).toEqual(Array(4).fill('unknown'));
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


describe('audit: completeness is mandatory evidence', () => {
  it.each([undefined,null])('keeps all triggers unknown with missing completeness (%s)', completeness => {
    const input = {...raw(),completeness};
    expect(evaluateStuckTriggers(input,{now}).map(t => t.status)).toEqual(Array(6).fill('unknown'));
  });
});
