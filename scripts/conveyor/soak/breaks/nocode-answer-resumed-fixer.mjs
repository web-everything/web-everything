/** #7452: a headed no-code ruling must survive the fixer's first same-head claim. */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
export const cases = ['nocode-resume-rearms', 'nocode-resume-standdown-refuses', 'nocode-resume-then-push-rearms'];

async function runCase(caseName) {
  const { runStandDownAnswer } = await import(pathToFileURL(join(ROOT, 'scripts/conveyor/stand-down-answer.mjs')).href);
  const { buildStandDownComment } = await import(pathToFileURL(join(ROOT, 'scripts/conveyor/stand-down.mjs')).href);
  const fixture = JSON.parse(readFileSync(join(ROOT, 'scripts/conveyor/__tests__/fixtures/7452-nocode-resume.json'), 'utf8'));
  const comments = fixture.comments.slice(0, -2);
  const state = { number: 7452, state: 'OPEN', isDraft: false, headRefName: 'lane/fix-7452',
    headRefOid: fixture.liveHead, labels: [{ name: 'review:changes' }], comments };
  // Real producer, then the resumed fixer's claim, then the real re-arm subprocess and shared label writer.
  runStandDownAnswer(['7452', '--repo=o/r', '--disposition=rearm-review', '--no-code-owed',
    '--actor=chalbert', '--channel=chat', '--reason=No code owed'], {
    gh: args => {
      if (args[1] === 'view') return JSON.stringify(state);
      comments.push({ id: 'IC_soak_answer', author: { login: 'web-everything' }, body: args.at(-1) });
      return 'posted';
    },
  });
  comments.push(fixture.comments.at(-1));
  if (caseName === 'nocode-resume-standdown-refuses') comments.push({ id: 'IC_second_stop',
    author: { login: 'web-everything' }, body: buildStandDownComment({ reason: 'needs-judgment', detail: 'Fresh question' }) });
  if (caseName === 'nocode-resume-then-push-rearms') {
    state.headRefOid = 'b'.repeat(40);
    comments.push({ id: 'IC_pushed_claim', author: { login: 'web-everything' },
      body: '🔒 conveyor fix-begin — fix claim held\n\n**Branch:** `lane/fix-7452` at `bbbbbbbbb`' });
  }
  const dir = mkdtempSync(join(tmpdir(), 'soak-nocode-resume-'));
  try {
    const stateFile = join(dir, 'state.json'), logFile = join(dir, 'calls.jsonl');
    writeFileSync(stateFile, JSON.stringify(state));
    writeFileSync(join(dir, 'git'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
    writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(process.env.SOAK_STATE, 'utf8'));
fs.appendFileSync(process.env.SOAK_CALLS, JSON.stringify(a) + '\\n');
if (a[0] === 'pr' && a[1] === 'view') console.log(JSON.stringify(s));
else if (a[0] === 'api' && a[1] === 'repos/o/r/issues/7452/comments' && a.includes('--slurp')) {
  console.log(JSON.stringify([s.comments.map(({ author, id, ...c }, i) => ({ ...c, user: author, id: i + 1, node_id: id }))]));
} else if (a[0] === 'pr' && a[1] === 'edit') {
  const remove = a.filter((v, i) => a[i - 1] === '--remove-label');
  s.labels = s.labels.filter(l => !remove.includes(l.name));
  if (a.includes('--add-label')) s.labels.push({ name: a[a.indexOf('--add-label') + 1] });
  fs.writeFileSync(process.env.SOAK_STATE, JSON.stringify(s));
} else if (a[0] === 'pr' && a[1] === 'comment') {
  const f = a[a.indexOf('--body-file') + 1];
  s.comments.push({ id: 'IC_cli_' + s.comments.length, author: { login: 'web-everything' }, body: fs.readFileSync(f === '-' ? 0 : f, 'utf8') });
  fs.writeFileSync(process.env.SOAK_STATE, JSON.stringify(s));
} else { console.error('unsupported fake gh call: ' + JSON.stringify(a)); process.exit(1); }
`, { mode: 0o755 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(WE_|GH_|GITHUB_|LANE_POOL_ROOT$)/.test(k)));
    const child = spawnSync(process.execPath, [join(ROOT, 'scripts/conveyor/rearm-review.mjs'), '7452', '--repo=o/r'], {
      cwd: dir, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      env: { ...env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, TMPDIR: dir,
        WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'throttle'), WE_VERDICT_LEDGER_DIR: join(dir, 'ledger'),
        WE_VERDICT_LEDGER_STORE: 'home', SOAK_STATE: stateFile, SOAK_CALLS: logFile },
    });
    const final = JSON.parse(readFileSync(stateFile, 'utf8'));
    const calls = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const labelWrites = calls.filter(a => a[0] === 'pr' && a[1] === 'edit').length;
    const markers = final.comments.filter(c => c.body.startsWith('🔧 conveyor fix — re-armed for re-review')).length;
    const noChange = final.comments.filter(c => c.body.startsWith('⚠️ conveyor fix — no change made')).length;
    const refused = caseName === 'nocode-resume-standdown-refuses';
    const violations = [];
    if (child.status !== (refused ? 1 : 0)) violations.push(`${caseName}: exit ${child.status}: ${child.error?.message ?? child.stderr}${child.stdout}`);
    if (labelWrites !== (refused ? 0 : 1) || markers !== (refused ? 0 : 1) || noChange !== (refused ? 1 : 0)) {
      violations.push(`${caseName}: labelWrites=${labelWrites}, markers=${markers}, noChange=${noChange}`);
    }
    if (JSON.stringify(final.labels.map(l => l.name)) !== JSON.stringify([refused ? 'review:changes' : 'review:pending'])) {
      violations.push(`${caseName}: unexpected final labels ${JSON.stringify(final.labels)}`);
    }
    return { caseName, violations, labelWrites, markers, noChange };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export default {
  id: 'nocode-answer-resumed-fixer',
  title: 'headed no-code answer survives one resumed fixer claim (#7452)',
  card: 'STANDDOWN-NOCODE-REARM',
  fixedBy: { sha: 'pending', where: 'HEAD', paths: ['scripts/conveyor/rearm-review.mjs', 'scripts/conveyor/stand-down-answer-core.mjs'] },
  fixPresent: root => /noCodeResume/.test(readFileSync(join(root, 'scripts/conveyor/rearm-review.mjs'), 'utf8')),
  async run({ caseName } = {}) {
    const reports = [];
    for (const name of caseName ? [caseName] : cases) reports.push(await runCase(name));
    return { reports, violations: reports.flatMap(r => r.violations) };
  },
  judge: report => report.violations,
};
