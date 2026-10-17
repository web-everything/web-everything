/** Read-only stable patch identity of each head's net change against its own merge-base with main. */
import { cascadePolicy } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { normalizeContributionFingerprint } from './review-escalation.mjs';
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
    const git = (args, input) => {
      const output = exec('git', args, { cwd, encoding: null, timeout: 10000,
        maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) });
      const decoded = String(output);
      // UTF-8 replacement characters would collapse distinct non-UTF-8 source bytes.
      if (Buffer.isBuffer(output) && !Buffer.from(decoded, 'utf8').equals(output)) throw Error('lossy net patch decoding');
      return decoded;
    };
    const diffBetween = (base, sha) => git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', base, sha, '--']);
    // Ignore only blob IDs: keep paths, modes, hunk positions, headings and context.
    // Equal edits at different positions are not the same reviewed contribution.
    const locatedPatch = diff => diff.split('\n').filter(line => !/^index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?$/.test(line)).join('\n');
    const read = sha => {
      const base = git(['merge-base', mainRef, sha]).trim();
      if (!/^[0-9a-f]{40}$/.test(base)) throw Error('unreadable merge-base');
      const diff = diffBetween(base, sha);
      if (!diff.trim()) throw Error('empty net patch');
      const output = git(['patch-id', '--stable'], diff).trim();
      const match = /^([0-9a-f]{40}) [0-9a-f]{40}$/.exec(output);
      if (!match) throw Error('unreadable patch-id');
      return { id: match[1], diff, base };
    };
    const from = read(fromSha), to = read(toSha);
    if (from.id !== to.id) return { ok: false, different: true, reason: 'net patch-id differs' };
    // Stable patch-id discards whitespace, including indentation and string contents.
    // Keep the shared path/mode/binary-aware proof and compare changed lines verbatim,
    // including the root manifest that the contribution fingerprint deliberately ignores.
    const changedLines = diff => JSON.stringify(diff.split('\n').filter(line => /^(?:diff --git |[+\-\\])/.test(line)));
    const contribution = normalizeContributionFingerprint(from.diff);
    if (!contribution || contribution !== normalizeContributionFingerprint(to.diff)
      || changedLines(from.diff) !== changedLines(to.diff)) {
      return { ok: false, different: true, reason: 'net patch contribution bytes differ' };
    }
    if (from.base === to.base) {
      if (locatedPatch(from.diff) !== locatedPatch(to.diff)) {
        return { ok: false, different: true, reason: 'net patch hunk locations or context differ on the same base' };
      }
    } else {
      // Offset changes are allowed only when the exact same positioned upstream
      // edits turn the old base into the new base AND the cleared head into the live head.
      // This conservative read-only proof declines overlapping/shifted upstream edits.
      if (locatedPatch(diffBetween(from.base, to.base)) !== locatedPatch(diffBetween(fromSha, toSha))) {
        return { ok: false, different: true, reason: 'head movement does not match the positioned base movement' };
      }
    }
    return { ok: true, tier: 'net-patch', fingerprint: to.id, fromDiff: from.diff, toDiff: to.diff,
      reason: `identical git patch-id --stable (${to.id}), contribution bytes and positioned edits against each head's merge-base with main` };
  } catch { return { ok: false, retryable: true, reason: 'net patch identity unreadable' }; }
}
