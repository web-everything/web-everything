import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractAnchors } from './rules-loader.cjs';

/** Pure: returns { text, warnings } in code-unit filename order, preserving duplicate text. */
export function joinTestingNotes(fragments) {
  if (!fragments.length) throw new Error('No testing notes fragments; restore docs/agent/testing.d/ before joining.');
  const anchors = new Map();
  const warnings = [];
  const ordered = [...fragments].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const text = ordered.map(({ name, text }) => {
    if (typeof text !== 'string' || !/^## .+\n/.test(text)) {
      throw new Error(`${name}: expected leading ## heading; repair the fragment before joining.`);
    }
    const { anchors: exposed, headings } = extractAnchors(text);
    const headingAnchors = headings.map(({ anchor }) => anchor);
    // Keep repeated headings; the exposed-anchor Set also covers non-heading IDs.
    for (const anchor of [...headingAnchors, ...[...exposed].filter((id) => !headingAnchors.includes(id))]) {
      if (anchors.has(anchor)) warnings.push(`Duplicate anchor ${anchor}: ${anchors.get(anchor)} and ${name}; give headings distinct anchors.`);
      anchors.set(anchor, name);
    }
    return text.replace(/\n+$/, '');
  }).join('\n\n') + '\n';
  return { text, warnings };
}

/** Only immediate Markdown files participate; invalid or unreadable evidence throws. */
export function readTestingNotes(root) {
  const directory = resolve(root, 'docs/agent/testing.d');
  return joinTestingNotes(readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map(({ name }) => ({ name, text: readFileSync(resolve(directory, name), 'utf8') })));
}
