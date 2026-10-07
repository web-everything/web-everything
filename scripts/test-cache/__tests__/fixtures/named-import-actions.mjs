// Loaded by tracer.test.mjs AFTER installTracer(): uses NAMED imports on purpose (the case a plain `fs.x = wrapper` patch misses).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const touch = (dir, file) => { readFileSync(file, 'utf8'); readdirSync(dir); existsSync(`${file}.missing`); };
export const runNode = (script, cwd) => execFileSync(process.execPath, [script], { cwd, encoding: 'utf8' });
