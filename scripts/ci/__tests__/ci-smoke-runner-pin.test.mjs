// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const raw = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const { jobs } = yaml.load(raw);

// 2026-11-01: `ubuntu-latest` moved to Ubuntu 26.04; Playwright 1.58.1 refuses `playwright install --with-deps`
// there, and the runner's apt mirror DNS flake ejected merge-queue batches. Playwright jobs therefore run in
// the version-locked Playwright container (no apt at run time) and must never reinstall browsers with apt deps.
const lock = JSON.parse(readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
const pwVersion = lock.packages['node_modules/@playwright/test'].version;
const IMAGE_RE = /^mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-jammy$/;
const containerJobs = Object.entries(jobs).filter(([, job]) =>
  IMAGE_RE.test(typeof job.container === 'string' ? job.container : (job.container?.image ?? '')));
const imageOf = (job) => (typeof job.container === 'string' ? job.container : job.container.image);

describe('ci.yml jobs that run Playwright', () => {
  it('smoke runs in the pinned Playwright container', () => {
    expect(containerJobs.map(([name]) => name)).toContain('smoke');
  });

  it.each(containerJobs.map(([name, job]) => [name, imageOf(job)]))(
    '%s container image tag equals the resolved @playwright/test version',
    (_name, image) => {
      expect(image.match(IMAGE_RE)[1]).toBe(pwVersion);
    });

  it('no job runs `playwright install --with-deps` (apt) any more', () => {
    const withDeps = Object.entries(jobs).filter(([, job]) =>
      (job.steps ?? []).some((s) => /playwright install\b.*--with-deps/.test(s.run ?? '')));
    expect(withDeps.map(([name]) => name)).toEqual([]);
  });

  it.each(containerJobs.map(([name, job]) => [name, job.steps ?? []]))(
    '%s has no apt-based browser install step', (_name, steps) => {
      for (const s of steps) {
        expect(s.run ?? '', `${s.name}: apt install`).not.toMatch(/\bapt(-get)?\s+install\b/);
        expect(s.name ?? '').not.toBe('Install Playwright chromium');
      }
    });
});
