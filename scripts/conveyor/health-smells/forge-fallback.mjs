/** R830: unintended local heavy runs are host blockers, including in shadow mode. */
export default {
  id:'forge-fallback',scope:'host',cadence:'every-tick',probes:['forgeFallback'],
  openAfter:1,closeAfter:2,severity:'high',action:'alert',
  recommendationHint:'Inspect the top fallback detail; restore admission history on UNKNOWN and repair the named Forge refusal.',
  evaluate({forgeFallback}={}) {
    const p=forgeFallback ?? {status:'unknown',breach:true,summary:'UNKNOWN (probe missing); restore admission history.'};
    return [{subject:'forge',breach:p.breach!==false,measure:p,summary:p.summary}];
  },
};
