import { spawnSync } from 'node:child_process';
import { readOverlays } from '../lib/daemon-overlays.mjs';
import { readRebuildStateFile, lastGoodForClone } from '../lib/daemon-last-good.mjs';
import { collectDaemonStatus } from './daemon-status-io.mjs';
function gitRead(clone, args) {
  const result = spawnSync('git', ['-C', clone, ...args], {
    encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, text: result.stdout?.trim() || '' };
}
export function collectOverlayStatus({ clone } = {}, {
  discover = collectDaemonStatus, list = readOverlays, rebuild = readRebuildStateFile, git = gitRead,
} = {}) {
  const paths = clone ? [clone] : [...new Set(discover().daemons.map((d) => d.clone).filter(Boolean))];
  return { clones: paths.map((path) => {
    const overlays = list(path), remoteTips = new Map();
    const refs = [...new Set(['main', ...overlays.map((r) => r.ref)])].map((ref) => `refs/heads/${ref}`);
    // Bound remote round trips per clone, including main in the same snapshot.
    for (let i = 0; i < refs.length; i += 100) {
      const result = git(path, ['ls-remote', 'origin', ...refs.slice(i, i + 100)]);
      if (result.status === 0) for (const line of result.text.split('\n')) {
        const [sha, ref] = line.split('\t');
        if (/^[a-f0-9]{40,64}$/.test(sha)) remoteTips.set(ref, sha);
      }
    }
    const rev = (ref) => {
      const result = git(path, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
      return result.status === 0 && /^[a-f0-9]{40,64}$/.test(result.text) ? result.text : null;
    };
    const fresh = (ref, sha) => !!sha && remoteTips.get(`refs/heads/${ref}`) === sha;
    const ancestor = (a, b) => !!a && !!b && git(path, ['merge-base', '--is-ancestor', a, b]).status === 0;
    const headSha = rev('HEAD'), mainSha = rev('refs/remotes/origin/main');
    const mainFresh = fresh('main', mainSha), state = rebuild(path);
    const holding = lastGoodForClone({ root: path, headSha, readState: () => state });
    const registrations = overlays.map((r) => {
      const tipSha = rev(`refs/remotes/origin/${r.ref}`);
      return { ref: r.ref, ...(r.pinned === true ? { pinned: true } : {}), recordedSha: r.sha ?? state?.adopted?.applied?.find((a) => a.ref === r.ref)?.sha ?? null,
        tipSha, fresh: fresh(r.ref, tipSha) };
    });
    return { clone: path, headSha, building: !!state?.building,
      held: state?.held != null, heldSince: holding.heldSince, heldWhy: state?.held?.why ?? null,
      onLastGood: state ? holding.onLastGood : null,
      registrations: registrations.map((r) => ({ ...r, adopted: ancestor(r.tipSha, headSha),
        onMain: mainFresh && ancestor(r.tipSha, mainSha),
        containers: registrations.filter((other) => other.ref !== r.ref && ancestor(r.tipSha, other.tipSha)).map((o) => o.ref),
      })),
    };
  }) };
}
