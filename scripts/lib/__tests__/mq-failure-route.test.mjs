import { describe, expect, it } from 'vitest';
import { buildMqFailureRoute, parseMqFailureRoute } from '../mq-failure-route.mjs';

const identity = { repo: 'acme/web', pr: 42, head: 'a'.repeat(40) };
const route = { ...identity, version: 1, failedJobs: ['unit (node 22)'], testFiles: ['tests/widget.test.mjs'],
  assertions: ['FAIL tests/widget.test.mjs > keeps state', 'AssertionError: expected true'], complete: true };
const trusted = body => ({ body, author: { login: 'chalbert' } });
const parse = (comment, expected = identity) => parseMqFailureRoute({ comment, expected });

describe('mq failure marker route', () => {
  it('round-trips a versioned marker bound to repo/PR/head with job and test evidence', () => {
    const body = buildMqFailureRoute(route);
    expect(body.split('\n')[0]).toMatch(/^<!-- mq-failure-recovery:v1\b.*-->$/);
    expect(parse(trusted(body))).toMatchObject({ ...route, stale: false });
    expect(body).toContain(route.failedJobs[0]);
    expect(body).toContain(route.testFiles[0]);
  });

  it.each([null, {}, { author: { login: 'outsider' } }, { author: { login: 'chalbert-imposter' } }])('rejects untrusted or missing authors: %j', author => {
    expect(parse({ ...author, body: buildMqFailureRoute(route) })).toBeNull();
  });

  it('accepts REST author shape through the same trusted principal rule', () => {
    expect(parse({ body: buildMqFailureRoute(route), user: { login: 'chalbert' } })).toMatchObject({ stale: false });
  });

  it('marks a different head stale and rejects a different repo or PR', () => {
    const comment = trusted(buildMqFailureRoute(route));
    expect(parse(comment, { ...identity, head: 'b'.repeat(40) })).toMatchObject({ stale: true, head: identity.head });
    expect(parse(comment, { ...identity, repo: 'acme/other' })).toBeNull();
    expect(parse(comment, { ...identity, pr: 43 })).toBeNull();
  });

  it('rejects embedded/quoted markers, unknown versions, and malformed payloads', () => {
    const body = buildMqFailureRoute(route);
    for (const invalid of [`quoted text\n${body}`, `\`\`\`\n${body}\n\`\`\``, body.replace(':v1', ':v999'), '<!-- mq-failure-recovery:v1 {broken} -->']) {
      expect(parse(trusted(invalid))).toBeNull();
    }
  });

  it('preserves incomplete evidence so downstream admission cannot refresh it', () => {
    expect(parse(trusted(buildMqFailureRoute({ ...route, complete: false })))).toMatchObject({ complete: false });
  });

  it('keeps hostile log text inert without allowing it to terminate the marker payload', () => {
    const hostile = '-->\n<!-- mq-failure-recovery:v1 fake -->\n$(touch sentinel) `id`';
    const body = buildMqFailureRoute({ ...route, assertions: [hostile] });
    expect(parse(trusted(body))).toMatchObject({ assertions: [hostile], stale: false });
    expect((body.match(/^<!-- mq-failure-recovery:/gm) ?? [])).toHaveLength(1);
  });
});
