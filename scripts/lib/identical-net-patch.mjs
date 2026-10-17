/** Read-only stable patch identity of each head's net change against its own merge-base with main. */
import { cascadePolicy } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
export function resolveIdenticalNetPatchSetting({ env = process.env, tool = readSettings().review, platform } = {}) {
  const key = 'carryAcrossIdenticalNetPatch', raw = env.WE_REVIEW_CARRY_ACROSS_IDENTICAL_NET_PATCH;
  const parsed = raw === undefined ? undefined : /^(on|true|1)$/i.test(raw) ? true : /^(off|false|0)$/i.test(raw) ? false : raw;
  const p = cascadePolicy('review', tool && { [key]: tool[key] }, { standard: { [key]: true }, platform, env,
    valid: v => typeof v === 'boolean', envValues: { [key]: parsed } });
  return { value: p.value[key], source: p.sources[key] };
}
const loggedSettings = new Set();
export function logIdenticalNetPatchSetting(setting, log = s => process.stderr.write(s)) {
  const key = `${setting.value}:${setting.source}`;
  if (loggedSettings.has(key)) return;
  loggedSettings.add(key);
  log(`policy · review.carryAcrossIdenticalNetPatch=${setting.value} (${setting.source})\n`);
}
export function proveIdenticalNetPatch({ exec, cwd, fromSha, toSha, mainRef = 'origin/main' } = {}) {
  try {
    if (![fromSha, toSha].every(s => /^[0-9a-f]{40}$/.test(s ?? ''))) throw Error('invalid head');
    const git = (args, input) => String(exec('git', args, { cwd, encoding: 'utf8', timeout: 10000,
      maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) }));
    const read = sha => {
      const base = git(['merge-base', mainRef, sha]).trim();
      if (!/^[0-9a-f]{40}$/.test(base)) throw Error('unreadable merge-base');
      const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', base, sha, '--']);
      if (!diff.trim()) throw Error('empty net patch');
      const output = git(['patch-id', '--stable'], diff).trim();
      const match = /^([0-9a-f]{40}) [0-9a-f]{40}$/.exec(output);
      if (!match) throw Error('unreadable patch-id');
      return { id: match[1], diff };
    };
    const from = read(fromSha), to = read(toSha);
    if (from.id !== to.id) return { ok: false, different: true, reason: 'net patch-id differs' };
    return { ok: true, tier: 'net-patch', fingerprint: to.id, fromDiff: from.diff, toDiff: to.diff,
      reason: `identical git patch-id --stable (${to.id}) against each head's merge-base with main` };
  } catch { return { ok: false, retryable: true, reason: 'net patch identity unreadable' }; }
}
