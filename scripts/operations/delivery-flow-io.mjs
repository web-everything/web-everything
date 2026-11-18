/** Preview IO only: card lookup uses the dispatcher's canonical scope loader. */
import { deliveryFlowFor } from '../lib/delivery-flow.mjs';
import { defaultLoadItems, findItem } from './dispatch-lane-io.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function createDeliveryFlowReader({ loadItems = () => defaultLoadItems(ROOT), flowFor = deliveryFlowFor } = {}) {
  return ({ num, scope }) => {
    const entries = num ? findItem(String(num), loadItems)?.scope : scope;
    return flowFor({ scope: entries, kind: 'build' });
  };
}
