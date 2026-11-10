#!/usr/bin/env node
/**
 * @file scripts/conveyor/judge-switch.mjs
 * @description Operator on/off/wait/status CLI for the fixed, fail-closed judge store (#5063).
 */
import * as nodeFs from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JUDGE_SWITCHES_PATH } from '../lib/judge-trusted-paths.mjs';
import { planJudgeSwitchWrite, readJudgeSwitches, writeJudgeSwitches } from '../lib/judge-switches.mjs';

/** Testable IO shell. The path is injectable for tests only; no CLI flag or env can change it. */
export function main(argv, {
  fs = nodeFs, path = JUDGE_SWITCHES_PATH, env = process.env,
  now = () => new Date(), userInfo = () => os.userInfo(),
  stdout = process.stdout, stderr = process.stderr,
} = {}) {
  const [verb, ...rest] = argv;
  try {
    if (!['on', 'off', 'wait', 'status'].includes(verb)) {
      throw new Error('usage: judge-switch.mjs <on|off|wait|status> [--hours=N] --reason=<text>');
    }
    const flags = {};
    for (const arg of rest) {
      const match = /^--(reason|hours)=(.*)$/s.exec(arg);
      if (!match || verb === 'status' || (match[1] === 'hours' && verb !== 'wait') || Object.hasOwn(flags, match[1])) {
        throw new Error(`invalid argument: ${arg}`);
      }
      flags[match[1]] = match[2];
    }
    let state = readJudgeSwitches({ fs, path });
    if (verb !== 'status') {
      const hours = typeof flags.hours === 'string' && flags.hours.trim() !== '' ? Number(flags.hours) : NaN;
      state = planJudgeSwitchWrite(state, verb, {
        hours, reason: flags.reason,
        by: env.CLAUDE_CODE_SESSION_ID || userInfo().username,
        at: new Date(now()).toISOString(),
      });
      writeJudgeSwitches(state, { fs, path });
    }
    stdout.write(JSON.stringify({ path, state: state.judgeEnabled ? 'ON' : 'OFF', ...state }, null, 2) + '\n');
    return 0;
  } catch (error) {
    stderr.write(`judge-switch: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
