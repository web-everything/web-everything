// CI's FrontierUI checkout must not spend a person's API budget. Every frontier-ui/frontierui checkout
// prefers a GitHub App installation token and uses the personal token (FUI_READ_TOKEN) only as fallback.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = ['ci.yml', 'deploy.yml', 'update-visual-baselines.yml'];

// Split a workflow into "- name:" steps (text based, no YAML dependency).
function steps(text) {
  return text.split(/^(?=\s+- (?:name|uses):)/m);
}

describe('FUI sibling checkout uses a GitHub App token', () => {
  let total = 0;
  for (const f of files) {
    const text = readFileSync(join(here, '..', '..', '.github', 'workflows', f), 'utf8');
    const all = steps(text);
    const checkouts = all.filter((s) => /repository:\s*frontier-ui\/frontierui/.test(s));
    total += checkouts.length;

    it(`${f}: has at least one FUI checkout`, () => {
      expect(checkouts.length).toBeGreaterThan(0);
    });

    it(`${f}: every FUI checkout prefers the app token, PAT only as fallback`, () => {
      for (const s of checkouts) {
        expect(s).toMatch(/token:\s*\$\{\{\s*steps\.fui-app-token\.outputs\.token\s*\|\|\s*secrets\.FUI_READ_TOKEN\s*\}\}/);
      }
    });

    it(`${f}: each FUI checkout is preceded by a guarded, least-privilege app-token step`, () => {
      const mints = all.filter((s) => /uses:\s*actions\/create-github-app-token@/.test(s));
      expect(mints.length).toBe(checkouts.length);
      for (const m of mints) {
        expect(m).toMatch(/id:\s*fui-app-token/);
        expect(m).toMatch(/if:\s*vars\.WE_APP_ID != ''/);
        expect(m).toMatch(/app-id:\s*\$\{\{\s*vars\.WE_APP_ID\s*\}\}/);
        expect(m).toMatch(/private-key:\s*\$\{\{\s*secrets\.WE_APP_PRIVATE_KEY\s*\}\}/);
        expect(m).toMatch(/owner:\s*frontier-ui/);
        expect(m).toMatch(/repositories:\s*frontierui\s*$/m);
        expect(m).toMatch(/permission-contents:\s*read/);
      }
      for (const c of checkouts) {
        const i = all.indexOf(c);
        expect(all[i - 1]).toMatch(/create-github-app-token/);
      }
    });
  }

  it('covers all 7 checkouts', () => {
    expect(total).toBe(7);
  });
});
