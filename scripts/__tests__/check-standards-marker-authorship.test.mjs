import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // Two flagged parsers in one file get distinct messages (the #2863 dedup guard keys on message + file).
  const two = scan(parser + '\n' + parser.replace('parseActions', 'parseOther')).map(f => f.message);
  expect(new Set(two).size).toBe(2);
  expect(two[0]).toContain('parseActions');
  // A reviewed pre-existing parser is exempt by name; a new parser in the same file is not.
  const reviewed = (name) => scanUnauthenticatedCommentMarkerParsers([{ file: 'scripts/lib/red-team-gate.mjs', content: parser.replace('parseActions', name) }]);
  expect(reviewed('gateOutcomesForHead')).toEqual([]);
  expect(reviewed('parseNewThing')).toHaveLength(1);
  // Source-code scanners inspect these spellings; they do not read PR comments.
  expect(scan('export function scanCommentMarkerParsers(docs) { return docs.filter(d => /<!--|\\.body/.test(d.content)); }')).toEqual([]);
});

it.each([
  ['!isTrustedMarkerAuthor(c) || typeof c?.body !== "string"', true],
  ['typeof c?.body !== "string" || !isTrustedMarkerAuthor(c)', true],
  ['(!isTrustedMarkerAuthor(c)) || !c || typeof c.body !== "string"', true],
  ['!c || ((!isTrustedMarkerAuthor(c)) || typeof c.body !== "string")', true],
  ['!(isTrustedMarkerAuthor(c))', true],
  ['((!isTrustedMarkerAuthor(c)))', true],
  ['!isTrustedMarkerAuthor(c) && typeof c?.body !== "string"', false],
  ['!c || (!isTrustedMarkerAuthor(c) && typeof c.body !== "string")', false],
  ['isTrustedMarkerAuthor(c) || typeof c?.body !== "string"', false],
  ['!!isTrustedMarkerAuthor(c) || typeof c?.body !== "string"', false],
  ['!isTrustedMarkerAuthor(c) ?? true', false],
])('recognizes rejecting guard %s (safe: %s)', (condition, safe) => {
  const content = `import { isTrustedMarkerAuthor } from "../lib/marker-authorship.mjs";
    export function parseActions(comments) { return comments.flatMap(c => {
      if (${condition}) return [];
      return c.body.match(/<!-- action: (.*?) -->/g);
    }); }`;
  expect(scanUnauthenticatedCommentMarkerParsers([{ file: 'scripts/operations/example.mjs', content }]))
    .toHaveLength(safe ? 0 : 1);
});

it('accepts the live review ceremony parser with its compound author and body guard', () => {
  const file = 'scripts/review-set-label.mjs';
  const content = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../review-set-label.mjs'), 'utf8');
  expect(scanUnauthenticatedCommentMarkerParsers([{ file, content }])).toEqual([]);
});

it.each([
  'scripts/conveyor/exhausted-retry.mjs',
  'scripts/conveyor/round-extension-mark.mjs',
  'scripts/conveyor/standing-ruling-mark.mjs',
  'scripts/lib/operator-send-backs.mjs',
])('accepts reviewed readers in %s while still rejecting a new unauthenticated parser', file => {
  const content = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../..', file), 'utf8');
  expect(scanUnauthenticatedCommentMarkerParsers([{ file, content }])).toEqual([]);
  const unguarded = '\nexport function parseNewCommentMarker(comments) { return comments.flatMap(c => c.body.match(/<!-- action: (.*?) -->/g)); }';
  const findings = scanUnauthenticatedCommentMarkerParsers([{ file, content: content + unguarded }]);
  expect(findings).toHaveLength(1);
  expect(findings[0].message).toContain('parseNewCommentMarker');
});
