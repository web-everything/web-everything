// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

// Catch bare API argv literals, including templates containing nested job-id expressions.
const bareLogApi = /\[\s*['"]api['"]\s*,\s*([`'"])(?:(?!\1)[\s\S])*?\/logs\1\s*\]/g;
const directories = [new URL('../', import.meta.url), new URL('../../conveyor/', import.meta.url)];
const files = directories.flatMap(directory => readdirSync(directory)
  .filter(name => /^drain-.*\.mjs$/.test(name)).map(name => new URL(name, directory)));

describe('drain job-log transport', () => {
  it('detects a bare log API call and accepts the shared helper', () => {
    expect("exec('gh', ['api', `repos/${repo}/actions/jobs/${id}/logs`])".match(bareLogApi)).toHaveLength(1);
    expect("exec('gh', ciJobLogApiArgs(`repos/${repo}/actions/jobs/${id}/logs`))".match(bareLogApi)).toBeNull();
  });

  it.each(files)('%s has no bare log API argv bypassing ciJobLogApiArgs', file => {
    expect(readFileSync(file, 'utf8').match(bareLogApi)).toBeNull();
  });
});

// Inspect every literal /logs endpoint, following argv arrays and the transport helper
// to the read call. The first consumer must normalize the whole result, never a slice.
function rawJobLogReads(source) {
  const tree = ts.createSourceFile('drain.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bypasses = [];
  const visit = node => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
      && /(?:repos\/|actions\/)[\s\S]*\/logs[`'" ]*$/.test(node.getText(tree))) {
      let read = node.parent;
      while (read && !ts.isCallExpression(read)) read = read.parent;
      if (read?.expression.getText(tree) === 'ciJobLogApiArgs') read = read.parent;
      const consumer = read?.parent;
      if (!consumer || !ts.isCallExpression(consumer)
        || consumer.expression.getText(tree) !== 'readNormalizedJobLog'
        || consumer.arguments.length !== 1 || consumer.arguments[0] !== read) {
        bypasses.push(node.getText(tree));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return bypasses;
}

describe('drain whole-log normalization boundary', () => {
  it.each([
    "const text = exec('gh', ciJobLogApiArgs(`repos/${repo}/actions/jobs/${id}/logs`)); use(text);",
    "return { text: exec('gh', ['api', 'repos/r/actions/jobs/1/logs']) };",
    "readNormalizedJobLog(read(`actions/jobs/${id}/logs`).slice(-65536));",
    "const raw = read(`actions/jobs/${id}/logs`); readNormalizedJobLog(raw); use(raw);",
  ])('detects raw or pre-sliced job-log consumption: %s', source => {
    expect(rawJobLogReads(source)).toHaveLength(1);
  });

  it('accepts normalization immediately around the full read', () => {
    expect(rawJobLogReads("const log = readNormalizedJobLog(exec('gh', ciJobLogApiArgs(`repos/${repo}/actions/jobs/${id}/logs`)));"))
      .toEqual([]);
  });

  it.each(files)('%s routes every job-log read through readNormalizedJobLog', file => {
    expect(rawJobLogReads(readFileSync(file, 'utf8'))).toEqual([]);
  });
});
