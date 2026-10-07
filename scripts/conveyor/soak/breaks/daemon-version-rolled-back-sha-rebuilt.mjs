/**
 * @file breaks/daemon-version-rolled-back-sha-rebuilt.mjs — card 89 S5 follow-ups (item 109). A bad origin/main sha is
 * built and switched to, probation rolls it back (a hold is set), and gc later prunes the held version's folder and
 * `.version.json`. The hold used to find the rejected sha only through that record, so once gc pruned it the hold went
 * blind: the daemon rebuilt and re-switched the rejected sha every tick (a rollback loop). The hold now carries the sha.
 * Second half: a transient smoke verdict used to be recorded as a permanent smoke failure and reused by every later
 * build of that sha, so one flaky smoke wedged the sha forever; it is now retried with backoff on a later tick.
 *
 * Scenario (real git repos + the real build/switch/probation/gc code in a temp dir, virtual clock, stubbed installer
 * and smoke): A good -> B bad (switched, probation rollback, gc prune) -> ticks must not rebuild B -> main moves to C
 * and C must build -> D smoke is transient -> a later tick (after the backoff) must build and switch D.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TREE = fileURLToPath(new URL('../../../..', import.meta.url));

export default {
  id: 'daemon-version-rolled-back-sha-rebuilt',
  title: 'a rolled-back sha rebuilt every tick once gc pruned its version record, and a transient smoke stuck as permanent',
  card: 'we:backlog/89 S5 (item 109)',
  fixedBy: { sha: 'item-109', where: 'lane/item-109 (#4235)', paths: ['scripts/lib/daemon-version-runtime.mjs', 'scripts/lib/daemon-version-switch.mjs'] },
  fixPresent(root) {
    try {
      return /smoke-retry/.test(readFileSync(join(root, 'scripts/lib/daemon-version-runtime.mjs'), 'utf8'))
        && /holdSha/.test(readFileSync(join(root, 'scripts/lib/daemon-version-switch.mjs'), 'utf8'));
    } catch { return false; }
  },
  async run() {
    const violations = [];
    const v = (invariant, detail) => violations.push({ invariant, detail, daemon: 'soak', tick: 0 });
    const fixture = mkdtempSync(join(tmpdir(), 'soak-rolled-back-sha-'));
    try {
      let rt; let sw;
      try {
        rt = await import(join(TREE, 'scripts/lib/daemon-version-runtime.mjs'));
        sw = await import(join(TREE, 'scripts/lib/daemon-version-switch.mjs'));
      } catch (e) { v('crash', String(e?.message ?? e)); return { violations }; }
      const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
      const origin = join(fixture, 'origin.git');
      git(fixture, 'init', '--quiet', '--bare', '-b', 'main', origin);
      const work = join(fixture, 'work');
      git(fixture, 'clone', '--quiet', origin, work);
      git(work, 'config', 'user.name', 'F'); git(work, 'config', 'user.email', 'f@example.test');
      const land = (name, body = name) => {
        writeFileSync(join(work, name), body);
        git(work, 'add', '.'); git(work, 'commit', '--quiet', '-m', name); git(work, 'push', '--quiet', 'origin', 'HEAD:main');
        return git(work, 'rev-parse', 'HEAD');
      };
      land('package.json', '{"name":"f","version":"1.0.0"}'); land('package-lock.json', '{"lockfileVersion":3}');
      const clone = join(fixture, 'daemon');
      git(fixture, 'clone', '--quiet', origin, clone);
      const home = join(fixture, '.daemon-clones');
      const settings = { enabled: { daemon: true }, clonesRoot: home, statePaths: ['.conveyor'], carryPaths: [], retainMinAgeMs: 0 };
      const ctx = rt.resolveVersionedContext({ root: clone, settings });
      let clock = Date.UTC(2026, 9, 7, 12, 0, 0);
      let builds = 0;
      let smoke = async () => ({ verdict: 'pass', attempts: 1 });
      const buildDeps = {
        now: () => new Date(clock++),
        installer: (into) => { builds += 1; mkdirSync(join(into, 'node_modules')); },
        runSmoke: (...a) => smoke(...a),
      };
      const log = { error() {} };
      const tick = () => rt.versionedRebuild({ ctx, log, deps: { buildDeps, now: () => clock } });
      const current = () => { try { return readlinkSync(join(ctx.dir, 'current')).split('/').pop(); } catch { return null; } };

      const a = await tick();
      if (!a.moved) { v('setup', `the good sha A was not adopted: ${a.reason}`); return { violations }; }
      const bad = land('bad.txt');
      const b = await tick();
      if (!b.moved) { v('setup', `the bad sha B was not switched to: ${b.reason}`); return { violations }; }
      const rolled = await sw.checkProbation({ clone, home, settings, deps: { now: () => clock, health: async () => ({ ok: false, reason: 'soak: bad sha' }), alert() {} } });
      if (rolled.status !== 'switched' || current() !== a.versionId) { v('setup', `probation did not roll back to A: ${JSON.stringify(rolled)} current=${current()}`); return { violations }; }
      // gc prunes the held version: the real gc keeps the newest rejected folder for inspection, so drop it the way
      // a later gc does once a newer rejection exists.
      clock += 60_000;
      await sw.gc({ clone, home, settings, deps: { now: () => clock } });
      rmSync(join(ctx.dir, 'versions', b.versionId), { recursive: true, force: true });
      if (existsSync(join(ctx.dir, 'versions', b.versionId, '.version.json'))) { v('setup', 'the held version record survived the prune'); return { violations }; }

      const before = builds;
      for (let i = 1; i <= 3; i += 1) {
        const r = await tick();
        if (r.moved || builds !== before || current() !== a.versionId) {
          v('rejected-sha-rebuilt', `tick ${i} after the prune: ${JSON.stringify({ reason: r.reason, moved: r.moved })}, ${builds - before} build(s), current=${current()}; the rolled-back sha ${bad.slice(0, 12)} must stay held`);
          break;
        }
      }

      const next = land('c.txt');
      const c = await tick();
      if (!c.moved || c.head !== next) v('hold-never-released', `main advanced to ${next.slice(0, 12)} but the daemon did not rebuild: ${JSON.stringify(c)}`);

      // A transient smoke on a new sha must be retried on a later tick, not recorded permanent.
      land('d.txt');
      smoke = async () => ({ verdict: 'transient', attempts: 1 });
      await tick();
      smoke = async () => ({ verdict: 'pass', attempts: 1 });
      await tick();
      clock += 2 * 60 * 60_000; // past any backoff
      const d = await tick();
      if (!d.moved) v('transient-smoke-stuck', `a transient smoke was never retried: the tick after the backoff returned ${JSON.stringify({ reason: d.reason, moved: d.moved })}`);
    } catch (e) {
      v('crash', String(e?.message ?? e));
    } finally { rmSync(fixture, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) {
    return report.violations.map((x) => `${x.daemon} tick ${x.tick}: [${x.invariant}] ${x.detail}`);
  },
};
