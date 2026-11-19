// Process titles: a tiny shared helper so Activity Monitor / `ps` show which role each node process plays.
// Title only (process.title); NEVER touches argv. Never throws. macOS truncates long titles, so cap at ~32 chars.
// CAUTION before wiring a caller: process.title REPLACES the command text `ps` shows (verified on macOS), and several
// matchers read that text (liveReviewRoundBudget, runner-activity scriptToken, heavy-queue, verify-dispatch isDispatchedRun).
// Wire an entry point only after its matcher uses lease/pid identity instead of command text.
export const PROCESS_TITLE_MAX = 32;

export function formatProcessTitle(role, detail) {
  let r = '';
  try { r = typeof role === 'string' ? role.trim() : ''; } catch { r = ''; }
  let d = '';
  try {
    if (typeof detail === 'string') d = detail.trim();
    else if (typeof detail === 'number' && Number.isFinite(detail)) d = String(detail);
  } catch { d = ''; }
  const base = `we:${r || 'proc'}`;
  return (d ? `${base} ${d}` : base).slice(0, PROCESS_TITLE_MAX);
}

/** Set process.title to `we:<role> <detail>`. Returns the title it set ('' if it could not). Never throws. */
export function setProcessTitle(role, detail) {
  try {
    const title = formatProcessTitle(role, detail);
    process.title = title;
    return title;
  } catch {
    return '';
  }
}
