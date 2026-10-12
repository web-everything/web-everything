/**
 * @file codex-model-routing.test.mjs — #3635 ("#x8wbivt")'s ratified Codex routing constants, and the
 * REPO-WIDE invariant its Fork 1 actually ruled.
 *
 * WHY A REPO-WIDE TEST AND NOT JUST PER-FILE ONES. Fork 1's ruling is a quantified statement about the whole
 * codebase — *"**Every** Codex invocation names its model explicitly — never the CLI's own implicit
 * default"* — not a property of one file. It was ratified while only ONE Codex call site existed on `main`,
 * and the two built afterwards show exactly what an unenforced universal decays into: the judge seat
 * (`codex-judge-spawn.mjs`) shipped with `if (model !== undefined)` and no caller ever supplying one, so it
 * silently rode the CLI default the rule exists to forbid; the delivery provider
 * (`codex-delivery-provider.mjs`) got the behaviour right but hand-copied the ratified literal, so a
 * re-ratification would have landed on one copy and missed the other two.
 *
 * Per-file argv tests would not have caught either, because each file was individually self-consistent. The
 * roster below is therefore DISCOVERED from the source tree, never hand-typed: a fourth Codex call site that
 * follows the repo's own `export const CODEX_CLI = 'codex'` convention is picked up automatically and must
 * satisfy the same rule before this suite goes green.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import {
  CODEX_EFFORT_MAP, CODEX_MODEL, CODEX_TIER_EFFORT, assertCodexModel, resolveCodexEffort,
  CODEX_MODEL_CATALOGUE, CODEX_TASK_KINDS, CODEX_MODEL_BY_TASK_DEFAULT, CODEX_USAGE_BUCKETS,
  classifyCodexTask, resolveCodexTaskRoute, codexModelSupportsEffort, formatCodexRouteLine, logCodexRoute, parseRolloutUsageBucket,
} from '../codex-model-routing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = join(HERE, '..', '..');

/**
 * Strip block and line comments so a content assertion reads CODE, not prose about code. Deliberately crude
 * (it does not model strings or regex literals) — that is fine for the two narrow patterns checked below,
 * both of which are statement shapes no string literal in these files contains.
 */
