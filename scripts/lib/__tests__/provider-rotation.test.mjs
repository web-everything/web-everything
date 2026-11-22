import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { drawArm, effectiveShares, composePanel, routeFor } from '../provider-rotation.mjs';

const entry = (provider, model, family, tier, share, effort = 'high') =>
  ({ arm: { provider, model, effort }, family, tier, share });
const arms = [entry('codex', 'sol', 'openai', 'strong', 60),
  entry('agy-gemini', 'carbon', 'google', 'strong', 25),
  entry('claude', 'sonnet', 'anthropic', 'strong', 15)];
const id = arm => `${arm.provider}/${arm.model}/${arm.effort}`;
const catalog = { codex: { sol: ['high'], luna: ['high'] },
  'agy-gemini': { carbon: ['high'], flash: ['high'], hydrogen: ['high'] },
  claude: { sonnet: ['high'], haiku: ['high'] }, openai: { sol: ['high'] },
  anthropic: { sonnet: ['high'] } };
const policy = { catalog, exhaustedPercent: 98, reserveReleaseHours: 6, reservePercent: 10,
  smallArms: ['hydrogen', 'luna', 'haiku', 'flash'], carbonPromoted: true, mode: 'shadow', minPanelFamilies: 2, strongArms: arms.map(a => id(a.arm)),
  smallTiers: ['small'], keyLenses: ['correctness', 'security', 'red-team'],
  strongShapes: ['security', 'merge-path'], kinds: Object.fromEntries(
    ['build', 'review-correctness', 'review-security', 'review-lens', 'red-team'].map(k => [k, { arms: structuredClone(arms) }])) };
const capacity = Object.fromEntries(arms.map(a => [a.arm.provider,
  { usedPct: 20, hoursToReset: 4, manualResetsHeld: 0, available: true }]));
const builder = { provider: 'codex', model: 'sol', effort: 'high' };
const seats = [{ lens: 'correctness', counting: true }, { lens: 'security', counting: true }];
const draw = (extra = {}) => drawArm({ kind: 'build', subject: 'repo#1', policy, capacity, ...extra });
const panel = (extra = {}) => composePanel({ seats, builder, policy, capacity,
  subject: 'repo#1', shape: 'normal', ...extra });
