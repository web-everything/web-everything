// Shared lifecycle predicates for ESM scripts and the CommonJS site loaders.
exports.TERMINAL_STATUSES = new Set(['resolved', 'closed']);
exports.CLOSED_REASONS = new Set(['duplicate', 'fixed-elsewhere', 'obsolete', 'wont-do']);
exports.isTerminalStatus = (status) => exports.TERMINAL_STATUSES.has(status);
exports.isDelivered = (status) => status === 'resolved';
