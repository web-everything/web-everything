/** @file scripts/operations/lane-test.mjs
 * @description Pure lane-test plan, declaration and Vitest summary parser. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';

export const LANE_TEST_EFFECT = 'lane-test.run';
export function planLaneTest({ ref, files, retries = 3, retryWaitSec = 120, purpose = 'lane-test' }) {
  if (typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..')) throw new Error('invalid ref');
  if (typeof files !== 'string' || !files.trim()) throw new Error('files are required');
  const paths = [...new Set(files.trim().split(/[,\s]+/).filter(Boolean))];
  if (!paths.length || paths.some(p => !/^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(p) || p.includes('..'))) throw new Error('unsafe test path');
  if (!Number.isInteger(retries) || retries < 1 || retries > 10) throw new Error('retries must be 1..10');
  if (!Number.isFinite(retryWaitSec) || retryWaitSec < 0) throw new Error('invalid retryWaitSec');
  if (typeof purpose !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(purpose)) throw new Error('invalid purpose');
  return { ref, files: paths, retries, retryWaitSec, purpose };
}
export function summarizeVitest(text) {
  const clean = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const counts = label => {
    const line = clean.match(new RegExp(`^\\s*${label}\\s+(.+)$`, 'm'))?.[1];
    if (!line) return null;
    const n = word => Number(line.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
    return { passed: n('passed'), failed: n('failed'), total: Number(line.match(/\((\d+)\)/)?.[1] ?? n('passed') + n('failed')) };
  };
  return { testFiles: counts('Test Files'), tests: counts('Tests'),
    failedFiles: [...new Set([...clean.matchAll(/^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+)/gm)].map(m => m[1]))] };
}
export function laneTestOperation() {
  return op('lane-test', {
    input: { ref: 'string', files: 'string', retries: { type: 'number', default: 3, required: false },
      retryWaitSec: { type: 'number', default: 120, required: false }, purpose: { type: 'string', default: 'lane-test', required: false } },
    verdictFrom: 'plan',
    plan: compute({ reads: ['input.ref', 'input.files', 'input.retries', 'input.retryWaitSec', 'input.purpose'], fn: v => planLaneTest(v.input) }),
    run: effect({ reads: ['verdict'], effects: v => [{ type: LANE_TEST_EFFECT, idempotent: false, payload: v.verdict }] }),
  });
}
