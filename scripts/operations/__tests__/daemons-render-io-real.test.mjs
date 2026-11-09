/** Real filesystem fidelity for daemons-render-io: a real render into a real directory tree. */
import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withRealRepo } from './helpers/real-repo.mjs';
import { main } from '../daemons-render-io.mjs';

it('renders every plist into a real directory with no absolute user path', async () => {
  await withRealRepo(async ctx => {
    const out = join(ctx.root, 'rendered');
    const lines = [];
    main([`--out=${out}`, '--host-home=/home/studio', '--node=/opt/node/bin/node'], { log: l => lines.push(l) });
    const files = readdirSync(out).filter(f => f.endsWith('.plist'));
    expect(files.length).toBe(23);
    for (const f of files) {
      const xml = readFileSync(join(out, f), 'utf8');
      expect(xml).not.toContain('/Users/');
      expect(xml).toContain('/home/studio');
    }
  });
});
