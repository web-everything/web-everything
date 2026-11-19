import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUiFastLane, parseRawDiffZ, addedLinesFromPatch, resolveUiFastLaneSettings, gatherUiFastLaneEvidence, classifyFromGit } from '../review-ui-fast-lane.mjs';

const repo = 'plateauapp/plateau-app';
const settings = { enabled: false, seats: 1, redTeam: false, nitpicksBlock: false, maxFiles: 60,
  paths: { [repo]: ['src/styles/**', 'src/backlog-view/**', 'src/main.ts'] } };
const entry = (path = 'src/styles/a.css', extra = {}) => ({ path, status: 'M', mode: '100644', ...extra });
const classify = extra => classifyUiFastLane({ repo, settings, entries: [entry()], ...extra });

test('classifier threat table and UI happy paths (disabled still shadows)', async t => {
  const cases = [
    ...['120000', '100755', '160000'].map(mode => [`mode ${mode}`, { entries: [entry(undefined, { mode })] }, 'bad-mode']),
    ['old executable mode', { entries: [entry(undefined, { oldMode: '100755', newMode: '100644' })] }, 'bad-mode'],
    ['unknown mode', { entries: [entry(undefined, { mode: undefined })] }, 'bad-mode'],
    ['rename non-UI delete plus UI add', { entries: [entry('src/server.ts', { status: 'D' }), entry(undefined, { status: 'A' })] }, 'not-in-allowlist'],
    ...['.github/x', 'src/styles/.x', 'src/.hidden/a.css', 'package.json', 'package-lock.json', 'src/styles/package-other.json',
      'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'npm-shrinkwrap.json', 'src/styles/vite.config.css', 'scripts/a.css', 'tools/a.css',
      'functions/a.css', 'packages/a.css', 'src/wip/a.css', 'src/_data/a.css', 'src/styles/a.mjs', 'src/styles/a.cjs',
      'src/styles/a.sh', 'src/styles/a.yml', 'src/styles/a.yaml', 'src/styles/．hidden/a.css', 'src/styles/．．/a.css',
      '/src/styles/a.css', 'src/styles/../a.css', 'src\\styles\\a.css', 'src/styles/a\0.css', 'C:/src/styles/a.css', 'src/styles/CONFIG.css']
      .map(path => [path, { entries: [entry(path)] }, 'hard-floor']),
    ...['import "node:path"', 'child_process', 'import fs from "fs"', 'process.env.KEY', 'eval("x")', 'new Function("x")',
      'x.innerHTML = y', 'x.outerHTML = y', 'x.insertAdjacentHTML(x,y)', 'document.write(x)',
      'import { x } from "../server.ts"', 'require("../../server")', 'import("../server")', 'import(variable)']
      .map(line => [line, { addedLines: { 'src/styles/a.css': [line] } }, 'tripwire']),
    ['reverse import', { importers: { 'src/styles/a.css': ['src/server.ts'] } }, 'reverse-import'],
    ['empty', { entries: [] }, 'empty-diff'],
    ['60 passes', { entries: Array.from({ length: 60 }, (_, i) => entry(`src/styles/${i}.css`)) }, 'ui-only'],
    ['61 rejects', { entries: Array.from({ length: 61 }, (_, i) => entry(`src/styles/${i}.css`)) }, 'too-many-files'],
    ['unlisted repo', { repo: 'web-everything/web-everything' }, 'repo-not-listed'],
    ['root HTML', { entries: [entry('index.html')] }, 'not-in-allowlist'],
    ['CSS', { addedLines: { 'src/styles/a.css': ['body { color: red; }'] } }, 'ui-only'],
    ['TS and UI relative import', { entries: [entry('src/main.ts')], addedLines: { 'src/main.ts': ['import "./styles/a.css";', 'import x from "package";'] } }, 'ui-only'],
    ['glob star does not span directories', { settings: { ...settings, paths: { [repo]: ['src/styles/*'] } }, entries: [entry('src/styles/sub/a.css')] }, 'not-in-allowlist'],
    ['NFKC normalizes fullwidth letters', { entries: [entry('src/ｓｔｙｌｅｓ/a.css')] }, 'ui-only'],
  ];
  for (const [name, input, reason] of cases) await t.test(name, () => {
    const result = classify(input);
    assert.equal(result.reason, reason);
    assert.equal(result.verdict, reason === 'ui-only' ? 'ui-fast-lane' : 'full-panel');
    if (['bad-mode', 'hard-floor', 'not-in-allowlist', 'tripwire', 'reverse-import'].includes(reason)) assert.ok(result.detail);
  });
});

test('raw diff includes both modes and deleted rename source', () => {
  const entries = parseRawDiffZ(Buffer.from(':100644 000000 abc 000 D\0src/server.ts\0:000000 100644 000 def A\0src/styles/a.css\0'));
  assert.equal(entries[0].oldMode, '100644');
  assert.equal(entries[0].newMode, '000000');
  assert.equal(classify({ entries }).reason, 'not-in-allowlist');
  assert.throws(() => parseRawDiffZ(':100644 100644 a b M\0truncated'));
  assert.deepEqual(parseRawDiffZ(''), []);
});

