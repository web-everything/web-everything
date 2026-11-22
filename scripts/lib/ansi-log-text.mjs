/** Strip SGR sequences only; reject logs with any remaining ESC or C1 controls. */
export const stripAnsiLogText = text => {
  const plain = String(text).replace(/\x1b\[[0-9;]*m/g, '');
  if (/[\x1b\x80-\x9f]/.test(plain)) throw new Error('log contains unsupported control bytes');
  return plain;
};
