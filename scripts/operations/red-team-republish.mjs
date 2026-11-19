#!/usr/bin/env node
/** Recover publication of a finished red-team round without running a new round or changing check runs. */
import { pathToFileURL } from 'node:url';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { republishPublicationStatus } from '../lib/drain-red-team-evidence.mjs';
import { resolveRedTeamWriter } from '../lib/red-team-check-run.mjs';

export function main(argv = process.argv.slice(2), { env = process.env, gh = runGhSync,
  republish = republishPublicationStatus, resolveWriter = resolveRedTeamWriter,
  print = value => process.stdout.write(`${JSON.stringify(value, null, 2).replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')}\n`) } = {}) {
  const flags = {};
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--dry-run') flags.dryRun = true;
      else if (['--repo', '--pr', '--head'].includes(arg) && argv[i + 1] && !argv[i + 1].startsWith('--')) flags[arg.slice(2)] = argv[++i];
      else throw Error('usage: red-team-republish --repo owner/repo --pr number [--head sha] [--dry-run]');
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(flags.repo ?? '') || !/^[1-9]\d*$/.test(flags.pr ?? '')
      || !Number.isSafeInteger(Number(flags.pr))) throw Error('valid --repo and --pr required');
    if (!flags.head) {
      const freshEnv = { ...env, WE_GH_READ_MEMO_DIR: '' };
      const live = JSON.parse(gh(['pr', 'view', flags.pr, '--repo', flags.repo, '--json', 'headRefOid'], {
        env: freshEnv, throttle: { env: freshEnv }, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 }));
      flags.head = live?.headRefOid;
    }
    // Even a CLI no-op requires a resolved App identity. The library can then reuse this pinned writer.
    const writer = resolveWriter({ env, gh });
    if (writer?.ok !== true) {
      print({ ok: false, reason: writer?.reason ?? 'App token unresolved', before: null, decision: 'refuse' });
      return 1;
    }
    const result = republish({ ...flags, pr: Number(flags.pr), env, gh, resolveWriter: () => writer });
    print(result);
    return result?.ok === true ? 0 : 1;
  } catch (error) {
    print({ ok: false, reason: String(error?.message ?? error).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ') });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