const clone = value => structuredClone(value);
const freeze = value => { if (value && typeof value === 'object') {
  Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const realPolicy = () => JSON.parse(readFileSync('scripts/settings/provider-rotation.json', 'utf8')).providerRotation;

describe('pure provider rotation', () => {
  it('refuses malformed on policies instead of returning the legacy route (audit 1)', () => {
    for (const broken of [{ mode: 'on' }, { ...policy, mode: 'on', kinds: null }]) {
      expect(routeFor({ policy: broken, legacyRoute: { provider: 'legacy' } }))
        .toEqual({ route: null, shadow: null, refusal: 'invalid-policy' });
    }
  });
  it('policy-added key lenses exclude the builder family and small arms (audit 2)', () => {
    const p = clone(policy); p.keyLenses.push('style');
    for (const candidate of [arms[0], entry('claude', 'haiku', 'anthropic', 'strong', 1)]) {
      p.kinds['review-lens'].arms = [candidate];
      expect(draw({ kind: 'review-lens', lens: 'style', builder, policy: p }))
        .toMatchObject({ arm: null, refusal: expect.any(String) });
      expect(panel({ policy: p, seats: [{ lens: 'style', counting: true }, seats[0]] }).ok).toBe(false);
    }
  });
  it.each([undefined, '', 'unknown', 'Security'])('refuses missing or unknown review-lens %j before Carbon selection (audit 3)', lens => {
    const p = clone(policy); p.carbonPromoted = false; p.kinds['review-lens'].arms = [arms[1]];
    expect(draw({ kind: 'review-lens', lens, policy: p })).toMatchObject({ arm: null, refusal: 'unknown-lens' });
  });
  it.each([
    { provider: 'codex', model: 'gpt-invented', effort: 'bogus' },
    { ...builder, effort: 'bogus' },
    { ...builder, model: 'gpt-6.1-sol' },
    undefined,
  ])('draw refuses an invalid or absent builder arm %j just as panel composition does (audit 7)', bad => {
    expect(panel({ builder: bad }).ok).toBe(false);
    expect(draw({ kind: 'review-security', builder: bad, builderFamily: 'openai' }))
      .toMatchObject({ arm: null, refusal: 'unknown-builder-family' });
  });

  it('routeFor preserves recursively mutable legacy routes for every non-live policy state', () => {
    for (const p of [undefined, null, {}, { mode: 'bad' }, { mode: 'shadow' },
      { ...policy, kinds: null }, policy, { ...policy, mode: 'off' }]) {
      const legacyRoute = { provider: 'legacy', nested: { args: ['mutable'] } };
      const result = routeFor({ kind: 'build', subject: 'repo#1', capacity, policy: p, legacyRoute });
      expect(p?.mode === 'off' ? result : result.route).toBe(legacyRoute);
      legacyRoute.nested.args.push('still mutable');
    }
  });
  it('refuses invented catalog triples independently of the policy catalog', () => {
    const p = clone(policy);
    const fake = { provider: 'codex', model: 'gpt-nonexistent', effort: 'bogus' };
    p.catalog.codex[fake.model] = [fake.effort]; p.kinds.build.arms[0].arm = fake;
    expect(draw({ policy: p })).toMatchObject({ arm: null, refusal: 'invalid-policy' });
    const unused = clone(policy); unused.catalog.codex['gpt-nonexistent'] = ['high'];
    expect(draw({ policy: unused })).toMatchObject({ arm: null, refusal: 'invalid-policy' });
    const effort = clone(policy); effort.catalog.codex.sol.push('bogus');
    expect(draw({ policy: effort })).toMatchObject({ arm: null, refusal: 'invalid-policy' });
  });
  it('copies only owned share fields without freezing mutable nested metadata', () => {
    const kind = clone(policy.kinds.build); kind.arms[0].metadata = { tags: [] };
    effectiveShares(kind, capacity, policy);
    kind.arms[0].metadata.tags.push('mutable');
  });
  it('inactive, unknown and tier-excluded capacity and explicit null reserve contribute zero', () => {
    for (const patch of [{ label: 'inactive' }, { label: 'unknown' }, { label: 'tier-excluded' },
      { label: 'invented' }, { reservePercent: null }]) {
      expect(effectiveShares(policy.kinds.build, { ...capacity, codex: { ...capacity.codex, ...patch } }, policy)[0].share).toBe(0);
    }
  });
  it('refuses unknown lenses including case variants', () => {
    for (const lens of ['Security', 'SECURITY', 'unknown'])
      expect(panel({ seats: [{ lens, counting: true }, seats[0]] })).toMatchObject({ ok: false, panel: [], refusal: 'unknown-lens' });
  });
  it('panel keeps observer counting flags and live security routes enforce panel safeguards', () => {
    const p = clone(policy); p.carbonPromoted = false;
    const result = panel({ policy: p, seats: [{ lens: 'style', counting: true },
      { lens: 'style', counting: true }, { lens: 'style', counting: false }] });
    expect(result.ok).toBe(true);
    expect(result.panel.map(s => s.counting)).toEqual([true, true, false]);
    let carbonObservers = 0;
    for (let i = 0; i < 100; i++) {
      const observed = panel({ policy: p, subject: `observer:${i}`, seats: [{ lens: 'style', counting: true },
        { lens: 'style', counting: true }, { lens: 'style', counting: false }] });
      for (const seat of observed.panel.filter(s => /carbon/.test(s.arm.model))) { expect(seat.counting).toBe(false); carbonObservers++; }
    }
    expect(carbonObservers).toBeGreaterThan(0);
    for (const builderArm of arms.map(a => a.arm)) for (let i = 0; i < 50; i++) {
      const route = routeFor({ kind: 'review-security', subject: `repo#${i}`, policy: { ...p, mode: 'on' }, capacity, builder: builderArm }).route;
      expect(route).not.toBeNull();
      expect(route.provider).not.toBe(builderArm.provider); expect(route.model).not.toMatch(/carbon|luna|flash|hydrogen|haiku/);
    }
    expect(routeFor({ kind: 'review-security', subject: 'repo#1', policy: { ...p, mode: 'on' }, capacity: { codex: capacity.codex }, builder }).route).toBeNull();
    expect(draw({ kind: 'review-security', lens: 'style', builder })).toMatchObject({ arm: null, refusal: 'kind-lens-mismatch' });
  });
  it('refuses unknown providers, models and efforts against the declared catalog, including builders', () => {
    for (const arm of [{ provider: 'unknown', model: 'unknown', effort: 'unknown' },
      { ...builder, provider: 'unknown' }, { ...builder, model: 'unknown' }, { ...builder, effort: 'unknown' }]) {
      const p = clone(policy); p.kinds.build.arms[0].arm = arm;
      expect(draw({ policy: p })).toMatchObject({ arm: null, refusal: 'invalid-policy' });
      expect(panel({ builder: arm }).ok).toBe(false);
    }
  });
  it('derives Claude family from identity despite forged family labels on two Sonnet reviewers', () => {
    const p = clone(policy);
    p.kinds['review-lens'].arms = [entry('claude', 'sonnet', 'google', 'strong', 1),
      entry('anthropic', 'sonnet', 'anthropic', 'strong', 1)];
    expect(panel({ policy: p, seats: [{ lens: 'style', counting: true }, { lens: 'style', counting: true }],
      capacity: { ...capacity, anthropic: capacity.claude } })).toMatchObject({ ok: false, panel: [] });
  });
  it('excludes exhausted and reserved providers from shares and live routes', () => {
    for (const patch of [{ usedPct: 98 }, { usedPct: 99 }, { reserve: true }, { reserved: true },
      { reserveOnly: true }, { held: true }, { usedPct: 91, hoursToReset: 8 }]) {
      const cap = clone(capacity); Object.assign(cap.codex, patch);
      expect(effectiveShares(policy.kinds.build, cap, policy)[0].share).toBe(0);
      for (let i = 0; i < 50; i++) expect(routeFor({ kind: 'build', subject: `capacity:${i}`,
        policy: { ...policy, mode: 'on' }, capacity: cap }).route?.provider).not.toBe('codex');
      expect(draw({ capacity: { codex: cap.codex } })).toMatchObject({ arm: null, refusal: 'no-eligible-arm' });
    }
  });
  it('uses policy strongShapes when normal is promoted to a strong shape', () => {
    const p = clone(policy); p.strongShapes.push('normal');
    Object.values(p.kinds).forEach(k => { k.arms = [entry('codex', 'luna', 'openai', 'small', 1),
      entry('claude', 'haiku', 'anthropic', 'small', 1)]; });
    expect(panel({ policy: p, seats: [{ lens: 'style', counting: true }, { lens: 'style', counting: true }] }))
      .toMatchObject({ ok: false, panel: [], refusal: 'no-strong-seat' });
  });
  it('refuses counting Carbon without explicit boolean promotion evidence', () => {
    for (const value of [undefined, false, 'true']) {
      const p = clone(policy); delete p.carbonPromoted;
      if (value !== undefined) p.carbonPromoted = value;
      expect(panel({ policy: p })).toMatchObject({ ok: false, panel: [] });
    }
    const p = clone(policy); delete p.carbonPromoted;
    expect(panel({ policy: p, capacity: { ...capacity, carbonPromoted: true } }).ok).toBe(true);
    expect(panel({ policy: p, seats: [{ lens: 'style', counting: true }, { lens: 'style', counting: true },
      { lens: 'style', counting: false }] }).ok).toBe(true);
  });
  it.each([false, 'true'])('refuses counting Carbon when policy promotion is %j despite true capacity evidence', carbonPromoted => {
    const p = clone(policy); p.carbonPromoted = carbonPromoted;
    expect(panel({ policy: p, capacity: { ...capacity, carbonPromoted: true } }))
      .toEqual({ ok: false, panel: [], refusal: 'single-family-panel' });
  });
  it('excludes small model identities at runtime from every key lens and strong shape even with a strong tier', () => {
    for (const weak of [entry('codex', 'luna', 'openai', 'strong', 1),
      entry('claude', 'haiku', 'anthropic', 'strong', 1),
      entry('agy-gemini', 'hydrogen', 'google', 'strong', 1),
      entry('agy-gemini', 'flash', 'google', 'strong', 1)]) {
      const p = clone(policy); p.strongArms.push(id(weak.arm));
      Object.values(p.kinds).forEach(k => { k.arms = [weak]; });
      for (const lens of ['correctness', 'security', 'red-team', 'style']) {
        for (const shape of lens === 'style' ? ['security', 'merge-path'] : ['normal']) {
          const otherBuilder = weak.arm.provider === 'codex' ? arms[2].arm : builder;
          expect(panel({ policy: p, builder: otherBuilder, shape,
            seats: [{ lens, counting: true }, { lens: 'style', counting: true }] })).toMatchObject({ ok: false, panel: [] });
        }
      }
    }
  });
  it('same kind and subject always pick the same arm; shares within 2% over 10k keys', () => {
    const counts = Object.fromEntries(arms.map(a => [a.arm.provider, 0]));
    for (let i = 0; i < 10000; i++) {
      const subject = `repo#${i}`;
      const result = draw({ subject });
      expect(result).toEqual(draw({ subject }));
      counts[result.arm.provider]++;
    }
    for (const a of arms) expect(Math.abs(counts[a.arm.provider] / 10000 - a.share / 100)).toBeLessThan(.02);
    const digest = createHash('sha256').update('rot:build:repo#1').digest();
    expect(draw().bucket).toBe(Number(digest.readBigUInt64BE(0) >> 11n) / 2 ** 53);
  });
  it('shares follow projected spare capacity; a provider at 0 spare gets 0; Gemini with unused quota gets the largest share', () => {
    const cap = clone(capacity);
    cap.codex.usedPct = 100;
    cap['agy-gemini'] = { usedPct: 0, hoursToReset: .1, manualResetsHeld: 2, available: true };
    const shares = effectiveShares({ arms }, cap, policy);
    expect(shares[0].share).toBe(0);
    expect(shares[1].share).toBeGreaterThan(shares[2].share);
    expect(shares[1].share).toBeCloseTo(15000 / 15300);
    expect(shares.reduce((sum, a) => sum + a.share, 0)).toBeCloseTo(1);
    cap.claude.available = false;
    expect(effectiveShares({ arms }, cap, policy)[2].share).toBe(0);
    delete cap['agy-gemini'];
    expect(draw({ capacity: cap }).refusal).toBe('no-eligible-arm');
  });
  it('never seats a panel whose counting reviewers are one vendor family', () => {
    expect(panel({ seats: [seats[0]] })).toMatchObject({ ok: false, refusal: 'single-family-panel' });
    expect(panel({ seats: [seats[0], { lens: 'style', counting: false }] })).toMatchObject({ ok: false, refusal: 'single-family-panel' });
    const p = clone(policy); p.minPanelFamilies = 3;
    expect(panel({ policy: p }).ok).toBe(false);
    for (let i = 0; i < 100; i++) {
      const result = panel({ subject: `card:${i}` });
      expect(result.ok).toBe(true);
      expect(new Set(result.panel.map(s => arms.find(a => id(a.arm) === id(s.arm)).family)).size).toBe(2);
    }
  });
  it("correctness, security and red-team seats never use the builder's family", () => {
    for (let i = 0; i < 501; i++) for (const lens of policy.keyLenses) {
      const result = panel({ seats: [{ lens, counting: true }, { lens: 'style', counting: true }], subject: `repo#${i}` });
      expect(result.ok).toBe(true);
      expect(result.panel[0].arm.provider).not.toBe('codex');
    }
    expect(panel({ capacity: { codex: capacity.codex } })).toMatchObject({ ok: false, refusal: 'no-cross-vendor-seat' });
    const p = clone(policy);
    p.kinds['review-security'].arms = [entry('openai', 'sol', 'openai', 'strong', 1)];
    expect(panel({ policy: p, capacity: { ...capacity, openai: capacity.codex } })).toMatchObject({ ok: false, refusal: 'no-cross-vendor-seat' });
  });
  it('security lens and merge-path shapes keep a strong reviewer; Flash never drawn there', () => {
    const p = clone(policy);
    p.catalog.claude.sonnet.push('medium');
    const weak = [entry('claude', 'sonnet', 'anthropic', 'standard', 1000, 'medium'),
      entry('agy-gemini', 'flash', 'google', 'standard', 1000),
      entry('agy-gemini', 'hydrogen', 'google', 'small', 1000),
      entry('codex', 'luna', 'openai', 'small', 1000), entry('claude', 'haiku', 'anthropic', 'small', 1000)];
    Object.values(p.kinds).forEach(k => k.arms.push(...weak));
    for (let i = 0; i < 501; i++) for (const shape of ['normal', 'security', 'merge-path']) {
      const result = panel({ policy: p, shape, subject: `repo#${i}` });
      expect(result.ok).toBe(true);
      for (const seat of result.panel) if (shape !== 'normal' || seat.lens === 'security')
        expect(['flash', 'hydrogen', 'luna', 'haiku']).not.toContain(seat.arm.model);
      for (const seat of result.panel.filter(s => s.lens === 'security')) {
        expect(p.strongArms).toContain(id(seat.arm));
        expect(seat.arm.model).not.toMatch(/flash|hydrogen|luna|haiku/);
      }
      expect(result.panel.some(s => p.strongArms.includes(id(s.arm)))).toBe(true);
    }
    Object.values(p.kinds).forEach(k => { k.arms = weak; });
    for (const shape of ['security', 'merge-path'])
      expect(panel({ policy: p, shape })).toMatchObject({ ok: false, refusal: 'no-strong-seat' });
  });
  it('oversized panels refuse and leave the PR waiting without a partial panel', () => {
    expect(panel({ seats: Array.from({ length: 17 }, () => seats[0]) }))
      .toEqual({ ok: false, panel: [], refusal: 'panel-too-large' });
  });
  it('mode off gives a byte-identical route', () => {
    const legacyRoute = { provider: 'legacy', nested: { args: ['a', 'b'] } };
    const before = JSON.stringify(legacyRoute);
    const result = routeFor({ policy: { mode: 'off' }, legacyRoute });
    expect(result).toBe(legacyRoute);
    expect(JSON.stringify(result)).toBe(before);
  });
  it('shadow preserves the legacy route; on derives the route from the arm', () => {
    const legacyRoute = { provider: 'legacy' };
    const args = { kind: 'build', subject: 'card:1', policy, capacity, legacyRoute };
    const result = routeFor(args);
    expect(result.route).toBe(legacyRoute);
    expect(result.shadow).toEqual(draw({ subject: 'card:1' }));
    expect(routeFor({ ...args, policy: { ...policy, mode: 'on' } })).toEqual({ route: result.shadow.arm, shadow: null });
    expect(routeFor({ ...args, capacity: {} }).shadow.arm).toBeNull();
    expect(routeFor({ ...args, policy: { ...policy, mode: 'on' }, capacity: {} }).route).toBeNull();
  });
  it('fails closed for unknown kind, unreadable or incomplete policy, unknown shape and missing capacity', () => {
    expect(draw({ kind: 'unknown' }).refusal).toBe('unknown-kind');
    expect(draw({ capacity: undefined }).refusal).toBe('missing-capacity');
    for (const p of [undefined, null, 'unreadable', {}, { ...policy, mode: 'invalid' }, { ...policy, strongArms: null }]) {
      expect(draw({ policy: p }).arm).toBeNull();
      expect(panel({ policy: p }).ok).toBe(false);
    }
    expect(panel({ shape: 'unknown' })).toMatchObject({ ok: false, refusal: 'unknown-shape' });
    expect(panel({ capacity: undefined }).ok).toBe(false);
    expect(panel({ builder: { provider: 'unknown' } }).ok).toBe(false);
    expect(panel({ seats: [{ lens: 'style' }] }).ok).toBe(false);
    expect(draw({ subject: undefined }).arm).toBeNull();
    const bad = clone(policy); bad.kinds.build.arms[0].share = -1;
    expect(draw({ policy: bad }).arm).toBeNull();
  });
  it('logs deterministic redraws and refuses when no arm remains', () => {
    const first = draw();
    const result = draw({ exclude: [id(first.arm)] });
    expect(result.arm).not.toEqual(first.arm);
    expect(result.redrawn).toEqual([id(first.arm)]);
    expect(result.bucket).toBe(first.bucket);
    expect(result.ineligible).toContain(id(first.arm));
    const all = arms.map(a => id(a.arm));
    const refused = draw({ exclude: all });
    expect(refused).toMatchObject({ arm: null, refusal: 'no-eligible-arm' });
    expect(new Set(refused.redrawn)).toEqual(new Set(all));
    expect(draw({ capacity: {} }).arm).toBeNull();
    for (const bad of [{ available: true }, { ...capacity.codex, usedPct: NaN },
      { ...capacity.codex, hoursToReset: -1 }, { ...capacity.codex, manualResetsHeld: -1 }]) {
      expect(draw({ capacity: Object.fromEntries(arms.map(a => [a.arm.provider, bad])) }).arm).toBeNull();
    }
  });
  it('never mutates inputs and freezes newly created output recursively', () => {
    const args = freeze(clone({ kind: 'build', subject: 'card:1', policy, capacity }));
    const before = JSON.stringify(args);
    const result = drawArm(args);
    expect(JSON.stringify(args)).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.arm)).toBe(true);
    expect(Object.isFrozen(result.redrawn)).toBe(true);
    expect(Object.isFrozen(effectiveShares(args.policy.kinds.build, args.capacity, args.policy))).toBe(true);
    const composed = panel({ policy: args.policy, capacity: args.capacity });
    expect(Object.isFrozen(composed.panel)).toBe(true);
    expect(Object.isFrozen(composed.panel[0].arm)).toBe(true);
  });
  it('engine purity excludes ambient IO, environment, clock and random reads', () => {
    const source = readFileSync('scripts/lib/provider-rotation.mjs', 'utf8');
    for (const forbidden of ['node:fs', 'process.env', 'Math.random', 'Date.now']) expect(source).not.toContain(forbidden);
  });
  it('policy covers every dispatch kind and Codex holds the largest base share in each', () => {
    const p = realPolicy(); expect(p.carbonPromoted).toBe(false);
    expect(Object.keys(p.kinds).sort()).toEqual(['build', 'fix', 'ci-heal', 'prepare', 'audit',
      'review-correctness', 'review-security', 'review-lens', 'red-team', 'judge', 'summary', 'doc-fix'].sort());
    for (const [kind, { arms: choices }] of Object.entries(p.kinds)) {
      const sums = {};
      for (const a of choices) { expect(a.share).toBeGreaterThan(0); sums[a.arm.provider] = (sums[a.arm.provider] || 0) + a.share;
        expect(a.arm.provider).not.toBe('agy-claude'); }
      for (const [provider, share] of Object.entries(sums)) if (provider !== 'codex') expect(sums.codex).toBeGreaterThan(share);
      if (kind === 'audit') expect(Object.keys(sums)).toEqual(['codex']);
      else { expect(sums.claude).toBeGreaterThan(0); expect(sums['agy-gemini']).toBeGreaterThan(0); }
      if (['review-security', 'review-correctness', 'red-team', 'audit'].includes(kind))
        expect(choices.every(a => !p.smallTiers.includes(a.tier))).toBe(true);
    }
    expect(p.kinds.summary.arms.some(a => a.arm.model.includes('hydrogen'))).toBe(true);
    expect(p.kinds.summary.arms.some(a => a.arm.model.includes('haiku'))).toBe(true);
  });
  it('the shipped policy draws and composes strong diverse panels', () => {
    const p = realPolicy(); expect(p.carbonPromoted).toBe(false);
    for (const kind of Object.keys(p.kinds)) expect(draw({ policy: p, kind, builder,
      ...(kind === 'review-lens' ? { lens: 'style' } : {}) }).arm).not.toBeNull();
    for (const shape of ['security', 'merge-path'])
      expect(panel({ policy: p, shape, builder: { provider: 'agy-gemini', model: 'gemini-4-carbon', effort: 'high' } }))
        .toMatchObject({ ok: true, refusal: null });
  });
  it('strong-arm model aliases are supported', () => {
    const p = realPolicy(); p.carbonPromoted = true; p.strongArms = ['sol-high', 'carbon-high', 'sonnet-5-5'];
    const result = panel({ policy: p, shape: 'merge-path', builder });
    expect(result.ok).toBe(true);
    expect(result.panel.some(s => s.arm.model === 'gemini-4-carbon')).toBe(true);
    p.strongArms = p.strongArms.filter(alias => alias !== 'carbon-high');
    expect(panel({ policy: p, shape: 'merge-path', builder })).toMatchObject({ ok: false, panel: [] });
  });
  it('policy mode is shadow', () => { expect(realPolicy().mode).toBe('shadow'); });
});
