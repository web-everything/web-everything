/** Compose existing proofs on a bounded first-parent path; no unproved hop inherits approval. */
import { MAX_NUMBERING_COMMITS, proveNumberingOnlyMove } from './numbering-carry.mjs';
import { proveMechanicalMove } from './human-clearance-carry.mjs';
import { proveReplayEquivalent } from './carry-equivalence.mjs';
import { proveIdenticalNetPatch } from './identical-net-patch.mjs';

/**
 * PURE: wrap a git exec so every diff reads submodule pointer changes. Command-line flags override both repository
 * config and a tracked .gitmodules `ignore=all`, so a proof built on this exec cannot be blinded by either.
 */
export function submoduleStrictExec(exec) {
  return (cmd, args, opts) => {
    const proofArgs = cmd === 'git' && ['diff', 'diff-tree'].includes(args?.[0])
      ? [args[0], '--ignore-submodules=none', ...args.slice(1)] : args;
    return exec(cmd, proofArgs, { ...opts,
      env: { ...process.env, ...opts?.env, GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'diff.ignoreSubmodules', GIT_CONFIG_VALUE_0: 'none' } });
  };
}
// Every hop contains at least one commit, so the shared commit limit also bounds hops.
export function proveMixedMechanicalChain({ exec, cwd, fromSha, toSha, mainRef = 'origin/main',
  numberingEnabled = true, netPatchEnabled = true } = {}) {
  const refuse = reason => ({ ok: false, reason: `${reason}; retain pending and request a fresh re-review of the current head` });
  try {
    if (typeof exec !== 'function' || ![fromSha, toSha].every(s => /^[0-9a-f]{40}$/.test(s ?? ''))
      || fromSha === toSha) return refuse('invalid chain endpoints');
    // Bind all delegates to the same repository and IO bounds. Missing objects are a refusal, never a fetch.
    const boundedExec = (cmd, args, opts) => {
      if (cmd !== 'git' || args[0] === 'fetch') throw Error('chain proof requires readable local git evidence');
      // Command-line diff flags override both repository config and per-submodule ignore settings.
      const subcommand = args[0];
      const proofArgs = ['diff', 'diff-tree'].includes(subcommand)
        ? [subcommand, '--ignore-submodules=none', ...args.slice(1)] : args;
      const output = exec(cmd, proofArgs, { ...opts, cwd,
        env: { ...process.env, ...opts?.env, GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'diff.ignoreSubmodules', GIT_CONFIG_VALUE_0: 'none' }, timeout: Math.min(opts?.timeout ?? 5000, 5000),
        maxBuffer: Math.min(opts?.maxBuffer ?? 8 * 1024 * 1024, 8 * 1024 * 1024) });
      if (output == null || Buffer.byteLength(output) > 8 * 1024 * 1024) throw Error('chain git evidence unreadable or over byte limit');
      return output;
    };
    const git = args => String(boundedExec('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    for (const sha of [fromSha, toSha]) {
      if (git(['rev-parse', '--verify', `${sha}^{commit}`]) !== sha) return refuse('chain endpoint unreadable');
    }
    // Pin main once so no delegate can observe a different main during this proof.
    const main = git(['rev-parse', '--verify', `${mainRef}^{commit}`]);
    if (!/^[0-9a-f]{40}$/.test(main)) return refuse('chain main unreadable');
    const lines = git(['rev-list', '--first-parent', '--reverse', '--parents',
      `--max-count=${MAX_NUMBERING_COMMITS + 1}`, `${fromSha}..${toSha}`]).split('\n').filter(Boolean);
    if (!lines.length) return refuse('no first-parent chain');
    if (lines.length > MAX_NUMBERING_COMMITS) return refuse(`chain commit/hop limit ${MAX_NUMBERING_COMMITS} exceeded`);
    let parent = fromSha;
    const steps = [];
    for (const line of lines) {
      const [sha, ...parents] = line.split(' ');
      if (![sha, ...parents].every(s => /^[0-9a-f]{40}$/.test(s))
        || ![1, 2].includes(parents.length) || parents[0] !== parent) {
        return refuse('first-parent path does not reach the approved head exactly');
      }
      steps.push({ sha, parents }); parent = sha;
    }
    if (parent !== toSha) return refuse('first-parent path does not reach the live head');
    const hops = [];
    for (let i = 0; i < steps.length;) {
      const start = steps[i], from = start.parents[0];
      let to = start.sha, proof, kind;
      if (start.parents.length === 1) {
        kind = 'numbering';
        if (numberingEnabled !== true) return refuse('numbering carry disabled');
        while (++i < steps.length && steps[i].parents.length === 1) to = steps[i].sha;
        proof = proveNumberingOnlyMove({ exec: boundedExec, cwd, fromSha: from, toSha: to, mainRef: main });
      } else {
        kind = 'merge'; i++;
        if (netPatchEnabled !== true) return refuse('identical net patch carry disabled');
        const inputs = { exec: boundedExec, cwd, fromSha: from, toSha: to, mainRef: main };
        proof = proveMechanicalMove(inputs);
        if (proof.ok && proof.kind !== 'merge') return refuse('hop is not a merge of main');
        // No transient exceptions: a merge cannot smuggle even a normally ignored manifest edit.
        if (proof.ok) proof = proveReplayEquivalent({ ...inputs, transient: [] });
        if (proof.ok) proof = proveIdenticalNetPatch(inputs);
      }
      if (!proof.ok) return { ...refuse(`${kind} hop ${from} -> ${to}: ${proof.reason}`), ...(proof.retryable ? { retryable: true } : {}) };
      hops.push({ kind, from, to, reason: proof.reason });
    }
    if (git(['rev-parse', '--verify', `${mainRef}^{commit}`]) !== main) {
      return { ...refuse('chain main moved during proof'), retryable: true };
    }
    return { ok: true, kind: 'chain', hops,
      reason: `mechanical chain: ${hops.map(h => `${h.kind} ${h.from} -> ${h.to} (${h.reason})`).join('; ')}` };
  } catch {
    return refuse('mechanical chain evidence unreadable');
  }
}
