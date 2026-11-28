// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// Consumer fixtures must not load the review-seat runtime to construct a comment.
// Loading it pulled hundreds of unrelated modules into each isolated test worker.
vi.mock('../../operations/review-extra-seats.mjs', () => {
  throw Error('accepted-never-started fixture loaded the review-seat runtime');
});

describe('accepted-never-started fixture imports', () => {
  it('constructs the default chain without loading the review-seat runtime', async () => {
    const { A, B, C, chain } = await import('./fixtures/accepted-never-started.mjs');
    const comments = chain();
    expect(comments).toHaveLength(3);
    expect(comments[0].body).toContain(`reviewed-sha: ${A}`);
    expect(comments[1].body).toContain(`from=${A} to=${B}`);
    expect(comments[2].body).toContain(`from=${B} to=${C}`);
  });

  it('requires the real producer for a findings-bearing envelope', async () => {
    const { envelope } = await import('./fixtures/accepted-never-started.mjs');
    expect(() => envelope(undefined, undefined, undefined, { findings: [{}] }))
      .toThrow('findings fixtures require the real advisory producer');
  });
});
