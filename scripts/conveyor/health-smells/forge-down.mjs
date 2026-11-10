/** Forge infrastructure outage and heavy-minute starvation. Discovery registers this host smell. */
export default {
  id:'forge-down',scope:'host',cadence:'every-tick',probes:['forgeDown'],
  openAfter:1,closeAfter:2,severity:'high',action:'alert',
  recommendationHint:'Inspect the top Forge fallback reason and run scripts/readiness/forge-canary.mjs --json.',
  evaluate({forgeDown}={}) {
    const p=forgeDown ?? {breach:true,status:'unknown',summary:'Forge evidence UNKNOWN (probe missing); top fallback: unknown.'};
    return [{subject:'forge',breach:p.breach!==false,measure:p,summary:p.summary}];
  },
};
