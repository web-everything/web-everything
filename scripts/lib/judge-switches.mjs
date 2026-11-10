/**
 * @file scripts/lib/judge-switches.mjs
 * @description Fail-closed judge switches: pure validation/planning and atomic store IO (#5063).
 */
import * as nodeFs from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JUDGE_SWITCHES_PATH } from './judge-trusted-paths.mjs';

const validHours = (value) => Number.isInteger(value) && value >= 0 && value <= 168;
const closed = (parseError) => ({
  judgeEnabled: false, waitHours: 0, by: null, at: null, reason: null, parseError,
});

/** Parse untrusted JSON text. Only a valid object with a literal true enables the judge. */
export function parseJudgeSwitches(raw) {
  if (raw == null) return closed('store-absent');
  if (typeof raw !== 'string') return closed('invalid-json');
  let value;
  try { value = JSON.parse(raw); } catch { return closed('invalid-json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return closed('invalid-store');
  if (typeof value.judgeEnabled !== 'boolean') return closed('invalid-judgeEnabled');
  if (Object.hasOwn(value, 'waitHours') && !validHours(value.waitHours)) return closed('invalid-waitHours');
  for (const field of ['by', 'at', 'reason']) {
    if (Object.hasOwn(value, field) && typeof value[field] !== 'string') return closed(`invalid-${field}`);
  }
  return {
    judgeEnabled: value.judgeEnabled === true,
    waitHours: value.waitHours ?? 0,
    by: value.by ?? null, at: value.at ?? null, reason: value.reason ?? null,
  };
}

/** Plan a complete replacement; clock and actor are inputs. Wait never turns the judge on. */
export function planJudgeSwitchWrite(current, verb, args = {}) {
  if (!['on', 'off', 'wait'].includes(verb)) throw new Error('unknown judge switch verb');
  if (typeof args.reason !== 'string' || !args.reason.trim()) throw new Error('--reason is required');
  if (verb === 'wait' && !validHours(args.hours)) throw new Error('--hours must be a whole number from 0 to 168');
  for (const field of ['by', 'at']) {
    if (typeof args[field] !== 'string' || !args[field].trim()) throw new Error(`${field} is required`);
  }
  const enabled = current?.judgeEnabled === true && !current?.parseError;
  const waitHours = !current?.parseError && validHours(current?.waitHours) ? current.waitHours : 0;
  return {
    judgeEnabled: verb === 'on' ? true : verb === 'off' ? false : enabled,
    waitHours: verb === 'wait' ? args.hours : waitHours,
    by: args.by, at: args.at, reason: args.reason.trim(),
  };
}

/** Missing and unreadable stores stop the judge; callers can inject all filesystem access. */
export function readJudgeSwitches({ path = JUDGE_SWITCHES_PATH, fs = nodeFs } = {}) {
  try {
    return parseJudgeSwitches(fs.readFileSync(path, 'utf8'));
  } catch (error) {
    let code;
    try { code = error?.code; } catch { code = undefined; }
    return closed(code === 'ENOENT' ? 'store-absent' : `store-unreadable:${typeof code === 'string' ? code : 'unknown'}`);
  }
}

/** Write complete JSON beside the target, then replace it with one atomic rename. */
export function writeJudgeSwitches(state, { path = JUDGE_SWITCHES_PATH, fs = nodeFs } = {}) {
  const text = JSON.stringify(state, null, 2) + '\n';
  const checked = parseJudgeSwitches(text);
  if (checked.parseError) throw new Error(`refusing invalid judge switches: ${checked.parseError}`);
  fs.mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, path);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
