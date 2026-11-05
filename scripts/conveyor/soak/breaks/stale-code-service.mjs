/**
 * Incident: com.we.resource-sampler ran pre-rebuild code for 2.5 days while its
 * clone repeatedly adopted rebuilds, producing snapshots rejected by the stamp
 * gate. Exercise the real adoption hook and restart helper with host IO injected;
 * omitting the restart reproduces the stale process against the same evidence.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withSelfSync } from '../../../lib/daemon-self-sync.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HELPER = 'scripts/lib/launchd-code-restart.mjs';
const HOOK = 'scripts/lib/daemon-self-sync.mjs';
const LABEL = 'com.we.resource-sampler';
const ADOPTED_SHA = 'adopted-build';
const ADOPTED_AT = Date.parse('2026-11-05T12:00:00Z');

async function replay(helper, restartOnAdoption) {
  const cloneRoot = join(ROOT, 'fixtures', 'sampler-clone');
  const kicks = [], errors = [], stateStore = new Map();
  let processStartMs = ADOPTED_AT - 2.5 * 24 * 60 * 60 * 1000;
  let adoptedAtMs = processStartMs - 1000;
  let adopted = false, adopterExited = false, freshAtExit = false;
  const io = {
    cloneRoot, agentsDir: join(ROOT, 'fixtures', 'LaunchAgents'),
    listPlists: () => ['resource-sampler.plist'],
    readPlist: () => ({ Label: LABEL, ProgramArguments: ['node', join(cloneRoot, 'sampler.mjs')] }),
    readProcessStartMs: () => processStartMs, readAdoptedAtMs: () => adoptedAtMs,
  };
  const inspect = () => helper ? helper.findStaleCodeServices(io)
    : (processStartMs < adoptedAtMs ? [{ label: LABEL, reason: 'stale-code' }] : []);
  const before = inspect();
  const effects = withSelfSync({ tickOnce: () => 'unexpected-tick' }, {
    root: cloneRoot, env: { XPC_SERVICE_NAME: 'com.we.adopter' }, versions: null, background: null,
    entries: [join(cloneRoot, 'daemon.mjs')], minRestartIntervalMs: 0,
    readHead: () => 'boot-build', readOriginRef: () => null,
    readState: () => ({}), readReady: () => null, cloneIdentity: () => null,
    acquireRead: () => ({ ok: true }), releaseRead: () => {},
    importClosure: () => new Set(), diffFiles: () => null,
    log: { error: line => errors.push(line) },
    rebuild: async () => {
      adopted = true; adoptedAtMs = ADOPTED_AT;
      return { moved: true, adopted: true, head: ADOPTED_SHA };
    },
    restartServices: restartOnAdoption && helper ? args => helper.restartServicesForClone({
      ...io, ...args, platform: null, stateStore,
      lockStore: { acquire: async () => async () => {} },
      // Async host inspection must finish before the adopter can exit.
      listPlists: async () => { await Promise.resolve(); return io.listPlists(); },
      uid: () => 501, now: () => ADOPTED_AT + 1000,
      launchctl: argv => {
        if (adopterExited) throw new Error('adopter exited before kickstart');
        kicks.push(argv); processStartMs = ADOPTED_AT + 1000;
        return { status: 0 };
      },
    }) : () => {},
    onRestart: () => {
      freshAtExit = inspect().length === 0;
      adopterExited = true;
      return 'adopter-exited';
    },
  });
  const outcome = await effects.tickOnce();
  return { before, stale: inspect(), kicks, intent: stateStore.get(LABEL),
    adopted, adopterExited, freshAtExit, outcome, errors };
}

export default {
  id: 'stale-code-service',
  title: 'clone adoption restarts its stateless launchd sampler before the adopter exits',
  card: 'com.we.resource-sampler stale-code-service incident',
  fixedBy: { sha: '97d6bcd0b6', where: 'launchd-code-restart', paths: [HELPER, HOOK] },
  fixPresent(root) {
    try {
      return existsSync(join(root, HELPER))
        && readFileSync(join(root, HOOK), 'utf8').includes('restartServicesForClone');
    } catch { return false; }
  },
  async run({ log } = {}) {
    const violations = [];
    try {
      // Missing helper in a pre-fix tree must reproduce stale code, never skip.
      const helper = existsSync(join(ROOT, HELPER)) ? await import(pathToFileURL(join(ROOT, HELPER)).href) : null;
      const before = await replay(helper, false);
      if (before.before.length || !before.adopted || !before.adopterExited
          || before.kicks.length || before.stale[0]?.reason !== 'stale-code' || before.freshAtExit) {
        violations.push({ invariant: 'scenario-ran', detail: 'no-restart adoption did not reproduce the stale sampler' });
      }
      const after = await replay(helper, true);
      if (after.before.length || !after.adopted || after.outcome !== 'adopter-exited') {
        violations.push({ invariant: 'scenario-ran', detail: 'rebuild adoption and adopter exit were not exercised' });
      }
      if (after.stale.length || !after.freshAtExit) {
        violations.push({ invariant: 'stale-code-service', detail: 'sampler still runs pre-rebuild code when the adopter exits' });
      }
      if (JSON.stringify(after.kicks) !== JSON.stringify([['kickstart', '-k', `gui/501/${LABEL}`]])
          || after.intent?.sha !== ADOPTED_SHA) {
        violations.push({ invariant: 'restart-on-adoption', detail: 'expected exactly one kickstart with persisted adoption intent' });
      }
      log?.(`stale-code-service: without restart=${before.stale.length}, with restart=${after.stale.length}, kicks=${after.kicks.length}`);
      return { violations, report: { before, after } };
    } catch (error) {
      violations.push({ invariant: 'crash', detail: String(error?.stack ?? error) });
      return { violations };
    }
  },
  judge(report) { return report.violations.map(v => `[${v.invariant}] ${v.detail}`); },
};
