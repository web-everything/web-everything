// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

// Contract for the manual CI self-test (batch-5 item 4): ci-self.yml calls the dispatched branch's own
// ci.yml so a workflow edit can be proven before it merges. Parses YAML, never greps substrings.
const dir = new URL('../../../.github/workflows/', import.meta.url);
const load = (f) => yaml.load(readFileSync(new URL(f, dir), 'utf8'));
const REQUIRED = ['test', 'smoke', 'daemon-soak'];
const triggers = (doc) => {
  const on = doc.on ?? doc[true];
  return typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
};

describe('ci-self.yml', () => {
  it('exists', () => {
    expect(existsSync(new URL('ci-self.yml', dir))).toBe(true);
  });

  it('triggers only on manual dispatch', () => {
    expect(triggers(load('ci-self.yml'))).toEqual(['workflow_dispatch']);
  });

  it('has exactly one job, calling the local ci.yml', () => {
    const { jobs } = load('ci-self.yml');
    expect(Object.keys(jobs)).toEqual(['self']);
    expect(jobs.self.uses).toBe('./.github/workflows/ci.yml');
    expect(jobs.self.steps).toBeUndefined();
  });

  it('never shadows a required check name (job id or display name)', () => {
    const { jobs } = load('ci-self.yml');
    for (const [id, job] of Object.entries(jobs)) {
      expect(REQUIRED).not.toContain(id);
      expect(REQUIRED).not.toContain(job.name);
    }
  });

  it('grants read permissions, passes only the two named secrets (never inherit), and is unconditional', () => {
    const doc = load('ci-self.yml');
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(doc.jobs.self.secrets).toEqual({
      WE_APP_PRIVATE_KEY: '${{ secrets.WE_APP_PRIVATE_KEY }}',
      FUI_READ_TOKEN: '${{ secrets.FUI_READ_TOKEN }}',
    });
    expect(doc.jobs.self.if).toBeUndefined();
    expect(doc.jobs.self['continue-on-error']).toBeUndefined();
    expect(doc.concurrency).toBeUndefined();
  });

  it('ci.yml declares exactly those secrets as optional workflow_call secrets', () => {
    const wc = load('ci.yml').on.workflow_call;
    expect(Object.keys(wc.secrets).sort()).toEqual(['FUI_READ_TOKEN', 'WE_APP_PRIVATE_KEY']);
  });
});

describe('ci.yml triggers', () => {
  it('keeps push, pull_request, merge_group, workflow_dispatch and adds workflow_call', () => {
    const t = triggers(load('ci.yml'));
    for (const k of ['push', 'pull_request', 'merge_group', 'workflow_dispatch', 'workflow_call']) {
      expect(t).toContain(k);
    }
  });

  it('still defines the required check jobs under their own names', () => {
    const { jobs } = load('ci.yml');
    for (const name of REQUIRED) expect(jobs[name]).toBeDefined();
  });

  it('keeps push/pull_request branch filters (no restrictive paths filters)', () => {
    const on = load('ci.yml').on;
    expect(on.push.branches).toEqual(['main']);
    expect(on.pull_request.branches).toContain('main');
    for (const k of ['push', 'pull_request']) {
      expect(on[k]['paths']).toBeUndefined();
      expect(on[k]['paths-ignore']).toBeUndefined();
    }
  });
});