test('patch parser collects only added content, including lines starting +++', () => {
  const lines = addedLinesFromPatch('diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1,2 @@\n-old\n+new\n++++content\n');
  assert.deepEqual(lines['src/main.ts'], ['new', '+++content']);
});

test('settings fail closed on unreadable/malformed file and any invalid whole block', () => {
  const read = block => () => JSON.stringify({ uiFastLane: block });
  const invalid = [null, [], false, { enabled: 'true' }, { seats: 2 }, { seats: '1' }, { redTeam: 0 }, { nitpicksBlock: 'false' },
    { paths: { [repo]: 'src/styles/**' } }, { paths: { [repo]: [1] } }, { maxFiles: 0 }, { maxFiles: 1.5 }, { maxFiles: Number.MAX_SAFE_INTEGER + 1 }];
  for (const value of invalid) {
    const result = resolveUiFastLaneSettings({ env: {}, platform: settings, readFile: read(value), log() {} });
    assert.equal(result.value.enabled, false);
    assert.deepEqual(result.value.paths, {});
  }
  for (const readFile of [() => { throw new Error('unreadable'); }, () => '{bad']) {
    assert.deepEqual(resolveUiFastLaneSettings({ env: {}, platform: settings, readFile, log() {} }).value.paths, {});
  }
});

test('settings cascade logs effective values and provenance', () => {
  const logs = [];
  const result = resolveUiFastLaneSettings({ env: { WE_REVIEW_UI_FAST_LANE_MAX_FILES: '12' }, platform: { enabled: true },
    readFile: () => JSON.stringify({ uiFastLane: settings }), log: line => logs.push(line) });
  assert.equal(result.value.enabled, false);
  assert.equal(result.value.maxFiles, 12);
  assert.equal(result.sources.enabled, 'tool');
  assert.equal(result.sources.maxFiles, 'env');
  assert.match(logs[0], /review.uiFastLane/);
  assert.ok(logs[0].includes('maxFiles=12'));
  assert.deepEqual(resolveUiFastLaneSettings({ env: {}, platform: {}, readFile: () => '{}', log() {} }).value.paths, {});
});

test('fetch failure yields full-panel fetch-failed', () => {
  const options = { settings, repo, run() { throw new Error('fetch failed'); } };
  assert.deepEqual(gatherUiFastLaneEvidence(options), { ok: false, reason: 'fetch-failed' });
  assert.deepEqual(classifyFromGit(options), { verdict: 'full-panel', reason: 'fetch-failed' });
});

test('gather pins fetched refs, diffs merge base, and filters reverse importers', () => {
  const oid = 'a'.repeat(40), calls = [];
  const run = args => {
    calls.push(args);
    if (['rev-parse', 'merge-base'].includes(args[0])) return oid + '\n';
    if (args[0] === 'diff' && args.includes('--raw')) return ':100644 100644 abc def M\0src/styles/a.css\0';
    if (args[0] === 'diff') return 'diff --git a/src/styles/a.css b/src/styles/a.css\n--- a/src/styles/a.css\n+++ b/src/styles/a.css\n@@ -1 +1 @@\n-old\n+new\n';
    if (args[0] === 'grep') return `${oid}:src/main.ts\0${oid}:src/server.ts\0`;
    return '';
  };
  const evidence = gatherUiFastLaneEvidence({ cwd: '.', base: 'main', head: 'refs/pull/1/head', repo, settings, run });
  assert.equal(evidence.ok, true);
  assert.deepEqual(evidence.importers['src/styles/a.css'], ['src/server.ts']);
  assert.equal(calls.filter(a => a[0] === 'fetch').length, 2);
  assert.ok(calls.some(a => a[0] === 'diff' && a.includes('--no-renames') && a.includes(oid)));
  assert.equal(classifyUiFastLane({ ...evidence, settings }).reason, 'reverse-import');
  assert.equal(classifyFromGit({ repo, settings, run, expectedHead: 'b'.repeat(40) }).reason, 'ref-mismatch');
});

test('incomplete diff and unreadable reverse grep fail closed; grep no-match is allowed', () => {
  const oid = 'a'.repeat(40);
  const options = failure => ({ repo, settings, run: args => {
    if (['rev-parse', 'merge-base'].includes(args[0])) return oid;
    if (args[0] === 'diff' && args.includes('--raw')) return failure === 'diff' ? 'bad' : ':100644 100644 abc def M\0src/styles/a.css\0';
    if (args[0] === 'diff') return failure === 'missing-patch' ? '' : 'diff --git a/src/styles/a.css b/src/styles/a.css\n--- a/src/styles/a.css\n+++ b/src/styles/a.css\n@@ -1 +1 @@\n-old\n+new\n';
    if (args[0] === 'grep') throw Object.assign(new Error('grep'), { status: failure === 'no-match' ? 1 : 2 });
    return '';
  } });
  assert.equal(classifyFromGit(options('diff')).reason, 'diff-failed');
  assert.equal(classifyFromGit(options('missing-patch')).reason, 'diff-failed');
  assert.equal(classifyFromGit(options('grep')).reason, 'reverse-import-failed');
  assert.equal(classifyFromGit(options('no-match')).reason, 'ui-only');
});
