import b, { cases } from './nocode-answer-resumed-fixer.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

for (const caseName of cases) defineBreakTest({ ...b, id: `${b.id}/${caseName}`, title: caseName,
  run: () => b.run({ caseName }) });
