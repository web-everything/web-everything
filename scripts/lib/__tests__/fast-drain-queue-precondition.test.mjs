import { describe, it, expect } from 'vitest';
import { validateFastDrainQueuePrecondition } from '../fast-drain-context.mjs';

const contexts = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'];
const workflows = ['ci.yml', 'soak-replay-gate.yml', 'merge-gate.yml'];
const rules = () => [
  { type: 'merge_queue', parameters: {} },
  { type: 'required_status_checks', parameters: { required_status_checks: contexts.map(context => ({ context, integration_id: 15368 })) } },
  { type: 'workflows', parameters: { workflows: workflows.map(name => ({ path: `.github/workflows/${name}`, ref: 'refs/heads/main', repository_id: 1142650361 })) } },
];
function probe(pages = [rules()], repoId = 1142650361, throws = false) {
  const calls = [];
  const result = validateFastDrainQueuePrecondition({ repo: 'o/r', defaultBranch: 'main', exec: (cmd, args) => {
    calls.push([cmd, args]);
    if (throws) throw new Error('HTTP 500');
    return JSON.stringify(args.includes('--slurp') ? pages : { id: repoId });
  } });
  expect(calls.every(([cmd, args]) => cmd === 'gh' && args[0] === 'api' && !args.includes('--method'))).toBe(true);
  return { result, calls };
}
const closed = pages => expect(probe(pages).result).toMatchObject({ ok: false, kind: 'defer-to-pass:queue-precondition' });
describe('fast-drain queue precondition', () => {
  it('live 2026-11-25 rules shape admits', () => {
    const { result, calls } = probe();
    expect(result.ok).toBe(true);
    expect(calls[0][1]).toEqual(['api', '--paginate', '--slurp', 'repos/o/r/rules/branches/main?per_page=100']);
  });
  it('single and multi page fixtures admit', () => {
    expect(probe([rules()]).result.ok).toBe(true);
    expect(probe([rules().slice(0, 1), rules().slice(1)]).result.ok).toBe(true);
  });
  it('no merge_queue', () => closed([rules().slice(1)]));
  it.each(contexts)('each of the 5 contexts missing: %s', context => {
    const rows = rules();
    rows[1].parameters.required_status_checks = rows[1].parameters.required_status_checks.filter(r => r.context !== context);
    closed([rows]);
  });
  it('context with integration 99', () => {
    const rows = rules(); rows[1].parameters.required_status_checks[0].integration_id = 99; closed([rows]);
  });
  it('duplicate contexts with mixed integration ids', () => {
    const rows = rules(); rows.push({ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test', integration_id: 99 }] } });
    closed([rows]);
  });
  it.each(['path', 'ref', 'repository_id'])('workflow wrong path, wrong ref, or wrong repository_id: %s', field => {
    const rows = rules(); rows[2].parameters.workflows[0][field] = 'wrong'; closed([rows]);
  });
  it.each([null, {}, [null], [rules(), {}], [[{ type: 7 }]], [[{ type: 'required_status_checks' }]]])('non-array or truncated page: %j', pages => closed(pages));
  it('fetch throws', () => expect(probe(undefined, undefined, true).result).toMatchObject({ ok: false, kind: 'defer-to-pass:queue-precondition' }));
});
