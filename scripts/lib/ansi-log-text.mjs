/** Strip only well-formed CSI sequences within each line; preserve all other bytes. */
export const stripAnsiLogText = text => String(text)
  .split('\n')
  .map(line => line.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, ''))
  .join('\n');
