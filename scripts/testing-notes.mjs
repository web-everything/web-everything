import { fileURLToPath } from 'node:url';
import { readTestingNotes } from './lib/testing-notes-join.mjs';

try {
  const { text, warnings } = readTestingNotes(fileURLToPath(new URL('../', import.meta.url)));
  for (const warning of warnings) console.error(`Testing notes: ${warning}`);
  process.stdout.write(text);
} catch (error) {
  console.error(`Testing notes: ${error.message}`);
  process.exitCode = 1;
}
