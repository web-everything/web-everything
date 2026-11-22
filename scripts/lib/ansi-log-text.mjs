/** Strip well-formed CSI sequences; reject logs with remaining escape bytes. */
export const stripAnsiLogText = text => {
  const plain = String(text)
    .split('\n')
    // ESC[Errors is ambiguous with CSI E: never erase the error marker's first letter.
    .map(line => line.replace(/\x1b\[(?!Errors\b)[0-?]*[ -\/]*[@-~]/g, ''))
    .join('\n');
  if (plain.includes('\x1b')) throw new Error('log contains non-CSI escape bytes');
  return plain;
};
