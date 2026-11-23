import { JsonReporter } from 'vitest/reporters';

/** Keep Vitest's JSON format and outputFile.json handling, adding retry safety evidence. */
export default class UnitJsonReporter extends JsonReporter {
  constructor(options = {}) {
    super(options);
  }

  async onFinished(files, errors = this.ctx.state.getUnhandledErrors()) {
    this.numUnhandledErrors = errors.length;
    await super.onFinished(files);
  }

  async writeReport(text) {
    const report = JSON.parse(text);
    await super.writeReport(JSON.stringify({ ...report,
      numUnhandledErrors: this.numUnhandledErrors,
      success: report.success && this.numUnhandledErrors === 0,
    }));
  }
}
