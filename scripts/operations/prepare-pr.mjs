/**
 * Prepare PR invariants shared by the planner and its pre-publication IO guard.
 * Keyed on the distinct `-prepare-item-` token, NOT the shared `-prepare-` prefix: prepare-decision
 * (`lane/<n>-prepare-<slug>`, legitimately touches researchTopics/research-descriptions) and prepare-stamp
 * (`lane/<n>-prepare-stamp`) share that prefix and must keep their own title and diff.
 */
import { retryTransientGit } from '../lib/git-fetch-retry.mjs';
import { machinePrTitle } from './machine-pr-title.mjs';
export function prepareItemFromRef(ref) {
  return /^lane\/([a-z0-9]+)-prepare-item-/.exec(ref ?? '')?.[1] ?? null;
}

export function preparePrTitle(item, card) {
  return machinePrTitle({ item, kind: 'prepare', card });
}

/** git is injected for tests; every failed observation refuses publication. */
export function verifyPreparePr({ item, source, base, git }) {
  if (base !== 'main') throw new Error('prepare PR requires base main');
  retryTransientGit(() => git(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']));
  const sha = git(['rev-parse', '--verify', `${source}^{commit}`]).trim();
  const cards = git(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'backlog/'])
    .trim().split('\n').filter((path) => path.startsWith(`backlog/${item}-`) && path.endsWith('.md'));
  if (cards.length !== 1) throw new Error(`prepare PR requires exactly one card for #${item} on origin/main`);
  const range = `origin/main...${sha}`;
  const files = git(['diff', '--name-only', '--no-renames', '-z', range, '--']).split('\0').filter(Boolean);
  const outside = files.filter((path) => path !== cards[0]);
  if (outside.length) throw new Error(`prepare PR refused: diff outside ${cards[0]}: ${outside.join(', ')}`);
  if (git(['rev-list', '--merges', `origin/main..${sha}`]).trim()) {
    throw new Error('prepare PR refused: lane contains merge commits; start fresh from origin/main and never merge another lane');
  }
  return sha;
}
