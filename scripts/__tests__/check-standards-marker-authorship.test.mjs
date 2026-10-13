import { it, expect } from 'vitest';
import { scanUnauthenticatedCommentMarkerParsers } from '../check-standards-rules.mjs';

it('requires shared authorship for inline comment-marker parsers, accepting aliased gates', () => {
  const parser = 'export function parseActions(comments) { return comments.flatMap(c => c.body.match(/<!-- action: (.*?) -->/g)); }';
  const scan = content => scanUnauthenticatedCommentMarkerParsers([{ file: 'scripts/operations/example.mjs', content }]);
  expect(scan(parser)).toHaveLength(1);
  expect(scan('import { isTrustedMarkerAuthor as trusted } from "../lib/marker-authorship.mjs";\n' + parser.replace('comments.flatMap', 'comments.filter(trusted).flatMap'))).toEqual([]);
  expect(scan('const isTrustedMarkerAuthor = () => true;\n' + parser.replace('comments.flatMap', 'comments.filter(isTrustedMarkerAuthor).flatMap'))).toHaveLength(1);
  expect(scan('import { isTrustedMarkerAuthor } from "../lib/marker-authorship.mjs";\n' + parser.replace('return comments', 'void isTrustedMarkerAuthor; return comments'))).toHaveLength(1);
  expect(scan('import { isTrustedMarkerAuthor } from "../lib/marker-authorship.mjs";\n' + parser.replace('c => c.body', 'c => { isTrustedMarkerAuthor(c); return c.body').replace(')); }', '); }); }'))).toHaveLength(1);
  expect(scan('import { isTrustedMarkerAuthor } from "../lib/marker-authorship.mjs";\n' + parser.replace('comments.flatMap', 'comments.filter(c => isTrustedMarkerAuthor(c)).flatMap'))).toEqual([]);
  const importGate = 'import { isTrustedMarkerAuthor } from "../lib/marker-authorship.mjs";\n';
  const callback = guard => `${importGate}export function parseActions(comments) { return comments.flatMap(c => { ${guard} return c.body.match(/<!-- action: (.*?) -->/g); }); }`;
  expect(scan(callback('if (isTrustedMarkerAuthor(c)) void 0;'))).toHaveLength(1);
  expect(scan(callback('if (!isTrustedMarkerAuthor(c)) void 0;'))).toHaveLength(1);
  expect(scan(callback('if (isTrustedMarkerAuthor(c)) return [];'))).toHaveLength(1);
  expect(scan(callback('if (!isTrustedMarkerAuthor(c)) return c.body.match(/<!-- action: (.*?) -->/g);'))).toHaveLength(1);
  expect(scan(callback('if (!isTrustedMarkerAuthor(c)) return [];'))).toEqual([]);
  expect(scan(callback('if (!isTrustedMarkerAuthor(c)) { return []; }'))).toEqual([]);
  expect(scan(importGate + parser.replace('comments.flatMap', 'comments.filter(c => !isTrustedMarkerAuthor(c)).flatMap'))).toHaveLength(1);
  expect(scan(importGate + parser.replace('comments.flatMap', 'comments.filter(c => (isTrustedMarkerAuthor(c))).flatMap'))).toEqual([]);
  expect(scan(parser.replaceAll('comments', 'thread'))).toHaveLength(1);
  expect(scan('const marker = /<!-- action: (.*?) -->/g;\n' + parser.replace('/<!-- action: (.*?) -->/g', 'marker'))).toHaveLength(1);
  expect(scan('// <!-- documented marker -->\nexport function parseActions(comments) { return comments.map(c => c.body); }')).toEqual([]);
  // Source-code scanners inspect these spellings; they do not read PR comments.
  expect(scan('export function scanCommentMarkerParsers(docs) { return docs.filter(d => /<!--|\\.body/.test(d.content)); }')).toEqual([]);
});
