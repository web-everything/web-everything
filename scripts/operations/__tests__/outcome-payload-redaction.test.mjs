// PR #5472 red team: a dispatch-lane receipt (`outcomePayload`) serves each effect's `error`/`handle` and the
// verdict over CLI --json and HTTP. Credentials whose value has no token shape (an "opaque" secret) must not
// survive that boundary, whatever form the error text carries them in.
import { describe, it, expect } from 'vitest';
import { outcomePayload, renderOutcome } from '../cli-adapter.mjs';

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
  // Self-review variants of the same class.
  ['Authorization JSON key', `{"Authorization":"Basic ${OPAQUE}"}`],
  ['token as URL username', `https://${OPAQUE}@github.com/o/r`],
  ['space-separated flag', `claude --token ${OPAQUE} --verbose`],
  ['doubly JSON-encoded key', `\\\\\\"GH_TOKEN\\\\\\":\\\\\\"${OPAQUE}\\\\\\"`],
  ['env array', `"env":["GH_TOKEN=${OPAQUE}"]`],
  ['env name/value pair', `{"name":"GH_TOKEN","value":"${OPAQUE}"}`],
  ['backtick-quoted value', `GH_TOKEN=\`x ${OPAQUE}\``],
  ['concatenated shell quoting', `GH_TOKEN='it'\\''s ${OPAQUE}'`],
  // Round 4 red team: a later cookie in a multi-cookie header.
  ['multi-cookie header', `request failed; Cookie: theme=light; session=${OPAQUE}`],
  ['Set-Cookie header with attributes', `Set-Cookie: sid=${OPAQUE}; Path=/; HttpOnly`],
  ['credential header with a list value', `X-Auth-Token: a, ${OPAQUE}`],
  // Round 5 red team, and their siblings: a value that ends early at a length bound, a quote or a container.
  ['quoted cookie value past 256 characters', `Cookie: sid="${OPAQUE.padEnd(257, 'x')}"`],
  ['JSON-escaped quoted cookie value past 256 characters', JSON.stringify({ e: `Cookie: sid="${OPAQUE.padEnd(300, 'x')}"` })],
  ['Digest header with quoted parts', `Authorization: Digest username="bob", qop="auth,auth-int", response="${OPAQUE}"`],
  ['quoted cookie value holding a comma', `Cookie: sid="a,${OPAQUE}"`],
  ['credential-valued JSON array', `{"Authorization":["Basic ${OPAQUE}"]}`],
  ['credential-valued JSON object', `{"Authorization":{"basic":"${OPAQUE}"}}`],
  ['JSON-encoded credential-valued array', JSON.stringify({ e: `{"GH_TOKEN":["${OPAQUE}"]}` })],
  ['env name/value pair with an array value', `{"name":"GH_TOKEN","value":["${OPAQUE}"]}`],
  ['adjacent shell quotes', `GH_TOKEN=''"${OPAQUE}" node x`],
  ['bare then double-quoted shell parts', `GH_TOKEN=a"${OPAQUE}" node x`],
  ['two double-quoted shell parts', `GH_TOKEN="a""${OPAQUE}" node x`],
  ['locale-quoted shell value', `GH_TOKEN=$"${OPAQUE}" node x`],
  ['flag value with adjacent shell quotes', `claude --token ''"${OPAQUE}" x`],
  ['JSON-escaped shell double quotes', JSON.stringify({ e: `GH_TOKEN="${OPAQUE}" node` })],
  ['single-quoted header value', `headers: { authorization: 'Basic ${OPAQUE}' }`],
  ['cookie list past 4096 characters', `COOKIE=${'a'.repeat(4100)}${OPAQUE}`],
  ['URL userinfo past 256 characters', `https://${'S'.repeat(257)}${OPAQUE}@github.com/x`],
  ['curl -b far along its line', `curl ${'x'.repeat(300)} -b sid=${OPAQUE}`],
  ['single-quoted dict key', `{'GH_TOKEN': '${OPAQUE}'}`],
  ['header pair array', `[["Api-Key","${OPAQUE}"]]`],
];

const runOf = (text) => ({ op: 'dispatch-lane', id: 'r', cursor: 1, status: 'failed',
  pending: { step: 'dispatch', note: text }, findings: { read: { holdReason: text, inFlightRuns: [{ handle: text }] } },
  effects: [{ key: 'k', type: 'conveyor.dispatch-delivery-agent', status: 'failed', handle: text, error: text }],
  verdict: { dispatching: false, reason: text, why: text } });

function receipt(text) {
  return JSON.stringify(outcomePayload({ run: runOf(text), stopped: 'failed', error: new Error(text) }));
}

/** Every human (non --json) rendering of the same run that prints the error or a handle. */
function humanLines(text) {
  const run = runOf(text);
  const inFlight = { ...run, effects: [{ ...run.effects[0], status: 'in-flight', handle: `pid:1 ${text}` }] };
  return [
    renderOutcome({ outcome: { run, stopped: 'effect-halted', error: new Error(text), applied: [] } }),
    renderOutcome({ outcome: { run, stopped: 'step-refused', step: 'read', error: new Error(text), applied: [] } }),
    renderOutcome({ outcome: { run: inFlight, stopped: 'effect-in-flight', applied: [] } }),
  ].flatMap((r) => r.lines).join('\n');
}

describe('outcomePayload — dispatch-lane receipt redaction', () => {
  it.each(SHAPES)('never serves an opaque credential carried as %s', (_name, text) => {
    expect(receipt(text)).not.toContain(OPAQUE);
  });

  it.each(SHAPES)('never prints an opaque credential carried as %s in the human output', (_name, text) => {
    expect(humanLines(text)).not.toContain(OPAQUE);
  });

  it('keeps effect keys and telemetry-named fields intact', () => {
    const out = JSON.parse(receipt('{"key":"dispatch:3794","input_tokens":55}'));
    expect(out.effects[0].key).toBe('k');
    expect(out.verdict.reason).toBe('{"key":"dispatch:3794","input_tokens":55}');
  });

  it('keeps the diagnostic text a reader needs', () => {
    const out = receipt('Workspace not trusted. Run `claude` in /x once; exit 1');
    expect(out).toContain('Workspace not trusted');
    expect(out).toContain('exit 1');
  });
});
