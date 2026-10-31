import { expect, it } from 'vitest';
import { archiveSmokeProbe } from '../../conveyor/soak/breaks/archive-source-smoke-fallback.mjs';

it.each(['off', 'shadow'])('refuses plain main losing a deleted retired lower in %s mode', async mode => {
  const result = await archiveSmokeProbe({ mode });
  expect(result.lowerDeleted).toBe(true);
  expect(result.adopted).toBe(false);
  expect(result.headUnchanged).toBe(true);
  expect(result.refs).toEqual(['top']);
  expect(result.ready).toBe(false);
  expect(result.alerts).toContainEqual(expect.objectContaining({ kind: 'overlay-source-unavailable',
    detail: expect.objectContaining({ failed: 'archive-source-uncovered: top' }) }));
});

it('refuses attributed set-aside too, checking the excluded carrier', async () => {
  const result = await archiveSmokeProbe({ attributed: true });
  expect(result.adopted).toBe(false);
  expect(result.refs).toEqual(['top', 'healthy']);
  expect(result.alerts).toContainEqual(expect.objectContaining({ kind: 'overlay-set-aside-failed',
    detail: expect.objectContaining({ failed: 'archive-source-uncovered: top' }) }));
});

it('checks nested archives even when main carries the outer source', async () => {
  const result = await archiveSmokeProbe({ nested: true });
  expect(result.adopted).toBe(false);
  expect(result.lowerCarried).toBe(true);
  expect(result.refs).toEqual(['top']);
  expect(result.alerts).toContainEqual(expect.objectContaining({ kind: 'overlay-source-unavailable' }));
});

it('does not record an unsafe fallback for later ready-only adoption', async () => {
  const result = await archiveSmokeProbe({ readyOnly: true });
  expect(result.ready).toBe(false);
  expect(result.headUnchanged).toBe(true);
  expect(result.refs).toEqual(['top']);
});

it.each([true, 'tree'])('still adopts when main carries the archive (%s)', async carried => {
  const result = await archiveSmokeProbe({ carried });
  expect(result.adopted).toBe(true);
  expect(result.reason).toBe('fallback-plain-main');
  expect(result.lowerCarried).toBe(true);
  expect(result.refs).not.toContain('top');
});

it('still adopts attributed set-aside when its candidate carries the archive', async () => {
  const result = await archiveSmokeProbe({ carried: true, attributed: true });
  expect(result.adopted).toBe(true);
  expect(result.reason).toBe('overlay-set-aside');
  expect(result.lowerCarried).toBe(true);
  expect(result.refs).toContain('healthy');
  expect(result.refs).not.toContain('top');
});

it('holds without a ready candidate when archive evidence cannot be read', async () => {
  const result = await archiveSmokeProbe({ unavailable: true });
  expect(result.adopted).toBe(false);
  expect(result.ready).toBe(false);
  expect(result.refs).toEqual(['top']);
  expect(result.alerts).toContainEqual(expect.objectContaining({ kind: 'overlay-source-unavailable' }));
});
