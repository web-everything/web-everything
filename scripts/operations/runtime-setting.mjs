/**
 * @file scripts/operations/runtime-setting.mjs
 * @description The declared `runtime-setting` operation: get / list / set / unset an ALLOWLISTED operational knob in
 *   the runtime-operator settings layer (`we:scripts/lib/runtime-settings.mjs`), so it applies on the reading
 *   daemon's next tick with no rebuild. The value is validated against the key's declared bounds before any write;
 *   the write is atomic (temp + rename) and appends one audit line (who / when / why / before / after).
 *
 *   USAGE (positional sugar, normalised by {@link runtimeSettingArgv}):
 *     node scripts/operations/run.mjs runtime-setting set <key> <value> --actor=<login> --reason=…
 *     node scripts/operations/run.mjs runtime-setting unset <key> --actor=<login> --reason=…
 *     node scripts/operations/run.mjs runtime-setting get <key>
 *     node scripts/operations/run.mjs runtime-setting list
 */
import { op } from './registry.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';
import { planRuntimeSetting } from '../lib/runtime-settings.mjs';

export const RUNTIME_SETTING_OP = 'runtime-setting';
export const RUNTIME_SETTING_WRITE_EFFECT = 'fs.runtime-setting-write';
const ACTIONS = ['set', 'unset', 'get', 'list'];

/** PURE: `set <key> <value> --flags…` → `--action=set --key=<key> --value=<value> --flags…`. Flags pass through. */
export function runtimeSettingArgv(argv = []) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const pos = argv.filter((a) => !a.startsWith('--'));
  if (!pos.length || !ACTIONS.includes(pos[0])) return argv;
  const [action, key, value, ...extra] = pos;
  return [`--action=${action}`, ...(key !== undefined ? [`--key=${key}`] : []), ...(value !== undefined ? [`--value=${value}`] : []), ...extra, ...flags];
}

/** @param {{readRuntime:()=>{path:string|null, entries:object, warnings:string[]}, now?:()=>string}} io */
export function runtimeSettingOperation({ readRuntime, now = () => new Date().toISOString() } = {}) {
  if (typeof readRuntime !== 'function') throw new TypeError('runtime-setting: needs a readRuntime reader');
  return op(RUNTIME_SETTING_OP, {
    input: {
      action: 'string',
      key: { type: 'string', required: false, default: '' },
      value: { type: 'string', required: false, default: '' },
      actor: { type: 'string', required: false, default: '' },
      reason: { type: 'string', required: false, default: '' },
    },
    verdictFrom: 'plan',
    read: compute({ reads: ['input.action'], fn: () => readRuntime() }),
    plan: compute({
      reads: ['findings.read', 'input.action', 'input.key', 'input.value', 'input.actor', 'input.reason'],
      fn: (view) => {
        const { path, entries, warnings } = view.findings.read;
        const r = planRuntimeSetting({ ...view.input, now: now(), entries, path });
        return { ...r, warnings };
      },
    }),
    write: effectStep({
      reads: ['verdict'],
      effects: (view) => (view.verdict.ok && view.verdict.next ? [{
        type: RUNTIME_SETTING_WRITE_EFFECT, idempotent: true,
        payload: { path: view.verdict.path, next: view.verdict.next, audit: view.verdict.audit, expected: view.verdict.expected },
      }] : []),
    }),
  });
}

/** CLI result: a refused plan exits 1 with its reason. */
export function finishRuntimeSetting({ run, code, lines }) {
  const v = run?.verdict;
  if (v && v.ok === false) return { code: code || 1, lines: [...(lines ?? []), `runtime-setting: refused — ${v.error}`] };
  return { code, lines };
}
