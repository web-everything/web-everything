/** Normalize a WHOLE job log: strip SGR only; unsupported ESC/C1 evidence fails closed. */
export const readNormalizedJobLog = log => {
  if (typeof log !== 'string' && !Buffer.isBuffer(log)) return { ok: false };
  const text = String(log).replace(/\x1b\[[0-9;]*m/g, '');
  return /[\x1b\x80-\x9f]/.test(text) ? { ok: false } : { ok: true, text };
};
