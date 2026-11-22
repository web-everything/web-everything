/** Normalize terminal log evidence before matching; preserve text after a stray ESC. */
export const stripAnsiLogText = text => String(text)
  // OSC strings end with BEL or ST (ESC backslash), including their 8-bit forms.
  .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)/g, '')
  // CSI covers every final command, including erase-line, rather than just SGR colours.
  .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[ -/]+[@-~]/g, '')
  .replace(/\x1b/g, '');
