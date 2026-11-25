import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Acquire a valid lease first, then age its persisted heartbeat without short-TTL timing races.
export function expireLaneLease(lane) {
  const marker = join(lane, '.git', '.lane-lease');
  const lease = JSON.parse(readFileSync(marker, 'utf8'));
  const expiredAt = new Date(Date.now() - (lease.ttlMinutes + 1) * 60_000).toISOString();
  writeFileSync(marker, JSON.stringify({ ...lease, acquiredAt: expiredAt,
    ...(lease.renewedAt ? { renewedAt: expiredAt } : {}),
  }));
}
