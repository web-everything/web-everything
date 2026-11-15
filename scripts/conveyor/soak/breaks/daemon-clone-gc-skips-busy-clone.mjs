/** Daemon GC must exclude borrowers and hold the clone WRITE lock throughout packing. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/lib/clone-maintenance.mjs';
const COMMANDS = [['count-objects', '-v'], ['-c', 'gc.autoDetach=false', 'gc'], ['count-objects', '-v']];

export const cases = [
  'borrowed clone (reader lock)',
  'busy clone (writer lock)',
  'unknown rebuild state fails closed',
  'rebuild starts before write lock',
  'idle clone packs under write lock',
];

export default {
  id: 'daemon-clone-gc-skips-busy-clone',
  title: 'Daemon GC skips busy clones and packs only under the write lock',
  card: 'daemon-clone-gc',
  fixedBy: { sha: '7cf1693e', where: 'lane/daemon-clone-gc', paths: [SOURCE] },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    return source.includes('export async function maybeMaintainClone(')
      && source.includes('const locked = await withLock(root, async () =>');
  },
  async run({ root = ROOT, log, caseName } = {}) {
    const { maybeMaintainClone } = await import(pathToFileURL(join(root, SOURCE)).href);
    const { acquireRead, acquireWrite, releaseRead, releaseWrite, inspectCloneLock } =
      await import(pathToFileURL(join(root, 'scripts/lib/daemon-clone-lock.mjs')).href);
    if (caseName !== undefined && !cases.includes(caseName)) throw new Error(`unknown maintenance case: ${caseName}`);
    const base = mkdtempSync(join(tmpdir(), 'soak-daemon-clone-gc-'));
    const violations = [];
    const observations = [];
    try {
      for (const name of caseName === undefined ? cases : [caseName]) {
        const dir = mkdtempSync(join(base, 'case-'));
        const clone = join(dir, 'clone');
        mkdirSync(join(clone, '.git'), { recursive: true });
        const env = { WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(dir, 'locks') };
        const lockOpts = { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, owner: 'soak-borrower', waitMs: 0 };
        const reader = name === cases[0];
        const writer = name === cases[1];
        if (reader || writer) {
          const held = reader ? acquireRead(clone, lockOpts) : await acquireWrite(clone, lockOpts);
          if (!held.ok) throw new Error(`${name}: fixture could not acquire lock`);
        }
        const commands = [];
        let jobChecks = 0;
        const result = await maybeMaintainClone({
          root: clone, env, settings: { value: { intervalMs: 86400000 } },
          hasRebuildJob: () => name === cases[2] ? null : name === cases[3] ? ++jobChecks > 1 : false,
          emitEvent: async () => {},
          run: async (args, opts) => {
            commands.push(args);
            if (opts.cwd !== clone) violations.push(`${name}: maintenance escaped fixture clone`);
            if (!inspectCloneLock(clone, lockOpts).writerLive) violations.push(`${name}: Git ran without a live write lock`);
            if (args.includes('gc')) {
              const competitor = { ...lockOpts, owner: 'soak-competing-reader' };
              if (acquireRead(clone, competitor).ok) {
                violations.push(`${name}: reader entered during GC/repack`);
                releaseRead(clone, competitor);
              }
            }
            return { status: 0, stdout: 'size: 10\nsize-pack: 1\n' };
          },
        });
        const idle = name === cases[4];
        const reason = reader ? 'reader-active' : writer ? 'writer-active'
          : name === cases[2] ? 'rebuild-state-unreadable' : name === cases[3] ? 'rebuild-active' : undefined;
        if (result.skipped !== (idle ? undefined : true) || result.reason !== reason) {
          violations.push(`${name}: unexpected result skipped=${result.skipped}, reason=${result.reason}`);
        }
        if (JSON.stringify(commands) !== JSON.stringify(idle ? COMMANDS : [])) violations.push(`${name}: unexpected Git commands ${JSON.stringify(commands)}`);
        const after = inspectCloneLock(clone, lockOpts);
        if (reader && after.readers.length !== 1) violations.push(`${name}: borrower lock lost`);
        if (writer ? after.writer?.owner !== lockOpts.owner : after.writer !== null) violations.push(`${name}: writer lock leaked or replaced`);
        if (reader) releaseRead(clone, lockOpts);
        if (writer) releaseWrite(clone, lockOpts);
        observations.push({ name, skipped: result.skipped, reason: result.reason, commands });
        log?.(`${name}: skipped=${result.skipped === true}, commands=${commands.length}`);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
    return { violations, observations };
  },
  judge: (report) => report.violations,
};
