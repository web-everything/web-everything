import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listBuildDispatchHolds } from '../../conveyor/build-dispatch-claim.mjs';
import { reserveHoldRoute } from '../../conveyor/build-dispatch-hold-router.mjs';
import { WE_ROOT } from '../probation-build-run.mjs';

const moduleUrl = pathToFileURL(join(WE_ROOT, 'scripts/operations/probation-build-run.mjs')).href;
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
// Includes ignored files and .git: cleanliness here means bytes, not merely git status.
function snapshot(dir) {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? Object.entries(snapshot(path)).map(([k, v]) => [`${e.name}/${k}`, v])
      : [[e.name, readFileSync(path).toString('base64')]];
  }));
}
function fixture({ report, blockerStatus } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'probation-isolation-')));
  const repo = join(root, 'wev-control');
  const lane = join(root, '.lanes/web-everything/lane-1');
  const scratch = join(root, 'unrelated/scratch');
  mkdirSync(scratch, { recursive: true });
  put(join(root, 'registry/control.json'), JSON.stringify({ clone: repo }));
  // This subprocess fixture enforces the actual pool protocol without touching the operator's pool.
  put(join(repo, 'scripts/lane-pool.mjs'), `
    import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    if (process.env.REFUSE_POOL) { console.error('lane-pool: fixture lease belongs to another session'); process.exit(1); }
    const lane = join(process.env.LANE_POOL_ROOT || process.cwd(), 'web-everything/lane-1');
    if (!existsSync(lane)) { console.error('wrong pool root: ' + lane); process.exit(1); }
    console.log(process.env.RETURN_SOURCE ? ${JSON.stringify(repo)} : lane);
  `);
  // Match the real tools' script-location root derivation; cwd-only fixes must fail these probes.
  const mutation = `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    const card = fileURLToPath(new URL(CARD, import.meta.url));
    const text = readFileSync(card, 'utf8');
    if (process.cwd() !== fileURLToPath(new URL(ROOT, import.meta.url)).replace(/\\/$/, '')) throw new Error('wrong writer cwd');
    if (process.argv[2] === 'claim') writeFileSync(card, text.replace('status: open', 'status: active'));
    if (process.argv[2] === 'resolve') {
      const graduated = process.argv.find(a => a.startsWith('--graduated-to='))?.split('=')[1];
      writeFileSync(card, text.replace(/status: (active|open)/, 'status: resolved' + (graduated ? '\\ngraduatedTo: ' + graduated : '')));
    }
    if (process.argv[2] === 'open-pr') console.log(JSON.stringify({ findings: { submit: { effects: [{ type: 'open-pr.submit', status: 'applied', result: { outcome: 'opened', pr: 9001, url: 'https://example.test/pr/9001' } }] } } }));
  `;
  for (const dir of [repo, lane]) {
    put(join(dir, '.gitignore'), '.env.local\n.claude/settings.local.json\n');
    put(join(dir, 'backlog/4291-probe.md'), '---\nstatus: open\nscope: ["we:docs/probe.md"]\n---\n\n# Probe\n\n## Done when\n\n1. Works.\n');
    if (blockerStatus) {
      const card = join(dir, 'backlog/4291-probe.md');
      writeFileSync(card, readFileSync(card, 'utf8').replace('status: open', 'status: open\nblockedBy: [3353]'));
      put(join(dir, 'backlog/3353-blocker.md'), `---\nstatus: ${blockerStatus}\n---\n# Blocker\n`);
    }
    put(join(dir, 'docs/probe.md'), 'Before\n');
    put(join(dir, 'scripts/backlog.mjs'), mutation.replace('CARD', "'../backlog/4291-probe.md'").replace('ROOT', "'../'"));
    put(join(dir, 'scripts/operations/run.mjs'), mutation.replace('CARD', "'../../backlog/4291-probe.md'").replace('ROOT', "'../../'"));
    put(join(dir, 'scripts/codex-direct-task.mjs'), report ? `console.log(${JSON.stringify(JSON.stringify(report))});` : `import { writeFileSync } from 'node:fs'; writeFileSync('docs/probe.md', 'After\\n');`);
    put(join(dir, 'scripts/verify-lane.mjs'), 'console.log("gate green");');
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
    execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
  }
  return { root, repo, lane, scratch };
}
function launch(f, extraEnv = {}, setup = '', flags = []) {
  const code = `import { realIo, runProbationBuild, parseArgs } from ${JSON.stringify(moduleUrl)};
    const io = realIo({ repoRoot: ${JSON.stringify(f.repo)}, session: 'probe' });
    io.appendScorecard = () => {}; // shared telemetry is outside this checkout-isolation probe
    ${setup}
    console.log(JSON.stringify(await runProbationBuild(parseArgs(['--num=4291', '--worker=codex', '--session=probe', ...${JSON.stringify(flags)}]), io)));`;
  const env = { ...process.env, WE_BUILDER_SLOTS: 'off', WE_DAEMON_OVERLAY_DIR: join(f.root, 'registry'),
    WE_COORDINATION_ROOT: join(f.root, 'coordination'), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', ...extraEnv };
  delete env.LANE_POOL_ROOT; // force repo-derived discovery, despite an unrelated caller cwd
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: f.scratch, env, encoding: 'utf8' }));
}

