/** Scoring evidence uses Git's built-in diff against an empty attribute tree.
 * Pure command construction, injectable execFileSync-shaped IO. Errors propagate:
 * callers must invalidate the complete score, never substitute empty evidence.
 * --attr-source also makes Git versions without attribute-source support refuse.
 */
export const EMPTY_ATTRIBUTE_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const quote = value => /["\\\x00-\x1f\x7f]/.test(value) ? '"' + value.replace(/["\\\x00-\x1f\x7f]/g, c => ({'"': '\\"', '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r', '\b': '\\b', '\f': '\\f', '\v': '\\v'}[c] ?? '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'))) + '"' : value;

export function hardenedGitDiffCommand(args, opts = {}, env = {}) {
  const cleanEnv = { ...env, ...opts.env };
  for (const key of Object.keys(cleanEnv)) {
    if (/^GIT_CONFIG/.test(key) || /^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|REPLACE_REF_BASE|SHALLOW_FILE|GRAFT_FILE|PREFIX|IMPLICIT_WORK_TREE|SUPER_PREFIX|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|EXTERNAL_DIFF|DIFF_OPTS)$/.test(key)) delete cleanEnv[key];
  }
  const protectedEnv = {
    ...cleanEnv,
    GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
    GIT_ATTR_SOURCE: EMPTY_ATTRIBUTE_TREE,
  };
  return {
    args: ['--attr-source=' + EMPTY_ATTRIBUTE_TREE,
      '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=',
      ...['core.bigFileThreshold=2g', 'core.quotepath=false', 'diff.algorithm=myers', 'diff.orderFile=/dev/null',
        'diff.renames=false', 'diff.noprefix=false', 'diff.context=3', 'diff.interHunkContext=0',
        'diff.mnemonicPrefix=false', 'diff.srcPrefix=a/', 'diff.dstPrefix=b/',
        'diff.suppressBlankEmpty=false', 'diff.indentHeuristic=false', 'diff.submodule=short',
        'diff.ignoreSubmodules=none', 'diff.relative=false', 'diff.outputIndicatorNew=+',
        'diff.outputIndicatorOld=-', 'diff.outputIndicatorContext= '].flatMap(value => ['-c', value]),
      ...args.slice(0, 1), '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color',
      ...args.slice(1)],
    opts: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120e3, maxBuffer: 64 * 1024 * 1024, ...opts, env: protectedEnv },
  };
}

export function hardenedGitDiff(exec, args, opts) {
  const command = hardenedGitDiffCommand(args, opts, process.env);
  const output = exec('git', command.args, command.opts);
  if (args[0] === 'diff' && !args.some(a => ['--raw', '--numstat', '--name-only', '--quiet'].includes(a))) {
    const stop = args.indexOf('--');
    const refs = args.slice(1, stop < 0 ? undefined : stop).filter(a => !a.startsWith('-'));
    if (refs.length !== 2) throw new Error('diff evidence requires two explicit trees; human review required');
    const records = [];
    verifyRenderedDiff(exec, refs[0], refs[1], String(output), { opts, pathspec: stop < 0 ? [] : args.slice(stop + 1), records });
    return bindRawBlobEvidence(String(output), records);
  }
  return output;
}

/** Independent tree evidence. Unknown records and incomplete rendering require human review.
 * Mode-only records need a section but no hunk. Symlinks require ordinary hunks;
 * gitlinks have no blob text and always require human review when their oid changes.
 */
export function verifyRenderedDiff(exec, base, head, text, { opts, pathspec = [], paths = null, records: evidenceRecords = null } = {}) {
  const records = readRawBlobRecords(exec, base, head, { opts, pathspec });
  const chunks = String(text).split(/(?:^|\n)diff --git /);
  if (chunks[0].trim()) throw new Error('unknown diff rendering; human review required');
  const sections = new Map(chunks.slice(1).map(s => [s.split('\n')[0], s]));
  if (sections.size !== chunks.length - 1) throw new Error('duplicate diff section; human review required');
  for (const record of records) {
    const section = sections.get(`${quote('a/' + record.path)} ${quote('b/' + record.path)}`);
    if (!section) throw new Error('missing diff section; human review required');
    if (record.oldOid !== record.newOid) {
      if ([record.oldMode, record.newMode].includes('160000') || !/(?:^|\n)@@ -[0-9]+(?:,[0-9]+)? \+[0-9]+(?:,[0-9]+)? @@/.test(section) || /(?:^|\n)(?:Binary files(?: .*?)? differ|GIT binary patch)/.test(section)) {
        throw new Error('changed oid without reviewable blob hunks; human review required');
      }
    }
  }
  if (sections.size !== records.length) throw new Error('rendered/raw paths differ; human review required');
  const actual = records.map(r => r.path);
  if (paths) {
    const listed = new Set(paths);
    if (listed.size !== paths.length || paths.length !== actual.length || actual.some(p => !listed.has(p))) throw new Error('listed/raw paths differ; human review required');
  }
  if (evidenceRecords) evidenceRecords.push(...records);
  return actual;
}

/** Bind independent full blob identities into each section before fingerprint projection.
 * These headers are not textual index lines: both fingerprints must retain every
 * path, including mechanical paths, even when their rendered content is excluded.
 */
export function bindRawBlobEvidence(text, records) {
  const byHeader = new Map(records.map(record => [
    `diff --git ${quote('a/' + record.path)} ${quote('b/' + record.path)}`, record,
  ]));
  const seen = new Set();
  // LF-only line starts: `m`-flag anchors also match after CR / U+2028 / NEL and would treat added content as a header.
  const bound = text.split('\n').map(line => {
    if (!line.startsWith('diff --git ')) return line;
    const record = byHeader.get(line);
    if (!record || seen.has(line)) throw new Error('missing or duplicate raw blob identity; human review required');
    seen.add(line);
    return `${line}\nwe-raw-blob ${JSON.stringify(record)}`;
  }).join('\n');
  if (seen.size !== records.length) throw new Error('unbound raw blob identity; human review required');
  return bound;
}

export function readRawBlobRecords(exec, base, head, { opts, pathspec = [] } = {}) {
  const command = hardenedGitDiffCommand(['diff', '--raw', '--no-abbrev', '-z',
    '--ignore-submodules=none', '--end-of-options', base, head, '--', ...pathspec], opts, process.env);
  const raw = String(exec('git', command.args, command.opts));
  const fields = raw.split('\0');
  if (fields.pop() !== '') throw new Error('incomplete raw diff; human review required');
  const records = [];
  const seen = new Set();
  for (let i = 0; i < fields.length; i += 2) {
    const match = /^:(000000|100644|100755|120000|160000) (000000|100644|100755|120000|160000) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [AMDT]$/.exec(fields[i]);
    const path = fields[i + 1];
    if (!match || !path || seen.has(path)) throw new Error('invalid raw diff; human review required');
    seen.add(path);
    records.push({ path, oldMode: match[1], newMode: match[2], oldOid: match[3], newOid: match[4] });
  }
  return records;
}
