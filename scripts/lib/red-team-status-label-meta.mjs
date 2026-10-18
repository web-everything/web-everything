/** Known red-team status labels and provisioning metadata. */
export const RED_TEAM_STATUS_LABEL_META = Object.freeze({
  'red-team:pending': { color: 'fbca04', description: 'Red team scheduled or running on the current head' },
  'red-team:clear': { color: '0e8a16', description: 'Red team completed without an unresolved blocking break on the current head' },
  'red-team:blocked': { color: 'd73a4a', description: 'Red-team break sent back or awaiting an operator ruling on the current head' },
});
export const RED_TEAM_STATUS_LABELS = Object.keys(RED_TEAM_STATUS_LABEL_META);

