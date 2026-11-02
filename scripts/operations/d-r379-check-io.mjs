/** Bounded, injectable Git/GitHub/filesystem readers for D-R379. No shell evaluation. */
import * as realFs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { readPlatformPreferences, resolveCascade, formatCascadeSourcesLine } from '../lib/policy-cascade.mjs';
import { readLedgerEventsFromStore } from '../lib/verdict-ledger.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

const POLICY = new URL('../settings/d-r379-protected-paths.json', import.meta.url);
const AUDIT_SETTINGS = new URL('../settings/prototype-load.json', import.meta.url);
const DEFAULT_AUDIT_PATH = '~/workspace/.operations/coordination/audits.jsonl';
const SHA = /^[a-f\d]{40}$/i;
const MAX_BYTES = 8 * 1024 * 1024;
const safeLog = text => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

async function realExec(bin, args, options) {
  if (bin === 'gh') {
    const { runGhSync } = await import('../lib/gh-throttle.mjs');
    return runGhSync(args, options);
  }
  return execFileSync(bin, args, options);
}

/** exec(bin, argv, options), fs, home, env, cwd and output streams are hermetically replaceable. */
export function createCheckDeps({ cwd = process.cwd(), home = homedir(), env = process.env,
  fs = realFs, exec = realExec, readLedger = readLedgerEventsFromStore, stdout = text => process.stdout.write(text),
  stderr = text => process.stderr.write(text) } = {}) {
  const options = { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'] };
  // Name-only rename output otherwise omits the protected source of a move. Disable
  // rename folding so both the deleted source and added destination are classified.
  const gitEnv = { ...env };
  const configCount = Number(gitEnv.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(configCount) || configCount < 0 || configCount > 1000) throw new Error('invalid Git configuration count');
  gitEnv.GIT_CONFIG_COUNT = String(configCount + 1);
  gitEnv[`GIT_CONFIG_KEY_${configCount}`] = 'diff.renames';
  gitEnv[`GIT_CONFIG_VALUE_${configCount}`] = 'false';
  const run = async (bin, args) => {
    const output = await exec(bin, args, bin === 'git' ? { ...options, env: gitEnv } : options);
    if (typeof output !== 'string' && !Buffer.isBuffer(output)) throw new Error('incomplete command output');
    if (Buffer.byteLength(output) > MAX_BYTES) throw new Error('output bound exceeded; human review required');
    return String(output);
  };
  const read = path => {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error('not a regular evidence file');
      if (stat.size > MAX_BYTES) throw new Error('file bound exceeded; human review required');
      // One descriptor binds all reads to the opened file even if the path is replaced.
      // The extra byte detects growth without ever reading the unbounded remainder.
      const buffer = Buffer.allocUnsafe(MAX_BYTES + 1);
      let consumed = 0;
      while (consumed < buffer.length) {
        const count = fs.readSync(fd, buffer, consumed, buffer.length - consumed, null);
        if (count === 0) break;
        consumed += count;
      }
      if (consumed > MAX_BYTES) throw new Error('file grew beyond bound; human review required');
      return buffer.toString('utf8', 0, consumed);
    } finally {
      fs.closeSync(fd);
    }
  };
  const configuredPolicy = (name, tool, standard) => {
    const platform = readPlatformPreferences({ env, readFile: read, warn: text => stderr(`${safeLog(text)}\n`) });
    if (platform.errors.length) throw new Error('unreadable platform preferences');
    const resolved = resolveCascade({ standard, platform: platform.prefs[name], tool });
    stderr(`${safeLog(formatCascadeSourcesLine(name, resolved))}\n`);
    return resolved.value;
  };
  const checkPrNumber = pr => {
    if (!Number.isSafeInteger(pr) || pr < 1) throw new Error('invalid PR number');
  };
  const checkSha = head => {
    if (typeof head !== 'string' || !SHA.test(head)) throw new Error('invalid commit');
  };
  return {
    async readPr(pr) {
      checkPrNumber(pr);
      return JSON.parse(await run('gh', ['pr', 'view', String(pr), '--repo', CONSTELLATION_REPOS.we.slug, '--json', 'title,body,headRefOid']));
    },
    async readLabels(pr, head) {
      checkPrNumber(pr);
      const snapshot = JSON.parse(await run('gh', ['pr', 'view', String(pr), '--repo', CONSTELLATION_REPOS.we.slug, '--json', 'labels,headRefOid']));
      if (snapshot.headRefOid !== head) throw new Error('PR head moved; retry');
      return snapshot.labels;
    },
    async readReviewLedger(pr) {
      checkPrNumber(pr);
      const result = await readLedger(CONSTELLATION_REPOS.we.slug, {
        env, log: text => stderr(`${safeLog(text)}\n`),
      });
      if (result?.status !== 'ok') throw new Error('verdict ledger unavailable; human review required');
      return result.rows;
    },
    async fetchNetDiff(pr, head) {
      checkPrNumber(pr);
      checkSha(head);
      await run('git', ['fetch', 'origin', 'main']);
      await run('git', ['fetch', 'origin', `pull/${pr}/head`]);
      const fetched = (await run('git', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
      if (fetched !== head) throw new Error('fetched head differs from PR head; retry');
      const base = (await run('git', ['merge-base', 'origin/main', head])).trim();
      checkSha(base);
      const text = await run('git', ['diff', base, head, '--name-only', '-z']);
      if (!text) return {paths: [], base};
      if (!text.endsWith('\0')) throw new Error('incomplete NUL-delimited diff');
      const paths = text.slice(0, -1).split('\0');
      if (paths.length > 10_000) throw new Error('diff bound exceeded; human review required');
      return {paths, base};
    },
    readHeadFile(head, path) {
      checkSha(head);
      if (typeof path !== 'string' || !/^backlog\/[^/]+\.md$/.test(path) || path.includes('\0')) throw new Error('invalid card path');
      return run('git', ['show', `${head}:${path}`]);
    },
    async readBaseFile(base, path) {
      checkSha(base);
      if (typeof path !== 'string' || !/^backlog\/[^/]+\.md$/.test(path) || path.includes('\0')) throw new Error('invalid card path');
      try { return await run('git', ['show', `${base}:${path}`]); }
      catch (error) {
        // A failed show alone cannot distinguish a new card from corrupt/missing Git
        // evidence. Only a successful, empty exact-path tree lookup proves absence.
        const entry = await run('git', ['ls-tree', '-z', base, '--', path]);
        if (entry === '') return null;
        throw error;
      }
    },
    readSettings() {
      return configuredPolicy('d-r379-protected-paths', JSON.parse(read(POLICY)));
    },
    readAudits() {
      let tool;
      try { tool = JSON.parse(read(AUDIT_SETTINGS)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; tool = {}; }
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new Error('invalid audit settings');
      const { auditRecordPath: configured } = configuredPolicy('d-r379-audit',
        { ...(Object.hasOwn(tool, 'auditRecordPath') ? { auditRecordPath: tool.auditRecordPath } : {}) },
        { auditRecordPath: DEFAULT_AUDIT_PATH });
      if (typeof configured !== 'string' || !configured.trim()) throw new Error('invalid auditRecordPath');
      const path = configured.startsWith('~/') ? join(home, configured.slice(2))
        : configured === '~' ? home : resolve(cwd, configured);
      const lines = read(path).split(/\r?\n/).filter(line => line.trim());
      if (lines.length > 100_000) throw new Error('audit record bound exceeded; human review required');
      return lines.map(line => {
        const record = JSON.parse(line);
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid audit record');
        return record;
      });
    },
    stdout,
    stderr,
  };
}
