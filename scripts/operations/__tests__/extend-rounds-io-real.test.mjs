/** Exercise the real subprocess/JSON boundary; only GitHub is replaced by a local executable. */
import { it, expect } from 'vitest';
import { writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { withRealRepo } from './helpers/real-repo.mjs';
import { createExtendRoundsReader } from '../extend-rounds-io.mjs';
import { AUTOMATION_LOGINS, OPERATOR_LOGINS } from '../../lib/marker-authorship.mjs';

it('reads, posts verbatim words through gh argv, and verifies the persisted thread', async () => {
  expect(typeof createExtendRoundsReader).toBe('function');
  await withRealRepo(async ({ root }) => {
    const thread = join(root, 'thread.json');
    const fakeGh = join(root, 'gh');
    writeFileSync(thread, JSON.stringify({ state: 'OPEN', comments: [] }));
    writeFileSync(fakeGh, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'pr' || args[2] !== '12' || args[args.indexOf('--repo') + 1] !== 'web-everything/web-everything') process.exit(2);
const path = ${JSON.stringify(thread)};
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
if (args[1] === 'view') process.stdout.write(JSON.stringify(data));
else if (args[1] === 'comment') {
  data.comments.push({ body: args[args.indexOf('--body') + 1], author: { login: ${JSON.stringify(AUTOMATION_LOGINS[0])} } });
  fs.writeFileSync(path, JSON.stringify(data));
} else process.exit(3);
`);
    chmodSync(fakeGh, 0o755);
    const io = pathToFileURL(resolve('scripts/operations/extend-rounds-io.mjs')).href;
    const op = pathToFileURL(resolve('scripts/operations/extend-rounds.mjs')).href;
    const reason = 'Try "two" more.\nKeep $HOME and `words` verbatim.';
    const script = `
      import { createExtendRoundsReader, createExtendRoundsSinks } from ${JSON.stringify(io)};
      import { planRoundExtension, ROUND_EXTENSION_POST_EFFECT, extendRoundsOperation } from ${JSON.stringify(op)};
      const input = ${JSON.stringify({ repo: 'web-everything/web-everything', pr: 12, by: 2, actor: OPERATOR_LOGINS[0], channel: 'test', reason })};
      const reader = createExtendRoundsReader();
      const verdict = planRoundExtension(reader(input), input);
      const write = extendRoundsOperation({ readExtensionContext: reader }).steps.find(s => s.name === 'write').step;
      if (write.effects({ verdict, input: { preview: true } }).length) throw new Error('preview emitted a write');
      console.log(JSON.stringify(await createExtendRoundsSinks()[ROUND_EXTENSION_POST_EFFECT](verdict)));
    `;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, PATH: root + ':' + process.env.PATH,
        WE_GH_THROTTLE_GH_BIN: fakeGh, WE_GH_THROTTLE_LOCK_ROOT: join(root, 'locks'),
        WE_GH_THROTTLE_COST_HEADERS: '0', WE_GH_THROTTLE_PERSONAL_ROUTE: '0' },
    });
    expect(JSON.parse(stdout)).toMatchObject({ granted: 2, total: 2 });
    const comments = JSON.parse(readFileSync(thread, 'utf8')).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('> Try "two" more.');
  });
});
