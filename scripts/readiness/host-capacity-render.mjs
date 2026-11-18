/** Pure formatting shared by the host-capacity CLI and its compute-only declaration. */
const percent = n => Number.isFinite(n) && n >= 0 && n <= 100;
const formatPercent = n => percent(n) ? Number(n.toFixed(1)) : 'unknown';

export function renderHostCapacity(r) {
  return [`Mac: ${r.reason}; busy cores ${r.mac.busyCores?.toFixed(1) ?? 'unknown'}/${r.mac.cores}`,
    `Load average ${r.mac.loadAverage.map(n => n.toFixed(2)).join(', ')} (reference only); swap used ${r.mac.swapUsedMb ?? 'unknown'} MB; compressor ${r.mac.compressorPages ?? 'unknown'} pages`,
    `Heavy queue: ${r.heavyQueue ? `${r.heavyQueue.held}/${r.heavyQueue.cap} held; ${r.heavyQueue.waiting} waiting` : 'unknown'}`,
    `Forge: ${r.forge.reachable ? `load/core ${r.forge.loadPerCore.toFixed(2)}; RAM free ${formatPercent(r.forge.freeRamPct)}%; runs ${r.forge.activeRuns}/${r.forge.maxConcurrent}` : 'unreachable'}; headroom ${r.headroom.forge}`,
    `Admit new workers: ${r.admitNewWorkers}`].join('\n');
}