function codeOf(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every `.mjs` under `scripts/`, excluding test files and `node_modules`. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/**
 * The Codex call sites, DISCOVERED by the repo's own naming convention. All three real sites declare
 * `export const CODEX_CLI = 'codex'` and their headers explicitly cite each other for doing so ("Named once,
 * exactly like `codex-judge-spawn.mjs#CODEX_CLI` is"), which makes it a reliable marker rather than a guess.
 */
const CODEX_CALL_SITES = sourceFiles(SCRIPTS_ROOT)
  .filter((f) => /export const CODEX_CLI\s*=\s*'codex'/.test(readFileSync(f, 'utf8')))
  .map((f) => relative(SCRIPTS_ROOT, f))
  .sort();

describe('#3635 Fork 1 — the repo-wide rule, enforced across every discovered Codex call site', () => {
  it('finds the real call sites — a guard on the discovery itself, so this suite cannot pass vacuously', () => {
    // If this ever reads `[]`, every assertion below would trivially pass over an empty roster.
    expect(CODEX_CALL_SITES.length).toBeGreaterThanOrEqual(3);
    expect(CODEX_CALL_SITES).toEqual(expect.arrayContaining([
      'codex-direct-task.mjs',
      join('lib', 'codex-judge-spawn.mjs'),
      join('operations', 'codex-delivery-provider.mjs'),
    ]));
  });

  for (const site of CODEX_CALL_SITES) {
    const src = () => readFileSync(join(SCRIPTS_ROOT, site), 'utf8');

    it(`${site} takes its model from the ONE ratified source, not a local literal`, () => {
      const text = src();
      expect(text, 'must import from `lib/codex-model-routing.mjs`').toMatch(/codex-model-routing\.mjs/);
      // The literal may appear in PROSE (a header citing the measurement), but never as a fresh declaration.
      // `codex-model-routing.mjs` itself is excluded — it IS the declaration.
      const declarations = codeOf(text).match(/^\s*(?:export\s+)?const\s+\w*MODEL\w*\s*=\s*'gpt-[^']+'/gm) ?? [];
      expect(declarations, `${site} re-declares the pinned model instead of importing it`).toEqual([]);
    });

    it(`${site} has no conditional that can skip -m`, () => {
      // The EXACT defect shape found in `codex-judge-spawn.mjs`: `if (model !== undefined) { … push('-m') }`.
      // A model-guarded branch is how "always passes a model" quietly became "passes one when asked to".
      // CODE ONLY — the same phrase legitimately appears in the headers that explain why it was removed, and
      // a check that cannot tell code from a comment about code would forbid documenting the fix.
      expect(codeOf(src()), `${site} still guards its model on a conditional`)
        .not.toMatch(/if\s*\(\s*model\s*!==\s*undefined\s*\)/);
    });
  }

  it('the routing module is the only place the pinned literal is declared', () => {
    const declaring = sourceFiles(SCRIPTS_ROOT)
      .filter((f) => /^\s*(?:export\s+)?const\s+\w*MODEL\w*\s*=\s*'gpt-[^']+'/m.test(codeOf(readFileSync(f, 'utf8'))))
      .map((f) => relative(SCRIPTS_ROOT, f));
    expect(declaring).toEqual([join('lib', 'codex-model-routing.mjs')]);
  });

  it('every call site emits -m in its ACTUAL argv — the static checks above are not the whole proof', async () => {
    const judge = await import('../codex-judge-spawn.mjs');
    const direct = await import('../../codex-direct-task.mjs');
    const delivery = await import('../../operations/codex-delivery-provider.mjs');

    const argvs = [
      ['codex-judge-spawn', judge.buildCodexJudgeArgv({
        schemaFile: '/tmp/s.json', outputLastMessageFile: '/tmp/l.txt', cwd: '/tmp/scratch',
      })],
      ['codex-direct-task', direct.buildCodexDirectTaskArgv({ cwd: '/tmp/lane' })],
      ['codex-delivery-provider', delivery.buildCodexDeliveryArgv({
        prompt: 'P', cwd: '/tmp/lane', denyPaths: ['/tmp/deny'],
      })],
    ];

    for (const [name, argv] of argvs) {
      const at = argv.indexOf('-m');
      expect(at, `${name} omitted -m`).toBeGreaterThan(-1);
      expect(argv[at + 1], `${name} passed the wrong model`).toBe(name === 'codex-delivery-provider' ? CODEX_MODEL : 'gpt-6.1-sol');
    }
  });
});

describe('the ratified constants themselves', () => {
  it('pins the model Fork 3 actually ruled', () => {
    expect(CODEX_MODEL).toBe('gpt-6-astra');
  });

  it('CODEX_EFFORT_MAP is an IDENTITY over all six real levels — no clamp, no omission', () => {
    expect(Object.keys(CODEX_EFFORT_MAP)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    for (const [k, v] of Object.entries(CODEX_EFFORT_MAP)) expect(v, k).toBe(k);
  });

  it('the three rungs are Fork 2\'s ratified effort ladder, and stop at high', () => {
    expect(CODEX_TIER_EFFORT).toEqual({ haiku: 'low', sonnet: 'medium', opus: 'high' });
    // Deliberate: no probe exercised xhigh/max/ultra, so no rung maps onto one.
    expect(Object.values(CODEX_TIER_EFFORT)).not.toContain('ultra');
  });

  it('Fork 2 gives every ROLE the same model — the ladder moves effort, never model', async () => {
    // The judge seat, the delivery agent and the personal task tool are three different roles; the ratified
    // ruling is one model for all of them. This is the assertion that would go red if someone introduced
    // per-role model routing without a new decision.
    const direct = await import('../../codex-direct-task.mjs');
    const delivery = await import('../../operations/codex-delivery-provider.mjs');
    const judge = await import('../codex-judge-spawn.mjs');
    expect(new Set([direct.CODEX_MODEL, delivery.CODEX_DELIVERY_MODEL, judge.CODEX_MODEL]).size).toBe(1);
  });
});

describe('resolveCodexEffort', () => {
  it('an explicit effort wins over a tier', () => {
    expect(resolveCodexEffort({ tier: 'haiku', effort: 'ultra' })).toBe('ultra');
  });

  it('a tier resolves through the ratified ladder', () => {
    expect(resolveCodexEffort({ tier: 'haiku' })).toBe('low');
    expect(resolveCodexEffort({ tier: 'sonnet' })).toBe('medium');
    expect(resolveCodexEffort({ tier: 'opus' })).toBe('high');
  });

  it('naming NEITHER pins the sonnet rung rather than leaving Codex to infer one', () => {
    expect(resolveCodexEffort()).toBe('medium');
    expect(resolveCodexEffort({})).toBe('medium');
  });

  it('validates both inputs, and is not fooled by inherited Object properties', () => {
    expect(() => resolveCodexEffort({ tier: 'fable' })).toThrow(/`tier` must be one of/);
    expect(() => resolveCodexEffort({ effort: 'ludicrous' })).toThrow(/`effort` must be one of/);
    expect(() => resolveCodexEffort({ tier: 'constructor' })).toThrow(/`tier` must be one of/);
    expect(() => resolveCodexEffort({ effort: 'toString' })).toThrow(/`effort` must be one of/);
  });
});

describe('assertCodexModel', () => {
  it('returns the trimmed name for a usable model', () => {
    expect(assertCodexModel('  gpt-5.6-sol ')).toBe('gpt-5.6-sol');
  });

  it('refuses a flag-shaped model — it would be parsed as a flag, not as -m\'s operand', () => {
    expect(() => assertCodexModel('-x')).toThrow(/plain non-empty string/);
    expect(() => assertCodexModel('--evil')).toThrow(/plain non-empty string/);
  });

  it('refuses empty and non-string input', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
      expect(() => assertCodexModel(bad), JSON.stringify(bad)).toThrow(/plain non-empty string/);
    }
  });

  it('names the calling module in its error, so a failure points at the call site', () => {
    expect(() => assertCodexModel('-x', 'codex-judge-spawn')).toThrow(/^codex-judge-spawn:/);
  });
});


