/** Normalize a WHOLE job log for diagnosis, never authorization.
 * Strip SGR only; unsupported ESC/C1 returns no usable text or success evidence.
 */
export const readNormalizedJobLog = log => {
  if (typeof log !== 'string' && !Buffer.isBuffer(log)) return { ok: false };
  const text = String(log).replace(/\x1b\[[0-9;]*m/g, '');
  return /[\x1b\x80-\x9f]/.test(text) ? { ok: false } : { ok: true, text };
};
