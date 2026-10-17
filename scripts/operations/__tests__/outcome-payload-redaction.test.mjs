// PR #5472 red team: a dispatch-lane receipt (`outcomePayload`) serves each effect's `error`/`handle` and the
// verdict over CLI --json and HTTP. Credentials whose value has no token shape (an "opaque" secret) must not
// survive that boundary, whatever form the error text carries them in.
import { describe, it, expect } from 'vitest';
import { outcomePayload } from '../cli-adapter.mjs';

const OPAQUE = 'opaqueCredValue9081';
const SHAPES = [
  ['shell assignment', `Command failed: GH_TOKEN=${OPAQUE} claude --bg`],
  ['exported assignment', `export ANTHROPIC_API_KEY=${OPAQUE}`],
  ['oauth env assignment', `CLAUDE_CODE_OAUTH_TOKEN=${OPAQUE} node x`],
  ['quoted --settings', `claude --bg --settings '{"env":{"WE_ROLE":"${OPAQUE}"}}' --model x`],
  ['--settings with a nested object first', `claude --bg --settings {"worktree":{"bgIsolation":"none"},"env":{"OPAQUE_NAME":"${OPAQUE}"}} --model x`],
  ['--settings with a value holding braces', `claude --bg --settings {"env":{"SNAP":"{\\"a\\":{}}","OTHER":"${OPAQUE}"}} --model x`],
  ['--settings=', `claude --settings={"env":{"X":"${OPAQUE}"}}`],
  ['bare env object, opaque key', `stdout: {"env":{"SOMETHING":"${OPAQUE}"}}`],
  ['lowercase JSON key', `{"anthropic_api_key":"${OPAQUE}"}`],
  ['JSON value with an escaped quote', `{"GH_TOKEN": "x\\"${OPAQUE}"}`],
  ['URL userinfo', `fetch https://user:${OPAQUE}@proxy.example/x failed`],
  ['auth header', `Authorization: Basic ${OPAQUE}`],
];

function receipt(text) {
  const run = { op: 'dispatch-lane', id: 'r', cursor: 1, pending: [], findings: [], status: 'failed',
    effects: [{ key: 'k', type: 'conveyor.dispatch-delivery-agent', status: 'failed', handle: text, error: text }],
    verdict: { dispatching: false, reason: text, why: text } };
  return JSON.stringify(outcomePayload({ run, stopped: 'failed', error: new Error(text) }));
}

describe('outcomePayload — dispatch-lane receipt redaction', () => {
  it.each(SHAPES)('never serves an opaque credential carried as %s', (_name, text) => {
    expect(receipt(text)).not.toContain(OPAQUE);
  });

  it('keeps the diagnostic text a reader needs', () => {
    const out = receipt('Workspace not trusted. Run `claude` in /x once; exit 1');
    expect(out).toContain('Workspace not trusted');
    expect(out).toContain('exit 1');
  });
});
