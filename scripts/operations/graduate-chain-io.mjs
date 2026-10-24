/** Bounded exec and temporary resources for graduate-chain. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { extractSubmitResult } from './open-pr.mjs';
import { runGraduateChain } from './graduate-chain.mjs';

/** Stops are results: keep the full outcome in the run record. */
export function createGraduateChainSinks({ run = createGraduateChainRunner() } = {}) {
  return { 'graduate-chain.run': async payload => run(payload) };
}

export function createGraduateChainRunner({ cwd = process.cwd(), env = process.env,
  exec = (cmd, args, options) => spawnSync(cmd, args, { ...options, encoding: 'utf8',
    timeout: 3 * 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }),
} = {}) {
  return input => {
    const temporary = [];
    const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'graduate-chain-')); temporary.push(dir); return dir; };
    return runGraduateChain(input, { exec, cwd, env, cascadePolicy, extractSubmitResult,
      readTemplate: file => readFileSync(resolve(cwd, file), 'utf8'),
      writeBody: body => { const file = join(temp(), 'body.md'); writeFileSync(file, body); return file; },
      mergeEnvironment: (objects, directory) => ({ GIT_OBJECT_DIRECTORY: temp(),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(directory, objects) }),
      cleanup: () => { for (const dir of temporary) rmSync(dir, { recursive: true }); },
    });
  };
}
