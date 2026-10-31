// Discovery only: createVitest initializes the config/workspace but never runs
// tests. Resolve from cwd so fixtures and lanes use their own installed Vitest.
import {createRequire} from 'node:module';
import {resolve, isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

let ctx;
try {
  const {options, filters} = JSON.parse(process.argv[2]);
  // startVitest's CLI prelude precedes config loading; createVitest alone does
  // not set these. Preserve an explicit NODE_ENV just as the CLI does.
  process.env.TEST = 'true';
  process.env.VITEST = 'true';
  process.env.NODE_ENV ??= 'test';
  const require = createRequire(resolve(process.cwd(), 'package.json'));
  const {createVitest} = await import(pathToFileURL(require.resolve('vitest/node')).href);
  ctx = await createVitest('test', {...options, watch:false, run:true});
  const discovered = await ctx.globTestFiles(filters);
  // Vitest 1.6 returns [project, file]; other versions return file strings.
  const files = discovered.map(spec => Array.isArray(spec) ? spec[1] : spec);
  if (files.some(file => typeof file !== 'string' || !isAbsolute(file))) throw new Error('Invalid Vitest discovery');
  await ctx.close();
  ctx = undefined;
  process.stdout.write(JSON.stringify(files));
} catch (error) {
  process.stderr.write(`Vitest discovery failed: ${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
} finally {
  await ctx?.close();
}
