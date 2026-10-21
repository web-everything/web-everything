/**
 * @file scripts/operations/related-items-io.mjs
 * @description THE IO SHELL of the read-only `related-items` operation (and of `file-item`'s related-card check):
 *   reads every `<root>/backlog/*.md` card, the policy cascade's layers (platform preference, the repo's
 *   `we:scripts/settings/related-items.json` through `readSettings`, env) and today's date. All ranking is the pure
 *   `we:scripts/lib/related-items-core.mjs`.
 *
 * Never throws: an unreadable card is skipped (and counted), an unreadable backlog dir is zero cards.
 *
 * IMPURE by construction: `fs`, `process.env`, the clock.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSettings, SETTINGS_DIR } from '../lib/settings-files.mjs';
import { localDateString } from '../lib/local-date.mjs';
import { relatedCardFromText, resolveRelatedItemsPolicy } from '../lib/related-items-core.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = (path, read) => { try { return JSON.parse(read(path, 'utf8')); } catch { return null; } };

/** Read the cascade's layers and resolve them. A missing file is no preference, never an error. */
export function loadRelatedItemsPolicy({ root = REPO_ROOT, env = process.env, read = readFileSync, settingsDir } = {}) {
  const platform = readJson(join(root, 'scripts', 'lib', 'delivery-platform-preferences.json'), read)?.relatedItems ?? null;
  const dir = settingsDir ?? (root === REPO_ROOT ? SETTINGS_DIR : join(root, 'scripts', 'settings'));
  const repo = readSettings({ dir, legacyPath: null })?.relatedItems ?? null;
  return resolveRelatedItemsPolicy({ platform, repo, env });
}

/** Every card in `<backlogDir>` as {@link relatedCardFromText} rows, plus the count of unreadable files. */
export function readRelatedCards(backlogDir, { list = readdirSync, read = readFileSync } = {}) {
  let names;
  try { names = list(backlogDir); } catch { return { cards: [], unreadable: 0 }; }
  const cards = [];
  let unreadable = 0;
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    try { cards.push(relatedCardFromText({ rel: `backlog/${name}`, text: read(join(backlogDir, name), 'utf8') })); } catch { unreadable += 1; }
  }
  return { cards, unreadable };
}

/** The reader both operations inject: `() => ({cards, unreadable, policy, today})`. */
export function createRelatedItemsReader({ root = REPO_ROOT, backlogDir, env = process.env,
  today = () => localDateString(new Date(), 'America/New_York') } = {}) {
  return () => ({
    ...readRelatedCards(backlogDir ?? join(root, 'backlog')),
    policy: loadRelatedItemsPolicy({ root, env }),
    today: today(),
  });
}
