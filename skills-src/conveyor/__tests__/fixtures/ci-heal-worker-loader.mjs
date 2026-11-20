/** Integration-only IO substitution. Keep main(), startCiHealWorker(), the worker
 * entry point, runDaemonLoop() and runCiHealLoop() intact. No live lease/auth/dispatch IO.
 * AST body substitutions fail loudly if a required fixture port disappears. */
import ts from 'typescript';

const daemonPorts = {
  buildCliDaemonEffects: String.raw`
    const record = event => writeFileSync(process.env.CI_HEAL_WORKER_PROBE_FILE,
      JSON.stringify({ event, at: Date.now(), pid: process.pid, threadId: probeThreadId }) + '\n', { flag: 'a' });
    return {
      maxTicks: 1, heartbeat: () => true, sleep: realSleep, onTick() {},
      onTickError(error) { throw error; },
      tickOnce: async () => {
        if (arguments[0].ciHealOwnLoop !== true) throw Error('main tick must disable serial ci-heal');
        // A real worker message establishes startup before the blocking phase.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('production ci-heal worker never admitted at startup')), 8000);
          probeReady.then(() => { clearTimeout(timer); resolve(); });
        });
        record('block-start');
        execFileSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750)'],
          { timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] });
        record('block-end');
        return { dispatched: [], refusals: [] };
      },
    };
  `,
  runCiHealPass: String.raw`
    probeChannel.postMessage('admit');
    writeFileSync(process.env.CI_HEAL_WORKER_PROBE_FILE,
      JSON.stringify({ event: 'admit', at: Date.now(), pid: process.pid, threadId: probeThreadId }) + '\n', { flag: 'a' });
    return Promise.resolve({ dispatched: [], refusals: [] });
  `,
  withFixDispatchClaimRefresh: 'return arguments[0];',
};
const ports = new Map([
  ['/skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs', daemonPorts],
  ['/skills-src/conveyor/runner-lock.mjs', {
    acquireRunnerLease: 'return { ok: true };', releaseRunnerLeaseIfOwned: 'return true;',
  }],
  ['/skills-src/conveyor/daemon-log.mjs', { installDaemonLog: 'return undefined;' }],
  ['/scripts/conveyor/await-verify-loop.mjs', { superviseAwaitVerifyLoop: 'return { start() {}, stop() {} };' }],
  ['/scripts/lib/github-app-auth-env.mjs', { withGithubAppAuth: 'return arguments[0];' }],
  ['/scripts/lib/daemon-self-sync.mjs', { withSelfSync: 'return arguments[0];' }],
  ['/scripts/lib/pr-events.mjs', { withPrEvents: 'return arguments[0];' }],
]);

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  const entry = [...ports].find(([suffix]) => new URL(url).pathname.endsWith(suffix));
  if (!entry) return loaded;
  const source = String(loaded.source), replacements = [], found = new Set();
  const ast = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && entry[1][node.name?.text]) {
      if (!node.body) throw Error('fixture port has no body');
      found.add(node.name.text);
      replacements.push({ start: node.body.getStart(ast) + 1, end: node.body.end - 1, text: entry[1][node.name.text] });
    }
    // Scale time only; retain the real worker startup/default propagation.
    if (entry[1] === daemonPorts && ts.isVariableDeclaration(node) && node.name.getText(ast) === 'DEFAULT_INTERVAL_MS') {
      replacements.push({ start: node.initializer.getStart(ast), end: node.initializer.end, text: '25' });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const name of Object.keys(entry[1])) if (!found.has(name)) throw Error('missing integration IO port: ' + name);
  let instrumented = source;
  for (const edit of replacements.sort((a, b) => b.start - a.start)) {
    instrumented = instrumented.slice(0, edit.start) + edit.text + instrumented.slice(edit.end);
  }
  if (entry[1] === daemonPorts) {
    const prelude = `
      import { BroadcastChannel as ProbeBroadcastChannel, threadId as probeThreadId } from 'node:worker_threads';
      const probeChannel = new ProbeBroadcastChannel(process.env.CI_HEAL_WORKER_PROBE_FILE);
      probeChannel.unref();
      const probeReady = new Promise(resolve => {
        probeChannel.onmessage = () => { probeChannel.close(); resolve(); };
      });
    `;
    const firstLineEnd = instrumented.indexOf('\n') + 1;
    instrumented = instrumented.slice(0, firstLineEnd) + prelude + instrumented.slice(firstLineEnd);
  }
  return { ...loaded, source: instrumented };
}
