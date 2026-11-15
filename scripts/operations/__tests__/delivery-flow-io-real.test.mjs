import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withRealRepo } from './helpers/real-repo.mjs';
import { deliveryFlowOperation } from '../delivery-flow.mjs';
import { createDeliveryFlowReader } from '../delivery-flow-io.mjs';
import { deliveryFlowFor, resolveDeliveryFlowPolicy } from '../../lib/delivery-flow.mjs';
import { readSettings } from '../../lib/settings-files.mjs';

describe('delivery-flow real policy IO', () => {
  it('previews disk-backed policy and falls back after its settings file is removed', async () => {
    await withRealRepo(({ root }) => {
      const dir = join(root, 'scripts', 'settings');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'delivery-flow.json');
      writeFileSync(path, JSON.stringify({ deliveryFlow: { flows: { ordinary: [
        { stage: 'design', model: 'fixture-model', effort: 'high', timeoutMin: 7 },
        { stage: 'build' }, { stage: 'review' },
      ] } } }));
      const readFlow = createDeliveryFlowReader({
        flowFor: input => deliveryFlowFor(input, {
          resolve: () => resolveDeliveryFlowPolicy({
            read: () => readSettings({ dir, legacyPath: null }),
            platform: {}, env: {}, log: () => {},
          }),
        }),
      });
      const declaration = deliveryFlowOperation({ readFlow });
      const preview = input => declaration.steps[0].step.fn({ input });

      expect(preview({ scope: 'we:src/main.ts' })).toMatchObject({ class: 'ordinary', stages: [
        { stage: 'design', model: 'fixture-model', effort: 'high', timeoutMin: 7 },
        { stage: 'build' }, { stage: 'review' },
      ] });
      rmSync(path);
      expect(preview({ scope: 'we:src/main.ts' })).toMatchObject({ class: 'ordinary', stages: [
        { stage: 'build' }, { stage: 'review' },
      ] });
      expect(preview({ scope: '' })).toMatchObject({ class: 'guard' });
    });
  });
});
