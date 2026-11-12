#!/usr/bin/env node
/** #2866 PreToolUse(Edit|Write): inspect the proposed content before it reaches disk. */
import { hookRoot } from './lib/hook-root.mjs';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { scanInvisibleCharacters } from './check-standards-rules.mjs';

const root = hookRoot(import.meta.url);
try {
  const event = JSON.parse(readFileSync(0, 'utf8'));
  const input = event.tool_input ?? {};
  if (typeof input.file_path === 'string' && ['Edit', 'Write'].includes(event.tool_name)) {
    const target = resolve(event.cwd ?? root, input.file_path);
    const file = relative(root, target).split('\\').join('/');
    if (/^(scripts|docs)\//.test(file)) {
      let content;
      if (event.tool_name === 'Write') content = input.content;
      else {
        const before = readFileSync(target, 'utf8');
        if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') {
          throw new Error('Edit requires old_string and new_string');
        }
        // Callback replacement keeps literal $&, $`, and $' text intact, just like the Edit tool.
        content = input.replace_all
          ? before.split(input.old_string).join(input.new_string)
          : before.replace(input.old_string, () => input.new_string);
        if (!before.includes(input.old_string)) content = input.new_string;
      }
      if (typeof content !== 'string') throw new Error('Write requires string content');
      const findings = scanInvisibleCharacters([{ file, content }]);
      for (const finding of findings) process.stderr.write(`${finding.message}\n`);
      if (findings.length) process.exitCode = 2;
    }
  }
} catch (error) {
  process.stderr.write(`invisible-characters: cannot inspect proposed write: ${error.message}\n`);
  process.exitCode = 2;
}
