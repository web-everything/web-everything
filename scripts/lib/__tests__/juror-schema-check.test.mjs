import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { compileJurorSchema } from '../juror-schema-check.mjs';
import { REVIEW_JUDGE_SHAPE, REFERRAL_VERIFIER_SHAPE } from '../../operations/review-pr.mjs';
import { REVIEW_PREP_JUDGE_SHAPE } from '../../operations/review-prep.mjs';
import { RECHECK_SHAPE } from '../../operations/review-extra-seats.mjs';
import { SAMPLE_SHAPE } from '../../operations/coroner-sample.mjs';
import { ESTIMATE_SHAPE } from '../../operations/perf-velocity-io.mjs';
import { SYNTHESIS_SHAPE } from '../../operations/explore.mjs';
import { TARGETED_CHECK_SHAPE } from '../../conveyor/convert-advisory-dispatch.mjs';
import { WORKER_RESULT_SCHEMA } from '../../operations/worker-result.mjs';

// Read private/inline literal schemas without executing their modules or copying shapes.
function literalSchemas(path, variable) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function literal(node) {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(p => [p.name.text, literal(p.initializer)]));
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'Object.freeze') return literal(node.arguments[0]);
    throw new Error(`Nonliteral schema in ${path}: ${node.getText(source)}`);
  }
  const found = [];
  function visit(node) {
    if ((variable && ts.isVariableDeclaration(node) && node.name.getText(source) === variable)
      || (!variable && ts.isPropertyAssignment(node) && node.name.getText(source) === 'shape'
        && ts.isObjectLiteralExpression(node.initializer))) found.push(literal(node.initializer));
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(found.length).toBeGreaterThan(0);
  return found;
}

const schemas = Object.entries({ REVIEW_JUDGE_SHAPE, REFERRAL_VERIFIER_SHAPE, REVIEW_PREP_JUDGE_SHAPE,
  RECHECK_SHAPE, SAMPLE_SHAPE, ESTIMATE_SHAPE, SYNTHESIS_SHAPE, TARGETED_CHECK_SHAPE, WORKER_RESULT_SCHEMA });
for (const [path, variable] of [
  ['../brief-red-team.mjs', 'SHAPE'],
  ['../../operations/coroner-judge.mjs', 'SHAPE'],
  ['../../operations/record-referral-ruling-io.mjs', null],
  ['../../operations/review-pr-io.mjs', null],
  ['../../operations/__fixtures__/fixture-operation.mjs', 'FIXTURE_JUDGE_SHAPE'],
]) literalSchemas(path, variable).forEach((schema, index) => schemas.push([`${path}:${index}`, schema]));

// Populate optional fields and nonempty arrays too, exercising nested schema constraints.
function sample(s) {
  if (s.enum) return structuredClone(s.enum[0]);
  if (s.anyOf) return sample(s.anyOf.at(-1));
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === 'object') return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v)]));
  if (type === 'array') return s.maxItems === 0 ? [] : [sample(s.items ?? {})];
  if (type === 'string') return 'x'.repeat(s.minLength ?? 1);
  if (type === 'boolean') return true;
  if (type === 'number' || type === 'integer') return 1;
  return null;
}

describe('current juror schema inventory', () => {
  it.each(schemas)('%s validates a conforming sample and rejects a nonconforming one', (_name, schema) => {
    const validate = compileJurorSchema(schema);
    const value = sample(schema);
    expect(validate(value)).toBe(true);
    delete value[schema.required[0]];
    expect(validate(value)).toBe(false);
  });
});

describe('strict synchronous subset', () => {
  it.each(['$async', 'format', 'unevaluatedProperties', '$ref', 'allOf', 'minItems'])('rejects %s even in an unused branch', keyword => {
    expect(() => compileJurorSchema({ properties: { unused: { [keyword]: true } } })).toThrow(keyword);
    expect(() => compileJurorSchema({ anyOf: [{}, { [keyword]: true }] })).toThrow(keyword);
  });
  it.each([
    { $async: true }, { format: 'uri' }, { unevaluatedProperties: false },
    { type: ['string', 'bogus'] }, { type: [] }, { required: 'x' }, { required: [1] },
    { properties: [] }, { items: [] }, { additionalProperties: null }, { enum: [] },
    { minLength: -1 }, { maxLength: 1.5 }, { maxItems: '2' }, { anyOf: [] }, { description: 1 },
  ])('throws at schema-check time for %j', schema => {
    expect(() => compileJurorSchema(schema)).toThrow();
  });
  it('rejects a numeric verdict without coercion and returns a synchronous boolean', () => {
    const validate = compileJurorSchema({ properties: { verdict: { type: 'string' } } });
    expect(validate({ verdict: 123 })).toBe(false);
    expect(validate({ verdict: 'accept' })).toBe(true);
  });
  it('checks all types, nullable unions and finite numbers', () => {
    for (const [type, good, bad] of [['object', {}, []], ['array', [], {}], ['string', 'x', 1],
      ['number', 1.5, Infinity], ['integer', 1, 1.5], ['boolean', false, 0], ['null', null, {}]]) {
      const validate = compileJurorSchema({ type });
      expect(validate(good)).toBe(true);
      expect(validate(bad)).toBe(false);
    }
    const nullable = compileJurorSchema({ type: ['string', 'null'] });
    expect(nullable(null)).toBe(true);
    expect(nullable(1)).toBe(false);
  });
  it('enforces schema-valued additionalProperties and own required properties', () => {
    const validate = compileJurorSchema({ required: ['x'], additionalProperties: { type: 'integer' } });
    expect(validate({ x: 1 })).toBe(true);
    expect(validate({ x: '1' })).toBe(false);
    expect(validate(Object.create({ x: 1 }))).toBe(false);
  });
  it('compares enum objects structurally', () => {
    const validate = compileJurorSchema({ enum: [{ a: 1, b: [2] }] });
    expect(validate({ b: [2], a: 1 })).toBe(true);
    expect(validate({ a: 1, b: ['2'] })).toBe(false);
  });
  it('enforces audited extensions, including Unicode string length and nonselected branch checking', () => {
    const text = compileJurorSchema({ minLength: 1, maxLength: 1 });
    expect(text('😀')).toBe(true);
    expect(text('')).toBe(false);
    expect(text('xx')).toBe(false);
    const list = compileJurorSchema({ maxItems: 1, items: { type: 'string' } });
    expect(list(['x'])).toBe(true);
    expect(list(['x', 'x'])).toBe(false);
    expect(list([1])).toBe(false);
    const union = compileJurorSchema({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(union(null)).toBe(true);
    expect(union(123)).toBe(false);
  });
  it('treats property names and enum contents as data, including format', () => {
    expect(compileJurorSchema({ properties: { format: { enum: [{ format: 'uri' }] } } })({ format: { format: 'uri' } })).toBe(true);
  });
  it('bounds oversized keyword diagnostics and tells the caller to fix cyclic schemas', () => {
    expect(() => compileJurorSchema({ ['private' + 'x'.repeat(10000)]: true })).toThrow('<redacted keyword>');
    const cyclic = {}; cyclic.items = cyclic;
    expect(() => compileJurorSchema(cyclic)).toThrow('schema');
  });
});
