// Preload only in CLI boundary tests: exercise the direct CLI on every host,
// including Forge hosts with a real worker pool, without invoking host sudo.
import fs from 'node:fs/promises';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

fs.readdir = async path => {
  if (path === '/srv/forge-exec') return [];
  throw new Error('Unexpected CLI directory read: ' + path);
};
cp.spawn = () => { throw new Error('Unexpected CLI subprocess'); };
syncBuiltinESMExports();
