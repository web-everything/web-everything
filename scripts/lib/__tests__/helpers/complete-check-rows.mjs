/** Complete head-scoped check/status reads injected by gate fixtures. Never use for partial evidence. */
export function completeCheckRows(rows, headSha) {
  return Object.defineProperties([...rows], {
    rowsComplete: { value: true }, rowsHead: { value: headSha },
  });
}
