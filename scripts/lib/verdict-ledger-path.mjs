/**
 * @file scripts/lib/verdict-ledger-path.mjs
 * @description Where one repo's verdict ledger lives on the transport branch. A LEAF module (no imports), shared by the
 *   io-shell (`verdict-ledger-io.mjs`, which re-exports it) and the outbox (`verdict-ledger-outbox.mjs`), so the
 *   outbox never imports the io-shell back: that circular import hung vitest's module runner (live 2026-10-21).
 */
export const LEDGER_DIR = 'verdict-ledger';

/** Repo-relative path of one repo's ledger on the transport branch. Same slug rule as `verdictLedgerPath`. */
export function ledgerGitPath(repo) {
  const slug = String(repo ?? '').trim().replace(/[/\\\s\x00-\x1f]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  return `${LEDGER_DIR}/${slug}.jsonl`;
}