describe('per-task model AND effort routing (2026-10-12)', () => {
  const route = (opts = {}) => resolveCodexTaskRoute({ tool: {}, platform: {}, env: {}, log: false, ...opts });
  const defaults = [
    ['prepare', 'gpt-6-astra', 'medium'], ['prepare-complex', 'gpt-6-astra', 'high'],
    ['takeover', 'gpt-6-astra', 'high'], ['design', 'gpt-6-astra', 'high'],
    ...['fix', 'ci-heal', 'build', 'worker', 'review'].map(k => [k, 'gpt-6.1-sol', 'medium']),
    ['trivial', 'gpt-6-luna', 'low'], ['review-mandatory', 'gpt-6-astra', 'high'],
  ];
  it.each(defaults)('%s names both defaults', (kind, model, effort) => {
    expect(CODEX_MODEL_BY_TASK_DEFAULT[kind]).toEqual({ model, effort });
    expect(route({ kind })).toEqual({ kind, model, effort, sources: { model: 'standard', effort: 'standard' }, bucket: 'codex' });
    expect(Object.isFrozen(CODEX_MODEL_BY_TASK_DEFAULT[kind])).toBe(true);
  });
  it('freezes the vocabulary and catalogue, preserving the strong identity', () => {
    expect([...CODEX_TASK_KINDS].sort()).toEqual(defaults.map(x => x[0]).sort());
    for (const value of [CODEX_TASK_KINDS, CODEX_MODEL_CATALOGUE, CODEX_MODEL_BY_TASK_DEFAULT, CODEX_USAGE_BUCKETS, ...Object.values(CODEX_MODEL_CATALOGUE)]) expect(Object.isFrozen(value)).toBe(true);
    expect(CODEX_MODEL).toBe('gpt-6-astra');
  });
  it.each([{ size: 8 }, { size: 13 }, { epic: true }, { decision: true }, { care: 'elevated' }, { care: 'high' }])('classifies complex preparation %j', inputs => {
    expect(classifyCodexTask({ kind: 'prepare', ...inputs })).toBe('prepare-complex');
  });
  it('keeps ordinary prepare and upgrades only mandatory elevated reviews', () => {
    expect(classifyCodexTask()).toBe('worker');
    expect(classifyCodexTask({ kind: 'prepare', size: 5 })).toBe('prepare');
    expect(classifyCodexTask({ kind: 'review', mandatoryLens: true, care: 'elevated' })).toBe('review-mandatory');
    expect(classifyCodexTask({ kind: 'review', mandatoryLens: true, care: 'high' })).toBe('review-mandatory');
    expect(classifyCodexTask({ kind: 'review', care: 'high' })).toBe('review');
    expect(classifyCodexTask({ kind: 'review', mandatoryLens: true, care: 'normal' })).toBe('review');
    expect(() => classifyCodexTask({ kind: 'oops' })).toThrow(/allowed.*prepare.*review-mandatory/i);
    expect(() => classifyCodexTask({ kind: 'constructor' })).toThrow(TypeError);
  });
  it.each([['stronger','takeover'], ['stronger-model','takeover'], ...['card','card-filing','prevention-card','card-rename','conflict'].map(k => [k,'trivial']), ['delivery','build'], ['heal','ci-heal']])('aliases %s', (kind, expected) => expect(classifyCodexTask({ kind })).toBe(expected));
  it('resolves platform, tool, and partial env per leaf with provenance', () => {
    expect(route({ kind: 'fix', platform: { fix: { model: 'gpt-6-astra', effort: 'high' } }, tool: { fix: { model: 'gpt-6-luna' } }, env: { WE_CODEX_MODEL_BY_TASK: '{"fix":{"effort":"low"}}' } })).toMatchObject({ model: 'gpt-6-luna', effort: 'low', sources: { model: 'tool', effort: 'env' } });
    expect(route({ kind: 'fix', platform: { fix: { effort: 'high' } } }).sources.effort).toBe('platform');
    expect(resolveCodexTaskRoute({ kind: 'fix', env: {}, platform: {}, log: false }).sources).toEqual({ model: 'tool', effort: 'tool' });
  });
  it('ignores invalid leaves without discarding valid siblings and names invalid JSON', () => {
    expect(route({ kind: 'fix', tool: { fix: { model: 'unknown', effort: 'high' } }, env: { WE_CODEX_MODEL_BY_TASK: '{"fix":{"effort":"bogus"}}' } })).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high', sources: { model: 'standard', effort: 'tool' } });
    const lines = [];
    expect(route({ env: { WE_CODEX_MODEL_BY_TASK: '{oops' }, log: l => lines.push(l) }).model).toBe('gpt-6.1-sol');
    expect(lines.join(' ')).toMatch(/invalid.*WE_CODEX_MODEL_BY_TASK/);
  });
  it('explicit unknown models remain allowed, with vocabulary and final pair validation', () => {
    expect(route({ model: 'x', effort: 'max' })).toMatchObject({ model: 'x', effort: 'max', sources: { model: 'explicit', effort: 'explicit' }, bucket: null });
    expect(() => route({ kind: 'trivial', effort: 'ultra' })).toThrow(/gpt-6-luna.*ultra.*low.*max/);
    expect(() => route({ model: 'x', effort: 'bogus' })).toThrow(TypeError);
    expect(route({ model: 'constructor' }).bucket).toBeNull();
    expect(codexModelSupportsEffort('x', 'high')).toBe(true);
    expect(codexModelSupportsEffort('x', 'bogus')).toBe(false);
    expect(codexModelSupportsEffort('gpt-5.5', 'max')).toBe(false);
  });
  it('logs every route, exactly formatted, and logging never throws', () => {
    const r = route({ kind: 'fix' });
    const expected = 'codex-route · kind=fix model=gpt-6.1-sol (standard) effort=medium (standard) bucket=codex';
    expect(formatCodexRouteLine(r)).toBe(expected);
    const lines = [];
    for (let i = 0; i < 2; i++) logCodexRoute(r, { log: l => lines.push(l) });
    expect(lines).toEqual([expected, expected]);
    expect(() => logCodexRoute(r, { log: () => { throw Error('sink failed'); } })).not.toThrow();
  });
  it('reads the last token_count bucket, tolerating malformed and unrelated lines', () => {
    const event = (id, used) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: id, primary: { used_percent: used } } } });
    expect(parseRolloutUsageBucket(event('old', 1) + '\ninvalid\n' + event('codex', 12))).toEqual({ limit_id: 'codex', used_percent: 12 });
    expect(parseRolloutUsageBucket('{}\ninvalid')).toBeNull();
  });
});
