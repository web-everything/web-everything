/** @file App-webhook intake: separate app secret binding, merge_group accepted, fail-closed, redelivery stored once. */
import { describe, it, expect } from 'vitest';
import { signBody, createEventLog, createMemoryStorage, handleRequest } from '../core.mjs';

const REPO = { full_name: 'web-everything/web-everything' };
const body = JSON.stringify({ action: 'checks_requested', repository: REPO, merge_group: { head_sha: 'a'.repeat(40), head_ref: 'refs/heads/gh-readonly-queue/main/pr-7-abc' } });
const send = async (env, secret, log, id = 'd1', event = 'merge_group') => handleRequest(new Request('https://x/github/webhook', { method: 'POST', body,
  headers: { 'x-github-event': event, 'x-github-delivery': id, ...(secret ? { 'x-hub-signature-256': await signBody(secret, body) } : {}) } }), env, { getLog: () => log });

describe('app webhook secret', () => {
  it('accepts a delivery signed with the app secret, and a merge_group event', async () => {
    const log = createEventLog(createMemoryStorage());
    const res = await send({ GITHUB_APP_WEBHOOK_SECRET: 'appsec' }, 'appsec', log);
    expect(res.status).toBe(202);
    expect(log.read(0).events[0]).toMatchObject({ type: 'merge_group', sha: 'a'.repeat(40), prs: [7] });
  });
  it('either binding verifies; a wrong secret is 401 and stores nothing; none configured is 503', async () => {
    const log = createEventLog(createMemoryStorage());
    const env = { GITHUB_WEBHOOK_SECRET: 'repo', GITHUB_APP_WEBHOOK_SECRET: 'appsec' };
    expect((await send(env, 'repo', log, 'a')).status).toBe(202);
    expect((await send(env, 'nope', log, 'b')).status).toBe(401);
    expect((await send(env, null, log, 'c')).status).toBe(401);
    expect(log.read(0).events).toHaveLength(1);
    expect((await send({}, 'x', log)).status).toBe(503);
  });
  it('redelivery is stored once', async () => {
    const log = createEventLog(createMemoryStorage());
    const env = { GITHUB_APP_WEBHOOK_SECRET: 'appsec' };
    await send(env, 'appsec', log, 'same');
    const again = await (await send(env, 'appsec', log, 'same')).json();
    expect(again.duplicate).toBe(true);
    expect(log.read(0).events).toHaveLength(1);
  });
});
