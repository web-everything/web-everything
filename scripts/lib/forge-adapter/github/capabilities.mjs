/** @file GitHub adapter capability declaration (forge.capabilities). The app webhook feeds change-events natively. */
export function githubCapabilities() {
  return {
    'change-events': { support: 'native', source: 'plateau-observer app webhook via the pr-events receiver' },
    changes: { support: 'native', source: 'reconcile poll (full sweep)' },
  };
}
