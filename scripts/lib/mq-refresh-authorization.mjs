// Recovery refresh is retired. No production caller may obtain write authorization here.
export function createMqRefreshAuthorization() {
  return { approvedHeadHold: () => true, enqueueAllowed: () => false };
}