describe('probation build checkout isolation', () => {
  it.each([false, true])('assembles isolated per-card commits in one lane (member declined=%s)', declined => {
    const f = fixture();
    try {
      const git = argv => execFileSync('git', ['-C', f.lane, ...argv], { encoding: 'utf8', stdio: 'pipe' }).trim();
      const memberPath = 'backlog/4292-member.md';
      const memberRaw = readFileSync(join(f.lane, 'backlog/4291-probe.md'), 'utf8');
      put(join(f.lane, memberPath), memberRaw);
      put(join(f.lane, 'skills-src/conveyor/prepare-item-worker-brief.md'), 'Prepare {{ITEM_NUM}}: {{ITEM_SPEC_PATH}}');
      git(['add', '.']);
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'group fixture']);
      const base = git(['rev-parse', 'HEAD']);
      const memberLane = join(f.root, '.lanes/web-everything/lane-2');
      execFileSync('git', ['clone', '-q', f.lane, memberLane], { stdio: 'pipe' });
      for (const card of ['backlog/4291-probe.md', memberPath]) put(join(f.repo, card), readFileSync(join(f.lane, card), 'utf8'));
      put(join(f.repo, 'scripts/lane-pool.mjs'), `console.log(process.argv.some(a => a.endsWith('card-4292')) ? ${JSON.stringify(memberLane)} : ${JSON.stringify(f.lane)});`);
      const before = snapshot(f.repo);
      const sections = '\n## Design\nConcrete.\n## MVP\nBounded.\n## Test plan\nReplay.\n## Proof plan\nProbe.\n';
      const result = launch(f, {}, `
        const fs = await import('node:fs');
        io.preparePolicy = { autoSize: false };
        io.forPrepareCard = ({ session }) => {
          const child = realIo({ repoRoot: ${JSON.stringify(f.repo)}, session });
          const id = session.split('-').at(-1);
          child.appendScorecard = () => {};
          child.runWorker = (_argv, dir) => {
            if (${JSON.stringify(declined)} && id === '4292') return { ok: false, out: 'unresolved choice' };
            const card = child.findItem(id, dir);
            fs.appendFileSync(dir + '/' + card.path, ${JSON.stringify(sections)});
            return { ok: true, lastMessage: '' };
          };
          child.stampPrepare = (n, dir) => {
            const card = child.findItem(n, dir);
            fs.writeFileSync(dir + '/' + card.path, card.raw.replace('---\\n', '---\\npreparedDate: "2026-10-13"\\npreparedAgainstSha: "${base}"\\n'));
            return { ok: true };
          };
          return child;
        };
      `, ['--taskType=prepare', '--group-members=4292']);
      expect(result).toMatchObject({ outcome: 'opened-pr', groupMembers: ['4292'], groupDropped: declined ? ['4292'] : [] });
      expect(git(['rev-list', '--count', base + '..HEAD'])).toBe(declined ? '1' : '2');
      expect(git(['diff', '--name-only', base, 'HEAD']).split('\n')).toEqual(declined
        ? ['backlog/4291-probe.md'] : ['backlog/4291-probe.md', memberPath]);
      expect(git(['show', 'HEAD:backlog/4291-probe.md'])).toContain(`preparedAgainstSha: "${base}"`);
      if (declined) expect(readFileSync(join(f.lane, memberPath), 'utf8')).toBe(memberRaw);
      else expect(git(['show', 'HEAD:' + memberPath])).toContain(`preparedAgainstSha: "${base}"`);
      const body = readFileSync(join(f.lane, '.pr-body.md'), 'utf8');
      expect(body).toContain(declined ? 'Not prepared: #4292' : 'Grouped prepare: #4291, #4292');
      expect(snapshot(f.repo)).toEqual(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each([true, false])('runs the real already-done landing with a delivering citation=%s', (delivering) => {
    const f = fixture({ report: {} });
    try {
      const git = (argv) => execFileSync('git', ['-C', f.lane, ...argv], { encoding: 'utf8', stdio: 'pipe' }).trim();
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null',
        'commit', '--amend', '-m', delivering ? 'WE #4291: deliver probe' : 'WE #9999: unrelated delivery']);
      const sha = git(['rev-parse', 'HEAD']);
      git(['branch', '-M', 'main']);
      const origin = join(f.root, 'origin.git');
      execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'pipe' });
      git(['remote', 'add', 'origin', origin]);
      git(['push', 'origin', 'main']);
      const before = snapshot(f.repo);
      // Preserve the fixture tree: inject only the launcher's captured report, then run real git,
      // real routing/landing, and lane-local backlog/verify/open-pr fixture CLIs.
      const result = launch(f, {}, `io.runWorker = () => ({ ok: true, lastMessage: ${JSON.stringify(`already exists; all Done-when checks pass. spec already done on main: commit ${sha}`)} });`);
      expect(snapshot(f.repo)).toEqual(before);
      const card = readFileSync(join(f.lane, 'backlog/4291-probe.md'), 'utf8');
      if (delivering) {
        expect(result).toMatchObject({ outcome: 'opened-pr', pr: 9001 });
        expect(card).toContain('status: resolved');
        expect(card).toContain(`graduatedTo: ${sha}`);
        expect(git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe('backlog/4291-probe.md');
      } else {
        expect(result.outcome).toBe('escalated-needs-human');
        expect(result.detail).toContain('refusing to auto-resolve');
        expect(card).toContain('status: open');
        expect(card).not.toContain('graduatedTo:');
        expect(git(['rev-parse', 'HEAD'])).toBe(sha);
      }
      expect(card).toContain('scope:');
      expect(card).not.toContain('## Findings');
      expect(reserveHoldRoute({ num: '4291', route: 'already-done', lockRoot: join(f.root, 'coordination/build-dispatch-hold-routes') }).ok).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each(['success', 'early failure'])('keeps a registered daemon clone byte-clean on %s from an unrelated cwd', (mode) => {
    const f = fixture();
    try {
      const before = snapshot(f.repo);
      const result = launch(f, {}, mode === 'early failure' ? `io.writeTaskFile = () => { throw new Error('early task failure'); };` : '');
      expect(result.outcome).toBe(mode === 'success' ? 'opened-pr' : 'escalated-needs-human');
      expect(snapshot(f.repo)).toEqual(before);
      expect(readFileSync(join(f.lane, 'backlog/4291-probe.md'), 'utf8')).toContain(`status: ${mode === 'success' ? 'resolved' : 'open'}`);
      expect(readFileSync(join(f.lane, 'docs/probe.md'), 'utf8')).toBe(mode === 'success' ? 'After\n' : 'Before\n');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each([
    { lastMessage: 'Target files exist only on lane/mechanical-dispatcher; porting them exceeds the bugfix envelope.' },
    {},
  ])('persists a no-change finding and the real worker-declined hold (%j)', (report) => {
    const f = fixture({ report });
    try {
      const before = snapshot(f.repo);
      const result = launch(f);
      const reason = report.lastMessage || 'The worker changed nothing and provided no final message.';
      expect(result.outcome).toBe('opened-pr');
      expect(result.detail).toContain(reason);
      expect(snapshot(f.repo)).toEqual(before);
      const card = readFileSync(join(f.lane, 'backlog/4291-probe.md'), 'utf8');
      expect(card).toContain('## Findings (standalone worker, ');
      expect(card).toContain(`> worker-declined: ${reason}`);
      expect(card).toContain('status: open');
      expect(card).not.toMatch(/^scope:/m);
      expect(readFileSync(join(f.lane, 'docs/probe.md'), 'utf8')).toBe('Before\n');
      const holds = listBuildDispatchHolds({ lockRoot: join(f.root, 'coordination/build-dispatch-holds') });
      expect(holds.map((hold) => hold.meta)).toEqual(expect.arrayContaining([expect.objectContaining({ num: '4291', reason: `worker-declined: ${reason}` })]));
      expect(reserveHoldRoute({ num: '4291', route: 'out-of-scope', lockRoot: join(f.root, 'coordination/build-dispatch-hold-routes') }).ok).toBe(false);
      expect(readFileSync(join(f.lane, '.pr-body.md'), 'utf8')).toContain('no implementation change');
      const changed = execFileSync('git', ['-C', f.lane, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { encoding: 'utf8' }).trim();
      expect(changed).toBe('backlog/4291-probe.md');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('acquires from a real temporary lane pool when launched outside any checkout', () => {
    const f = fixture();
    try {
      const origin = join(f.root, 'web-everything.git');
      const git = (argv) => execFileSync('git', argv, { cwd: f.repo, stdio: 'pipe' });
      git(['branch', '-M', 'main']);
      git(['init', '--bare', '--initial-branch=main', origin]);
      git(['remote', 'add', 'origin', origin]);
      git(['push', 'origin', 'main']);
      // Delegate the fixture entry point to the actual pool CLI and all its lease/refusal logic.
      put(join(f.repo, 'scripts/lane-pool.mjs'), `import ${JSON.stringify(pathToFileURL(join(WE_ROOT, 'scripts/lane-pool.mjs')).href)};`);
      rmSync(join(f.root, '.lanes'), { recursive: true, force: true });
      execFileSync(process.execPath, [join(WE_ROOT, 'scripts/lane-pool.mjs'), 'provision',
        `--repo=${f.repo}`, '--count=1', '--no-install'], {
        cwd: f.scratch, env: { ...process.env, LANE_POOL_ROOT: join(f.root, '.lanes') }, stdio: 'pipe', timeout: 30000,
      });
      const before = snapshot(f.repo);
      const result = launch(f, {}, `io.writeTaskFile = () => { throw new Error('real pool acquired'); };`);
      expect(result.detail).toContain('real pool acquired');
      expect(snapshot(f.repo)).toEqual(before);
      expect(readFileSync(join(f.lane, 'backlog/4291-probe.md'), 'utf8')).toContain('status: open');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30000);

  it('surfaces lane-pool refusal text without touching either checkout', () => {
    const f = fixture();
    try {
      const before = snapshot(f.root);
      expect(launch(f, { REFUSE_POOL: '1' }).detail).toContain('lane-pool: fixture lease belongs to another session');
      expect(snapshot(f.root)).toEqual(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('refuses an acquired path pointing back at the daemon clone before any write', () => {
    const f = fixture();
    try {
      const before = snapshot(f.root);
      expect(launch(f, { RETURN_SOURCE: '1' }).detail).toContain('refused: acquired lane is the launch checkout or a registered daemon clone');
      expect(snapshot(f.root)).toEqual(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});


describe('standalone blockedBy preflight', () => {
  it('refuses an open main blocker before any lane, claim, worker or PR IO, despite a local resolution', () => {
    const f = fixture({ blockerStatus: 'open' });
    try {
      writeFileSync(join(f.repo, 'backlog/3353-blocker.md'), '---\nstatus: resolved\n---\n# Blocker\n');
      const before = snapshot(f.lane);
      const result = launch(f, {}, `
        for (const method of ['acquireLane', 'claim', 'runWorker', 'openPr']) {
          io[method] = () => { throw new Error('unexpected IO: ' + method); };
        }
      `);
      expect(result).toMatchObject({ outcome: 'blocked', executor: 'none', pr: null });
      expect(result.detail).toContain('#3353');
      expect(snapshot(f.lane)).toEqual(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each(['resolved', undefined])('proceeds to lane acquisition with blocker status %s', (blockerStatus) => {
    const f = fixture({ blockerStatus });
    try {
      const result = launch(f, {}, 'io.acquireLane = () => null;');
      expect(result).toMatchObject({ outcome: 'not-applicable', detail: 'could not acquire a lane for this build' });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
