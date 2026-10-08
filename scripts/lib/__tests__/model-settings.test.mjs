import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED, MODEL_SETTINGS_FILE, modelSetting, readModelSettings } from '../model-settings.mjs';
import { DEFAULTS, resolveKnobs } from '../../operations/coroner-sample.mjs';
import { ESTIMATE_MODEL, estimateModel } from '../../operations/perf-velocity-io.mjs';

const tmp = (text) => { const f = join(mkdtempSync(join(tmpdir(), 'ms-')), 's.json'); writeFileSync(f, text); return f; };

describe('model-settings', () => {
  it('ships Haiku 5.5 for exactly the three cheap advisory uses, and nothing else', () => {
    const s = readModelSettings();
    expect(s).toEqual({ coroner: { sampleModel: 'claude-haiku-5-5' }, velocity: { estimateModel: 'claude-haiku-5-5' }, prepReview: { model: 'claude-haiku-5-5' } });
    expect(Object.keys(JSON.parse(readFileSync(MODEL_SETTINGS_FILE, 'utf8'))).filter((k) => !k.startsWith('_')).sort()).toEqual(Object.keys(ALLOWED).sort());
  });
  it('drops unknown groups (a build/fix/review-seat model can never be set here), bad ids and torn files', () => {
    expect(readModelSettings(tmp('{"build":{"model":"claude-haiku-5-5"},"coroner":{"sampleModel":"--bare"},"velocity":{"estimateModel":"x y"}}'))).toEqual({});
    expect(readModelSettings(tmp('{torn'))).toEqual({});
    expect(readModelSettings('/nonexistent/file.json')).toEqual({});
  });
  it('falls back to the product default when a key is unset', () => {
    expect(modelSetting('coroner', 'sampleModel', 'haiku', {})).toBe('haiku');
    expect(modelSetting('coroner', 'sampleModel', 'haiku', { coroner: { sampleModel: 'claude-haiku-5-5' } })).toBe('claude-haiku-5-5');
  });
  it('coroner: flag > env > setting > default; product default unchanged', () => {
    const settings = { coroner: { sampleModel: 'claude-haiku-5-5' } };
    expect(DEFAULTS.model).toBe('haiku');
    expect(resolveKnobs({ values: {}, env: {}, settings }).model).toBe('claude-haiku-5-5');
    expect(resolveKnobs({ values: {}, env: { WE_CORONER_SAMPLE_MODEL: 'sonnet' }, settings }).model).toBe('sonnet');
    expect(resolveKnobs({ values: { model: 'opus' }, env: { WE_CORONER_SAMPLE_MODEL: 'sonnet' }, settings }).model).toBe('opus');
    expect(resolveKnobs({ values: {}, env: {}, settings: {} }).model).toBe('haiku');
  });
  it('velocity: setting wins over the unchanged product default', () => {
    expect(ESTIMATE_MODEL).toBe('haiku');
    expect(estimateModel({ velocity: { estimateModel: 'claude-haiku-5-5' } })).toBe('claude-haiku-5-5');
    expect(estimateModel({})).toBe('haiku');
  });
});
