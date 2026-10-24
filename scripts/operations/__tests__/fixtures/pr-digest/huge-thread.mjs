/** Deterministic large-thread fixture, generated in memory to avoid committing megabytes of repeated prose. */
export function hugeThread(comments) {
  const filler = 'HUGE_BODY_SENTINEL '.repeat(1200);
  return Array.from({ length: 400 }, (_, i) => ({
    id: i + 1, author: { login: 'chalbert' },
    body: `${i === 398 ? comments[2].body : i === 399 ? comments[3].body : 'Routine progress update.'}\n${filler}`,
  }));
}
