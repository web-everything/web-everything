/** Vitest 1.x's JSON reporter omits global errors. Preserve their count in the same report
 * so a passing file retry cannot erase an independent unhandled rejection or runtime error.
 * Keep the built-in JSON output path/format, including --outputFile.json.
 */
import { JsonReporter } from 'vitest/reporters';

export default class UnitJsonReporter extends JsonReporter {
  constructor(options = {}) { super(options); }

  async writeReport(text) {
    const errors = this.ctx.state.getUnhandledErrors();
    if (!Array.isArray(errors)) throw new Error('cannot determine global unit errors');
    const report = JSON.parse(text);
    await super.writeReport(JSON.stringify({ ...report, numUnhandledErrors: errors.length }));
  }
}
