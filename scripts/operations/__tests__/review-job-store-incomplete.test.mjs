// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async original => {
  const fs = await original();
  return { ...fs, readdirSync: vi.fn(fs.readdirSync), readFileSync: vi.fn(fs.readFileSync) };
});
import { readdirSync, readFileSync } from 'node:fs';
import { listReviewJobAgents, listAgentsWithReviewJobs } from '../review-job-store.mjs';

afterEach(() => vi.clearAllMocks());
it.each(['EACCES', 'EIO', 'ENOTDIR'])('directory %s cannot look like an empty worker population', code => {
  readdirSync.mockImplementationOnce(() => { throw Object.assign(new Error('unreadable'), { code }); });
  expect(listReviewJobAgents({ dir: 'fixture' }).incomplete).toEqual(['review-jobs-unreadable']);
});
it('a missing job directory remains a complete empty population', () => {
  readdirSync.mockImplementationOnce(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
  expect(listReviewJobAgents({ dir: 'fixture' })).not.toHaveProperty('incomplete');
});
it.each(['unreadable', 'malformed', 'invalid-pid', 'invalid-slug', 'unknown-liveness'])('a %s record marks the listing incomplete', shape => {
  readdirSync.mockReturnValueOnce(['review-7.json']);
  readFileSync.mockImplementationOnce(() => {
    if (shape === 'unreadable') throw new Error('denied');
    return shape === 'malformed' ? '{' : JSON.stringify({ slug: shape === 'invalid-slug' ? 'review-8' : 'review-7',
      pid: shape === 'invalid-pid' ? -1 : 123 });
  });
  const rows = listReviewJobAgents({ dir: 'fixture', isAlive: () => shape === 'unknown-liveness' ? undefined : true, readOnly: true });
  expect(rows.incomplete).toHaveLength(1);
});
it.each(['throws', 'null', 'object'])('a job reader that %s stays incomplete after merge', shape => {
  const rows = listAgentsWithReviewJobs({ listAgents: () => [], listWrapped: () => [], listJobs: () => {
    if (shape === 'throws') throw new Error('unreadable');
    return shape === 'null' ? null : {};
  } });
  expect(rows.incomplete).toEqual(['review-jobs-unreadable']);
});
it('merging preserves incomplete evidence from every population', () => {
  const listing = reason => Object.defineProperty([], 'incomplete', { value: [reason] });
  expect(listAgentsWithReviewJobs({ listAgents: () => listing('agents'), listJobs: () => listing('jobs'),
    listWrapped: () => listing('wrapped') }).incomplete).toEqual(['agents', 'jobs', 'wrapped']);
});

it('the diagnostics subdirectory is not a live-job record or incomplete listing', () => {
  readdirSync.mockReturnValueOnce(['diagnostics']);
  const rows = listReviewJobAgents({ dir: 'fixture' });
  expect(rows).toEqual([]);
  expect(rows).not.toHaveProperty('incomplete');
});
