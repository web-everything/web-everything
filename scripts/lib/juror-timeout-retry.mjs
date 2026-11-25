/** Bounded structured timeout evidence. Logs are never a source of routing authority. */
export function jurorTimeoutDetails(error) {
  if (error?.reason !== 'juror-timeout') return null;
  const { lens, provider, model } = error;
  if (![lens, provider, model].every(v => typeof v === 'string' && /^[a-zA-Z0-9:_.+/-]{1,128}$/.test(v))) return null;
  return { reason: 'juror-timeout', lens, provider, model };
}

export function validateJurorTimeoutExclusions(value) {
  if (!Array.isArray(value) || value.length > 128 || value.some(row =>
    !row || ![row.lens, row.provider].every(v => typeof v === 'string' && /^[a-zA-Z0-9:_.+-]{1,128}$/.test(v)))) {
    throw new Error('invalid juror timeout exclusions; orchestrator must inspect the dispatch evidence');
  }
  return value.map(({ lens, provider }) => ({ lens, provider }));
}
