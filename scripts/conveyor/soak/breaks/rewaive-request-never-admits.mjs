/** A filed re-waiver request (rewaive-plan --file-request) admits nothing: only an approved waiver does. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const REF = 'lane/rewaive';
const OPS_STORE = '/soak-home/workspace/.operations/coordination/ruled-weakened.jsonl';

export async function exercise(root) {
  const violations = [];
  const load = rel => import(pathToFileURL(join(root, rel)).href);
  const gate = await load('scripts/operations/canonical-audit-gate.mjs');
  const { QUESTION_HASH } = await load('scripts/operations/codex-audit.mjs');
  const { runCli } = await load('scripts/operations/rewaive-plan.mjs');
  // 1. Drive the REAL filing path in a throwaway repo; capture what it spawns instead of running it.
  const dir = mkdtempSync(join(tmpdir(), 'rewaive-soak-'));
  const proc = execFileSync;
  const repoCmd = (cwd, ...a) => String(proc('git', a, { cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })).trim();
  repoCmd(dir, 'init', '-q', 'work');
  const work = join(dir, 'work');
  repoCmd(work, 'checkout', '-q', '-b', REF);
  const shas = [];
  for (let i = 0; i < 3; i++) { writeFileSync(join(work, `f${i}`), `${i}`); repoCmd(work, 'add', '.'); repoCmd(work, 'commit', '-q', '-m', `c${i}`); shas.push(repoCmd(work, 'rev-parse', 'HEAD')); }
  repoCmd(dir, 'clone', '-q', '--bare', work, 'origin.git'); repoCmd(work, 'remote', 'add', 'origin', join(dir, 'origin.git'));
  const [c0, B, H] = shas;
  const rec = (head, findings) => ({ head, base: c0, questionHash: QUESTION_HASH, at: '2026-11-24T10:00:00Z', verdict: 'WEAKENED', findings });
  const findingsB = ['x.mjs:1 weak'], findingsH = ['x.mjs:2 weak'];
  const home = join(dir, 'home'); mkdirSync(join(home, 'workspace/.operations/handoff'), { recursive: true });
  writeFileSync(join(home, 'workspace/.operations/handoff/waive-request.mjs'), '');
  const spawned = [];
  runCli({ argv: [`--ref=${REF}`, '--file-request'], repo: work, env: { PATH: process.env.PATH, HOME: home }, stdout: () => {},
    loadRecords: () => [rec(B, findingsB), rec(H, findingsH)], loadWaivers: () => [{ ref: REF, sha: B, ruling: 'R1085', findings: findingsB }],
    baseOk: () => true, spawn: (cmd, args, opts) => { spawned.push({ cmd, args, input: opts?.input }); return { status: 0 }; } });
  if (spawned.length !== 1 || !String(spawned[0].args?.[0]).endsWith('waive-request.mjs') || spawned[0].args[1] !== '--json=-') {
    violations.push(`filing must spawn only the request op, got ${JSON.stringify(spawned.map(s => s.args))}`);
  }
  if (existsSync(join(home, 'workspace/.operations/coordination/ruled-weakened.jsonl'))) violations.push('filing wrote an approved waiver');
  // 2. The gate, with only that request filed and no approval, refuses with the weakened reason; an approval admits (positive control).
  const weak = rec(H, findingsH);
  const gateWith = store => {
    const readFile = path => {
      if (path === '/soak-home/audit.jsonl') return JSON.stringify(weak);
      if (path.endsWith('prototype-load.json')) return JSON.stringify({ auditRecordPath: '~/audit.jsonl' });
      if (path === '/soak-prefs') return JSON.stringify({ prototypeLoad: {} });
      if (path === OPS_STORE && store) return store;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    return gate.checkCanonicalAuditForOpen({ repo: '/repo', ref: REF, sha: H, readFile, fetchMain: () => {}, ancestor: () => true,
      liveFingerprint: () => null, warn: () => {}, env: { HOME: '/soak-home', WE_PLATFORM_PREFERENCES_FILE: '/soak-prefs' }, exec: () => H });
  };
  const unapproved = gateWith(null);
  if (unapproved.ok || unapproved.reason !== 'canonical-audit-weakened') violations.push(`unapproved request: expected canonical-audit-weakened, got ${unapproved.ok ? 'ok' : unapproved.reason}`);
  const approved = gateWith(`${JSON.stringify({ ref: REF, sha: H, ruling: 'R1085', findings: findingsH, actor: 'operator', at: '2026-11-24T11:00:00Z', quote: 'waive it' })}\n`);
  if (!approved.ok) violations.push(`positive control failed: approved waiver refused (${approved.reason})`);
  return { violations };
}

export default {
  id: 'rewaive-request-never-admits',
  title: 'a filed re-waiver request without an approval never admits the head',
  card: 'DELTA-AUDIT v2',
  fixedBy: { sha: 'HEAD', where: 'working tree', paths: ['scripts/operations/rewaive-plan.mjs'] },
  fixPresent(root) { return existsSync(join(root, 'scripts/operations/rewaive-plan.mjs')); },
  async run({ sourceRoot = ROOT } = {}) { return exercise(sourceRoot); },
  judge: report => report.violations,
};
