import { describe, expect, it } from 'vitest';
import { proposeHumanRequired } from '../direction-aware-human.mjs';
import { sensitiveSurfaceHits } from '../human-review-surfaces.mjs';

const surface = 'scripts/lib/human-review-surfaces.mjs';
const runner = 'scripts/operations/run.mjs';
const sweep = 'scripts/operations/scheduled-sweep.mjs';
const dispatch = 'scripts/conveyor/health-investigate-dispatch.mjs';
const permission = file => ({ file, category: 'permission', kind: 'sandbox-widening' });
const setting = { file: surface, category: 'human-surface-setting', kind: 'human-surface-setting' };
const diff = (file, ...hunks) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${hunks.map(lines => {
  const old = lines.filter(l => l[0] !== '+').length;
  const next = lines.filter(l => l[0] !== '-').length;
  return `@@ -1,${old} +1,${next} @@\n${lines.join('\n')}\n`;
}).join('')}`;
function propose(sections, hits, overrides = {}) {
  return proposeHumanRequired({ humanRequired: true, otherHumanForced: false,
    files: Object.keys(sections), hunksOf: file => sections[file] ?? null, hits,
    readOnlyOps: new Set(['pr-trace']), protectionPaths: [/CODEOWNERS$/], ...overrides });
}
const simple = (op = 'PR_TRACE_OP') => diff(runner, [' const zeroWrites = [', `+  ${op},`, '   EVENTS_OP,', ' ];']);
const importOnly = () => diff(runner, ["+import { PR_TRACE_OP } from './pr-trace.mjs';"]);
const tightening = (changes) => diff(surface, [' export const PROTECTION_PATHS = Object.freeze([', ...changes, '   /codeowners$/,', ' ]);']);

describe('direction-aware humanRequired shadow (R131)', () => {
  it('keeps a complete long named array human when insertion enables a positional write guard', () => {
    const lines = [' let writes = 0;', ' const approvalTuple = [',
      ...Array(201).fill(" 'events',"), "+ 'pr-trace',", " 'health',", ' ];',
      " const approved = approvalTuple[201] !== 'health';", ' if (approved) writes += 1;'];
    const execute = side => Function(`${lines.filter(line => line[0] !== side)
      .map(line => line.slice(1)).join('\n')}\nreturn writes;`)();
    expect(execute('+')).toBe(0);
    expect(execute('-')).toBe(1);
    const section = diff(runner, lines);
    const hits = sensitiveSurfaceHits([runner], () => section, 'narrow');
    expect(hits).toContainEqual(permission(runner));
    expect(propose({ [runner]: section }, hits).proposed).toBe(true);
  });
  it.each([runner, sweep, dispatch])('keeps stored arrays human regardless of spelling or consumers: %s', file => {
    const readOnlyOps = new Set(['pr-trace', 'events', 'health']);
    for (const name of ['approvalTuple', 'zeroWrites', 'allowed', 'readOnly']) {
      for (const frozen of [false, true]) {
        const section = diff(file, [` const ${name} = ${frozen ? 'Object.freeze(' : ''}[`,
          " 'events',", "+ 'pr-trace',", " 'health',", frozen ? ' ]);' : ' ];',
          ` if (${name}.length === 3) writes += 1;`]);
        expect(propose({ [file]: section }, [permission(file)]).proposed).toBe(true);
        expect(propose({ [file]: section }, [permission(file)], { readOnlyOps }).proposed).toBe(true);
      }
      const inline = diff(file, [`-const ${name} = ['events', 'health'];`,
        `+const ${name} = ['events', 'pr-trace', 'health'];`]);
      expect(propose({ [file]: inline }, [permission(file)]).proposed).toBe(true);
      expect(propose({ [file]: inline }, [permission(file)], { readOnlyOps }).proposed).toBe(true);
    }
  });
  it.each([
    '/^(a+)+$/', '/^(a|aa)+$/', '/^a+a+$/', '/^.*a.*a.*$/',
    '/^(a{1,100}){1,100}$/', '/^(a+)\\1$/', '/^a+$/',
    '/path$/g', '/path$/y', '/a{999999999}/',
  ])('keeps unproven protection regex costs and state human: %s', regex => {
    expect(propose({ [surface]: tightening([`+  ${regex},`]) }, [setting]).proposed).toBe(true);
    const file = `${'a'.repeat(30)}!`;
    expect(propose({ [surface]: tightening([`+  ${regex},`]), [file]: diff(file, ['+changed']) },
      [setting, { file, category: 'protection' }]).proposed).toBe(true);
  });
  it.each([
    [' FIRST_OP,', ' SECOND_OP,', ' THIRD_OP,', '+ PR_TRACE_OP,', ' APPROVED_OP,', ' ] = [null, null, null, false, true];'],
    [' [', ' FIRST_OP,', '+ PR_TRACE_OP,', ' APPROVED_OP,', ' ] = [null, false, true];'],
    [' let [', ' FIRST_OP,', '+ PR_TRACE_OP,', ' APPROVED_OP,', ' ] = [null, false, true];'],
    [' const [', ' FIRST_OP,', '+ PR_TRACE_OP,', ' APPROVED_OP,', ' ] = [null, false, true];'],
    [' var [', ' FIRST_OP,', '+ PR_TRACE_OP,', ' APPROVED_OP,', ' ] = [null, false, true];'],
    [' const values = [', ' FIRST_OP,', ' SECOND_OP,', ' THIRD_OP,', '+ PR_TRACE_OP,', ' APPROVED_OP,'],
    [' FIRST_OP,', ' SECOND_OP,', ' THIRD_OP,', '+ PR_TRACE_OP,', ' APPROVED_OP,', ' ];'],
    [' [', " 'events',", "+ 'pr-trace',", " 'health',", ' ].forEach(runWriter);'],
    [' writeValues([', " 'events',", "+ 'pr-trace',", " 'health',", ' ]);'],
    [' const values = [', ' FIRST_OP,', '+ PR_TRACE_OP,', ' APPROVED_OP,', ' ]', ' = [null, false, true];'],
    [' const values = [', ' FIRST_OP,', '+ PR_TRACE_OP,', ' APPROVED_OP,', ' ]'],
    ['-const values = [EVENTS_OP, APPROVED_OP]', '+const values = [EVENTS_OP, PR_TRACE_OP, APPROVED_OP]',
      ' = [null, false, true];'],
    ['-const values = [EVENTS_OP, APPROVED_OP]', '+const values = [EVENTS_OP, PR_TRACE_OP, APPROVED_OP]'],
  ].map(lines => [lines]))('keeps unproven array and destructuring contexts human: %j', lines => {
    for (const file of [runner, sweep, dispatch]) {
      expect(propose({ [file]: diff(file, lines) }, [permission(file)]).proposed).toBe(true);
    }
  });
  it('demonstrates that the reported destructuring insertion enables a write', () => {
    const execute = inserted => Function(`
      let FIRST_OP, SECOND_OP, THIRD_OP, PR_TRACE_OP, APPROVED_OP;
      [FIRST_OP, SECOND_OP, THIRD_OP, ${inserted ? 'PR_TRACE_OP,' : ''} APPROVED_OP]
        = [null, null, null, false, true];
      let writes = 0;
      if (APPROVED_OP) writes += 1;
      return writes;
    `)();
    expect(execute(false)).toBe(0);
    expect(execute(true)).toBe(1);
    const section = diff(runner, [' FIRST_OP,', ' SECOND_OP,', ' THIRD_OP,',
      '+ PR_TRACE_OP,', ' APPROVED_OP,', ' ] = [null, null, null, false, true];']);
    const hits = sensitiveSurfaceHits([runner], () => section, 'narrow');
    expect(hits).toContainEqual(permission(runner));
    expect(propose({ [runner]: section }, hits).proposed).toBe(true);
  });
  it('keeps complete named arrays human, including frozen lists and consecutive additions', () => {
    const section = diff(runner, [' const first = [', '+ PR_TRACE_OP,', '+ PR_TRACE_OP,', ' ];',
      ' const second = Object.freeze([', " 'events',", "+ 'pr-trace',", ' ]);']);
    expect(propose({ [runner]: section }, [permission(runner)]).proposed).toBe(true);
  });
  it('requires both array boundaries in one hunk even when each added item has neighbours', () => {
    const section = diff(runner,
      [' const values = [', ' FIRST_OP,', '+ PR_TRACE_OP,', ' SECOND_OP,'],
      [' THIRD_OP,', '+ PR_TRACE_OP,', ' APPROVED_OP,', ' ];']);
    expect(propose({ [runner]: section }, [permission(runner)]).proposed).toBe(true);
  });
  it.each(['scripts/lib/merge-queue-enqueue.mjs', 'scripts/lib/policy-cascade.mjs'])
    ('refuses classifier dependency changes beside a provable read-only addition: %s', file => {
      expect(propose({ [runner]: simple(), [file]: diff(file, ['+// change']) }, [permission(runner)]))
        .toEqual({ proposed: true, reason: `classifier self-change: ${file}` });
    });
  it('quickly requires human review for a whitespace-padded line over 2000 characters', () => {
    const section = simple(`PR_TRACE_OP${' '.repeat(2100)}`);
    const start = performance.now();
    expect(propose({ [runner]: section }, [permission(runner)]))
      .toEqual({ proposed: true, reason: 'oversized line: human review required' });
    expect(performance.now() - start).toBeLessThan(500);
  });
  it('keeps stored entries human even on a diff line exactly 2000 characters long', () => {
    const line = '+PR_TRACE_OP,'.padEnd(2000);
    expect(propose({ [runner]: diff(runner, [' const allowed = [', line, ' ];']) }, [permission(runner)]).proposed).toBe(true);
  });
  it('accepts a provable import on a diff line exactly 2000 characters long', () => {
    const line = "+import { PR_TRACE_OP } from './pr-trace.mjs';".padEnd(2000);
    expect(propose({ [runner]: diff(runner, [line]) }, [permission(runner)]).proposed).toBe(false);
  });
  it.each(["'heavy-queue'", 'HEAVY_QUEUE_OP,'])('refuses a standalone op in executable context: %s', line => {
    const section = diff(sweep, [' if (approved)', `+${line}`, ' launchWriter();']);
    expect(propose({ [sweep]: section }, [permission(sweep)], { readOnlyOps: new Set(['heavy-queue']) }).proposed).toBe(true);
  });
  it('refuses zero-context list entries with no membership evidence', () => {
    expect(propose({ [runner]: diff(runner, ['+PR_TRACE_OP,']) }, [permission(runner)]).proposed).toBe(true);
  });
  it('requires both list neighbours in the same hunk', () => {
    for (const hunks of [[[' const allowed = [', '+PR_TRACE_OP,'], [' ];']],
      [[' const allowed = [', '+PR_TRACE_OP,', ' launchWriter();']],
      [[' launchWriter();', '+PR_TRACE_OP,', ' ];']]]) {
      expect(propose({ [runner]: diff(runner, ...hunks) }, [permission(runner)]).proposed).toBe(true);
    }
  });
  it('caps total diff text at 200000 characters with an explicit human-review fallback', () => {
    const sections = Object.fromEntries([runner, sweep].map(file => [file,
      diff(file, [' const allowed = [', '+PR_TRACE_OP,', ' ];', ...Array(100).fill(` ${' '.repeat(1000)}`)])]));
    expect(propose(sections, [permission(runner), permission(sweep)]))
      .toEqual({ proposed: true, reason: 'oversized diff: human review required' });
  });
  it('bounds matching cost for 20000 removed/added pairs', () => {
    const pairs = Array.from({ length: 20000 }, () => ['-x();', '+x();']).flat();
    const section = diff(runner, [...pairs, ' const allowed = [', '+PR_TRACE_OP,', ' ];']);
    const start = performance.now();
    const result = propose({ [runner]: section }, [permission(runner)]);
    expect(performance.now() - start).toBeLessThan(500);
    expect(result).toEqual({ proposed: true, reason: 'oversized diff: human review required' });
  });
  it('rejects write calls beside read-only references', () => {
    for (const expression of ['PR_TRACE_OP, landPr()', 'PR_TRACE_OP, prTraceLandPr()',
      'PR_TRACE_OP, (() => landPr())()', 'PR_TRACE_OP, { run: landPr() }',
      "PR_TRACE_OP, 'land-pr'.replace('land', 'trace')", 'PR_TRACE_OP, ...landPr()']) {
      expect(propose({ [runner]: simple(expression) }, [permission(runner)]).proposed, expression).toBe(true);
    }
  });
  it('rejects executable tails on imports, registrations and pass entries', () => {
    for (const expression of [
      "import { PR_TRACE_OP } from './pr-trace.mjs'; landPr();",
      '[PR_TRACE_OP]: () => ({ declaration: prTraceOperation({ readFacts: landPr() }), sinks: {}, finish: finishPrTrace }),',
      '[PR_TRACE_OP]: () => ({ declaration: prTraceOperation({ readFacts: createPrTraceReader() }), sinks: {}, finish: finishPrTrace }), landPr(),',
      "{ op: 'pr-trace', run: landPr() },",
    ]) {
      expect(propose({ [runner]: diff(runner, [`+${expression}`]) }, [permission(runner)]).proposed, expression).toBe(true);
    }
  });
  it('#5961/#5962: retains human review for stored zeroWrites and health lists beside read-only wiring', () => {
    const sections = {
      [runner]: diff(runner,
        ["+import { prTraceOperation, PR_TRACE_OP, finishPrTrace } from './pr-trace.mjs';", ' const OPERATIONS = {'],
        ['   declaration: oldDeclaration,', '   sinks: {},', '   finish: oldFinish,',
          '+  [PR_TRACE_OP]: () => ({ declaration: prTraceOperation({ readFacts: createPrTraceReader() }), sinks: {}, finish: finishPrTrace }),'],
        ['-const zeroWrites = [EVENTS_OP, HEALTH_OP];', '+const zeroWrites = [PR_TRACE_OP, EVENTS_OP, HEALTH_OP];']),
      [dispatch]: diff(dispatch, ["-const allowed = ['events', 'health'];", "+const allowed = ['pr-trace', 'events', 'health'];"]),
    };
    expect(propose(sections, [permission(runner), permission(dispatch)]).proposed).toBe(true);
  });
  it('still permits self-contained read-only imports and registration without stored-array edits', () => {
    const section = diff(runner,
      ["+import { prTraceOperation, PR_TRACE_OP, finishPrTrace } from './pr-trace.mjs';", ' const OPERATIONS = {'],
      ['   declaration: oldDeclaration,', '   sinks: {},', '   finish: oldFinish,',
        '+  [PR_TRACE_OP]: () => ({ declaration: prTraceOperation({ readFacts: createPrTraceReader() }), sinks: {}, finish: finishPrTrace }),']);
    expect(propose({ [runner]: section }, [permission(runner)]))
      .toEqual({ proposed: false, reason: 'adds only read-only ops: pr-trace' });
  });
  it('#5948: keeps pass-entry additions human under the strict line shapes', () => {
    const section = diff(sweep, [' const passes = [', "   { op: 'events', run: eventsPass },",
      "+  { op: 'pr-trace', run: prTracePass },", ' ];']);
    expect(propose({ [sweep]: section }, [permission(sweep)]).proposed).toBe(true);
  });
  it('refuses the scheduled-sweep quiet-hours return deletion with an unreachable read-only entry', () => {
    const section = diff(sweep,
      ['   if (inQuietHours) {', '-    return 0;', '   }'],
      [' function unused() {', '-return 0;', '+  return 0;', "+  'heavy-queue',", ' }']);
    expect(propose({ [sweep]: section }, [permission(sweep)], { readOnlyOps: new Set(['heavy-queue']) })
      .proposed).toBe(true);
  });
  it('refuses pure guard deletion next to a read-only addition even with return words in context', () => {
    const section = diff(sweep, ['-return 0;', "+'heavy-queue',", ' return 0;']);
    expect(propose({ [sweep]: section }, [permission(sweep)], { readOnlyOps: new Set(['heavy-queue']) })
      .proposed).toBe(true);
  });
  it('never pairs two removed guard lines with one added line', () => {
    const section = diff(sweep, ['-return 0;', '-return 0;', '+return 0;', "+'heavy-queue',"]);
    expect(propose({ [sweep]: section }, [permission(sweep)], { readOnlyOps: new Set(['heavy-queue']) })
      .proposed).toBe(true);
  });
  it('refuses removed lines re-added in reverse order', () => {
    const section = diff(sweep, ['-return 0;', '-return 1;', '+return 1;', '+return 0;', "+'heavy-queue',"]);
    expect(propose({ [sweep]: section }, [permission(sweep)], { readOnlyOps: new Set(['heavy-queue']) })
      .proposed).toBe(true);
  });
  it('keeps the scheduled-sweep stored read-only list human without consumer proof', () => {
    const section = diff(sweep, [' const readOnly = [', "+  'heavy-queue',", "   'events',", ' ];']);
    expect(propose({ [sweep]: section }, [permission(sweep)], { readOnlyOps: new Set(['heavy-queue']) })
      .proposed).toBe(true);
  });
  it('refuses the exact health allow-list early-return bypass', () => {
    const section = diff(dispatch, [' export function healthInvestigateDisallowedTools() {', '   return [',
      "+    'heavy-queue',", '+  ];', '+  const unused = [', "     'land-pr',", '   ];', ' }']);
    expect(propose({ [dispatch]: section }, [permission(dispatch)], { readOnlyOps: new Set(['heavy-queue']) })
      .proposed).toBe(true);
  });
  it.each(['const unused = [', 'let unused = [', 'var unused = [', '];', 'return [',
    'PR_TRACE_OP, EVENTS_OP,', '[PR_TRACE_OP]: (() => ({', "import { PR_TRACE_OP } from './pr-trace.mjs'; ["])
    ('refuses structural or non-singleton additions: %s', line => {
      expect(propose({ [runner]: diff(runner, [' const unused = [', '+  PR_TRACE_OP,', `+${line}`, ' ];']) },
        [permission(runner)]).proposed).toBe(true);
    });
  it('requires re-added lines to preserve each removed line bracket count', () => {
    const section = diff(runner, ['-const zeroWrites = [EVENTS_OP];',
      '+const zeroWrites = [PR_TRACE_OP, EVENTS_OP]; []']);
    expect(propose({ [runner]: section }, [permission(runner)]).proposed).toBe(true);
  });
  it('rejects guard inversion with an operation reference in a comment', () => {
    const section = diff(dispatch, ['-if (!allowed.includes(op)) return false;',
      '+if (allowed.includes(op)) return false; // PR_TRACE_OP']);
    expect(propose({ [dispatch]: section }, [permission(dispatch)]).proposed).toBe(true);
  });
  it('rejects guard relocation into a conditional scope', () => {
    const section = diff(dispatch, [' function authorize(op) {',
      '-  if (!allowed.includes(op)) return false;', '   if (optional) {',
      '+    if (!allowed.includes(op)) return false;', '   }', '+PR_TRACE_OP,', ' }']);
    expect(propose({ [dispatch]: section }, [permission(dispatch)]).proposed).toBe(true);
  });
  it('rejects executable replacement proof borrowed across hunk boundaries', () => {
    const section = diff(dispatch, ['-if (!allowed.includes(op)) return false;'],
      ['+if (!allowed.includes(op)) return false;', '+PR_TRACE_OP,']);
    expect(propose({ [dispatch]: section }, [permission(dispatch)]).proposed).toBe(true);
  });
  it('rejects operator changes beside a pure read-only addition', () => {
    const section = diff(dispatch, ['-if (allowed === op) return false;',
      '+if (allowed !== op) return false;', '+PR_TRACE_OP,']);
    expect(propose({ [dispatch]: section }, [permission(dispatch)]).proposed).toBe(true);
  });
  it('rejects reordering existing array members while adding a read-only op', () => {
    const section = diff(runner, ['-const zeroWrites = [EVENTS_OP, HEALTH_OP];',
      '+const zeroWrites = [PR_TRACE_OP, HEALTH_OP, EVENTS_OP];']);
    expect(propose({ [runner]: section }, [permission(runner)]).proposed).toBe(true);
  });
  it('keeps stored arrays human even beside an unchanged guard re-add', () => {
    const section = diff(dispatch, ['-if (!allowed.includes(op)) return false;',
      '+  if (!allowed.includes(op)) return false;', ' const allowed = [', '+PR_TRACE_OP,', ' ];']);
    expect(propose({ [dispatch]: section }, [permission(dispatch)]).proposed).toBe(true);
  });
  it('permits an unchanged guard re-add beside a self-contained read-only import', () => {
    const section = diff(runner, ['-if (!allowed.includes(op)) return false;',
      '+  if (!allowed.includes(op)) return false;', "+import { PR_TRACE_OP } from './pr-trace.mjs';"]);
    expect(propose({ [runner]: section }, [permission(runner)]).proposed).toBe(false);
  });
  it('requires re-added non-new words to come from the replaced line', () => {
    const section = diff(runner, [' const unused = [];', '-const zeroWrites = [EVENTS_OP];',
      '+const unused = [PR_TRACE_OP, EVENTS_OP];']);
    expect(propose({ [runner]: section }, [permission(runner)]).proposed).toBe(true);
  });
  it.each(['(', ')', '[', ']', '{', '}'])('refuses a net removed structural bracket: %s', bracket => {
    const section = diff(runner, [`-${bracket}`, '+  PR_TRACE_OP,']);
    expect(propose({ [runner]: section }, [permission(runner)]).proposed).toBe(true);
  });
  it('#5935: permits only newly protected paths and the tightening classifier diff', () => {
    const sections = { [surface]: tightening([
      '+  /(^|\\/)webeverything\\.config\\.json$/,',
      '+  /(^|\\/)deliverypolicydefaults\\.ts$/i, // case insensitive',
      '+  // More protections.',
    ]), 'config/deliveryPolicyDefaults.ts': diff('config/deliveryPolicyDefaults.ts', ['-old', '+next']),
    'webeverything.config.json': diff('webeverything.config.json', ['-old', '+next']) };
    const hits = [setting, ...Object.keys(sections).slice(1).map(file => ({ file, category: 'protection', kind: 'protection' }))];
    expect(propose(sections, hits)).toEqual({ proposed: false, reason: 'adds protected paths only' });
  });
  it.each(['/literal-path_1$/', '/^scripts\\/rulesets\\//', '/(^|\\/)policy\\.json$/i'])
    ('permits bounded literal-path protections: %s', regex => {
      expect(propose({ [surface]: tightening([`+  ${regex},`]) }, [setting]))
        .toEqual({ proposed: false, reason: 'adds protected paths only' });
    });
  it('requires human review beyond the literal regex size bound', () => {
    expect(propose({ [surface]: tightening([`+  /${'a'.repeat(511)}$/d,`]) }, [setting]).proposed).toBe(true);
    expect(propose({ [surface]: tightening([`+  /${'a'.repeat(511)}$/,`]) }, [setting]).proposed).toBe(false);
    expect(propose({ [surface]: tightening([`+  /${'a'.repeat(512)}$/,`]) }, [setting]))
      .toEqual({ proposed: true, reason: 'unproven protection regex cost: human review required' });
  });
  it.each(['LAND_PR_OP', "'land-pr'", "PR_TRACE_OP, LAND_PR_OP", "'pr-trace', 'land-pr'"])
    ('keeps write-capable or mixed additions human: %s', op => {
      expect(propose({ [runner]: simple(op) }, [permission(runner)]))
        .toEqual({ proposed: true, reason: 'write-capable or unproven op: land-pr' });
    });
  it.each([
    [['-  /old$/,'], 'removes protection'],
    [['-  /old$/,', '+  /next$/,'], 'mixed tighten+loosen'],
    [['+  const bypass = true;'], 'unprovable tightening'],
    [['+  /[/,'], 'invalid protection regex'],
  ])('keeps unsafe classifier edits human: %s', (changes, reason) => {
    expect(propose({ [surface]: tightening(changes) }, [setting])).toEqual({ proposed: true, reason });
  });
  it.each(['scripts/lib/review-escalation.mjs', 'scripts/lib/permission-change.mjs',
    'scripts/lib/direction-aware-human.mjs', 'scripts/review-core-cli.mjs', 'scripts/settings/human-review-surfaces.json',
    'scripts/lib/policy-cascade.mjs', 'scripts/lib/read-only-ops.mjs', 'scripts/settings/direction-aware-human.json'])
    ('keeps any classifier self-change human even without a hit: %s', file => {
      expect(propose({ [file]: diff(file, ['+// change']) }, []))
        .toEqual({ proposed: true, reason: `classifier self-change: ${file}` });
    });
  it('refuses empty read-only proof', () => {
    expect(propose({ [runner]: simple() }, [permission(runner)], { readOnlyOps: new Set() }))
      .toEqual({ proposed: true, reason: 'empty readOnlyOps' });
  });
  it('refuses missing hunks including an otherwise unrelated changed file', () => {
    expect(propose({ [runner]: simple(), 'other.mjs': null }, [permission(runner)]).reason).toContain('null hunks');
  });
  it('refuses sandbox tokens on added lines', () => {
    expect(propose({ [runner]: simple('PR_TRACE_OP, writableRoots') }, [permission(runner)]).reason).toContain('sandbox token');
  });
  it.each(['writableRoots', 'writable_roots', 'sandbox_mode', 'network-access'])
    ('refuses sandbox owning keys in context: %s', key => {
      expect(propose({ [runner]: diff(runner, [` const ${key} = [`, "+  'pr-trace',", ' ];']) },
        [permission(runner)]).proposed).toBe(true);
    });
  it('refuses sandbox tokens in hunk headers', () => {
    const section = simple().replace('@@\n', '@@ writableRoots\n');
    expect(propose({ [runner]: section }, [permission(runner)]).proposed).toBe(true);
  });
  it.each(['\u2028', '\u2029', ...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i))
    .filter(c => !['\t', '\n', '\r'].includes(c))])('refuses hidden code in added protection comments: %j', control => {
    expect(propose({ [surface]: tightening([`+  // harmless${control} bypass();`]) }, [setting]).proposed).toBe(true);
    expect(propose({ [surface]: tightening([`+  /new${control}path$/,`]) }, [setting]).proposed).toBe(true);
  });
  it('refuses an embedded carriage return in added protection comments', () => {
    expect(propose({ [surface]: tightening(['+  // harmless\r bypass();']) }, [setting]).proposed).toBe(true);
  });
  it('never makes a non-human decision stricter', () => {
    expect(propose({}, [], { humanRequired: false, otherHumanForced: true }))
      .toEqual({ proposed: false, reason: 'not human-required today' });
  });
  it('preserves other forced human triggers', () => {
    expect(propose({}, [], { otherHumanForced: true }).proposed).toBe(true);
  });
  it.each(['garbage', '@@ -1,1 +1,1 @@\n+PR_TRACE_OP\n', '@@ nope\n+PR_TRACE_OP\n'])
    ('refuses unparsable or truncated diffs: %s', text => {
      expect(propose({ [runner]: text }, [permission(runner)]).reason).toContain('unparsable');
    });
  it('refuses oversized evidence with human review as fallback', () => {
    expect(propose({ [runner]: 'x'.repeat(500001) }, [permission(runner)]).reason).toContain('human review');
  });
  it('refuses removed words, residual words and additions without new references', () => {
    for (const lines of [['-const old = [WRITE_OP];', '+const old = [PR_TRACE_OP];'],
      ['+PR_TRACE_OP,', '+bypass();'], [' const ops = [PR_TRACE_OP];', '+const ops = [PR_TRACE_OP];']]) {
      expect(propose({ [runner]: diff(runner, lines) }, [permission(runner)]).proposed).toBe(true);
    }
  });
  it('refuses edits to already protected files and protection hits without tightening', () => {
    const file = 'CODEOWNERS';
    expect(propose({ [file]: diff(file, ['-old', '+next']) }, [{ file, category: 'protection' }]).proposed).toBe(true);
  });
  it('does not treat a regex outside array-entry context as tightening', () => {
    expect(propose({ [surface]: diff(surface, [' const unrelated = true;', '+ /new$/,']) }, [setting]).proposed).toBe(true);
  });
  it.each(['workflow-permissions', 'branch-protection-config', 'identity', 'secrets', 'other'])
    ('preserves unsupported hits: %s', kind => {
      expect(propose({ [runner]: simple() }, [{ file: runner, category: kind, kind }]).proposed).toBe(true);
    });
  it('refuses sandbox-widening on an unrecognized allow-list surface', () => {
    expect(propose({ 'unknown.mjs': diff('unknown.mjs', ['+PR_TRACE_OP,']) }, [permission('unknown.mjs')]).proposed).toBe(true);
  });
  it('refuses absent hits rather than vacuously clearing humanRequired', () => {
    expect(propose({ [runner]: simple() }, []).proposed).toBe(true);
  });
  it('keeps an existing protected file human even when a new regex also matches it', () => {
    const file = 'CODEOWNERS';
    expect(propose({ [surface]: tightening(['+  /codeowners$/,']), [file]: diff(file, ['+owner']) },
      [setting, { file, category: 'protection' }], { protectionPaths: [/codeowners$/] }))
      .toEqual({ proposed: true, reason: 'edits existing protected path' });
  });
  it('uses the shipped protection defaults when no before-change override is supplied', () => {
    const file = 'webeverything.config.json';
    expect(propose({ [surface]: tightening(['+  /webeverything\\.config\\.json$/,']),
      [file]: diff(file, ['+{}']) }, [setting, { file, category: 'protection' }], { protectionPaths: undefined })
      .reason).toBe('edits existing protected path');
  });
  it('requires every hit to be benign', () => {
    expect(propose({ [runner]: simple() }, [permission(runner), { file: runner, category: 'secrets', kind: 'secrets' }])
      .proposed).toBe(true);
  });
  it('does not carry tightening context between hunks', () => {
    expect(propose({ [surface]: diff(surface,
      [' export const PROTECTION_PATHS = Object.freeze([', '+  /first$/,'], ['+  /second$/,']) }, [setting])
      .reason).toContain('unprovable tightening context');
  });
  it('rejects invalid regex flags', () => {
    expect(propose({ [surface]: tightening(['+  /valid/zz,']) }, [setting]).reason).toBe('invalid protection regex');
  });
  it('preserves caller regex state and read-only proof inputs', () => {
    const regex = /unrelated/g; regex.lastIndex = 4;
    const readOnlyOps = new Set(['pr-trace']);
    const sections = Object.freeze({ [runner]: importOnly() });
    const hits = Object.freeze([Object.freeze(permission(runner))]);
    expect(propose(sections, hits, { readOnlyOps, protectionPaths: [regex] }).proposed).toBe(false);
    expect(regex.lastIndex).toBe(4);
    expect([...readOnlyOps]).toEqual(['pr-trace']);
  });
  it('fails closed when the hunk resolver throws', () => {
    expect(propose({ [runner]: simple() }, [permission(runner)], { hunksOf: () => { throw new Error('unreadable hunks'); } }))
      .toEqual({ proposed: true, reason: 'unreadable hunks' });
  });
});
