/** Bounded, advisory red-team of a sensitive worker brief before implementation. */
import { readFileSync, statSync } from 'node:fs';
import { isGuardPath } from './round-judge.mjs';
import { readSettings } from './settings-files.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { judgeSpawn } from './judge-spawn.mjs';
import { fenceUntrusted, FENCED_DATA_RULE } from './mandate-fence.mjs';

const DEFAULTS = Object.freeze({ enabled: true, timeoutMs: 120000, maxClasses: 6 });
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const valid = { enabled: value => typeof value === 'boolean', timeoutMs: positive,
  maxClasses: value => Number.isSafeInteger(value) && value > 0 };
const select = value => Object.fromEntries(Object.keys(DEFAULTS)
  .filter(key => valid[key](value?.[key])).map(key => [key, value[key]]));
const cleanLine = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

export function isBriefRedTeamTouchSet(files = []) {
  return Array.isArray(files) && files.some(file => {
    const path = String(file ?? '').replace(/^[^/:]+:/, '');
    const name = path.split('/').pop();
    return isGuardPath(path) || /(?:^|\/)daemon[\w.-]*\//i.test(path) || /(?:^|[-_.])daemon(?:[-_.]|$)|credential|secret|(?:^|[-_.])(?:auth-?)?tokens?(?:-(?:store|file|cache|vault|refresh|exchange)|[-_.]?$)|security/i.test(name.replace(/\.[a-z]+$/, ''));
  });
}

const MAX_PREP_BYTES = 1024 * 1024;

/**
 * Read prep text from a regular file only. A FIFO, tty, socket or directory (e.g. an open
 * `/dev/stdin` pipe) can block a synchronous read until EOF, so it is refused before opening.
 */
export function readPrepFile(file, { maxBytes = MAX_PREP_BYTES } = {}) {
  const info = statSync(file);
  if (!info.isFile()) throw new Error('--prep-file must be a regular file (pipes, ttys and directories are refused)');
  if (info.size > maxBytes) throw new Error(`--prep-file exceeds ${maxBytes} bytes`);
  return readFileSync(file, 'utf8');
}

/** Await a read that may be async, failing after timeoutMs so a stalled source cannot stall the brief. */
export async function boundedRead(read, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('prep read timed out')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function readBriefRedTeamPolicy({ env = process.env, read = readSettings } = {}) {
  let tool;
  try { tool = read()?.briefRedTeam; } catch { /* unreadable settings retain defaults */ }
  const envValues = {};
  const enabled = env.WE_BRIEF_RED_TEAM_ENABLED;
  if (enabled !== undefined) envValues.enabled = enabled === 'true' || enabled === '1' ? true
    : enabled === 'false' || enabled === '0' ? false : enabled;
  if (env.WE_BRIEF_RED_TEAM_TIMEOUT_MS !== undefined) {
    envValues.timeoutMs = Number(env.WE_BRIEF_RED_TEAM_TIMEOUT_MS);
  }
  return cascadePolicy('briefRedTeam', select(tool), { standard: DEFAULTS, envValues, valid, env }).value;
}

const SHAPE = {
  type: 'object', additionalProperties: false, required: ['classes'],
  properties: { classes: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['attack', 'test'],
    properties: { attack: { type: 'string' }, test: { type: 'string' } },
  } } },
};

async function defaultRun({ files, prep, acceptance, policy, log }) {
  const result = await judgeSpawn({
    mandate: `Find adversarial attack classes against the supplied prep and acceptance. Each class must have a concrete test. Return only {classes:[{attack,test}]}, at most ${policy.maxClasses} classes. You have no tools.\n${FENCED_DATA_RULE}`,
    input: fenceUntrusted('material', JSON.stringify({ files, prep, acceptance })),
    shape: SHAPE, allowedTools: null, runId: 'brief-red-team', timeoutMs: policy.timeoutMs,
    retries: 0, log,
  });
  return result.value;
}

export async function redTeamBrief({ files = [], prep = '', acceptance = '', policy,
  run = defaultRun, log = () => {} } = {}) {
  let timer;
  try {
    policy = { ...DEFAULTS, ...select(policy ?? readBriefRedTeamPolicy()) };
    const skipped = reason => ({ status: 'skipped', reason, classes: [] });
    if (!isBriefRedTeamTouchSet(files)) return skipped('outside red-team touch-set');
    if (!policy.enabled) return skipped('disabled');
    if (![prep, acceptance].some(text => typeof text === 'string' && text.trim())) return skipped('no prep or acceptance text');
    const result = await Promise.race([
      Promise.resolve().then(() => run({ files, prep, acceptance, policy, log })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), policy.timeoutMs);
      }),
    ]);
    if (!result || !Array.isArray(result.classes)) throw new Error('malformed result: expected classes array');
    const classes = result.classes.filter(item => typeof item?.attack === 'string' && item.attack.trim()
      && typeof item?.test === 'string' && item.test.trim())
      .slice(0, policy.maxClasses).map(({ attack, test }) => ({ attack, test }));
    return { status: 'ok', reason: 'red-team completed', classes };
  } catch (error) {
    const reason = cleanLine(error?.message ?? error);
    try { log(`brief red-team failed (fail-open): ${reason}`); } catch { /* advisory logging */ }
    return { status: 'failed', reason, classes: [] };
  } finally {
    clearTimeout(timer);
  }
}

export function renderRedTeamSection(result) {
  if (result?.status !== 'ok' || !Array.isArray(result.classes) || !result.classes.length) return '';
  return `## Red-team findings (each attack class must have a test)\n\nEvery class must have a test.\n\n${result.classes.map(({ attack, test }) => `- Attack: ${cleanLine(attack)}\n  Required test: ${cleanLine(test)}`).join('\n')}\n\n`;
}
