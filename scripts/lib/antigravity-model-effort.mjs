/** Effort-suffixed agy model ids select their own tier and cannot also take --effort. */
export function hasAntigravityEffortSuffix(model) {
  return typeof model === 'string' && /-(low|medium|high)$/.test(model.trim());
}
