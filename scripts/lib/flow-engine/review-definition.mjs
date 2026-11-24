// Shadow-only convergence subset; conveyor/flows/review.flow.json is a job diagram, not a loadable FlowEngine definition.
export default { flowType: 'https://everstandards.dev/flow/decision-lifecycle/v0',
    id: 'tag:everstandards.dev,2026-11-22:flow/review/v1', initial: 'judge-convergence',
    keys: { parts: { Subject: { kind: 'subject' }, Visit: { kind: 'visit' } } },
    retry: { maxAttempts: 1, onExhausted: 'parked' },
    guards: { convergence: { classifies: 'stop rule', outcomes: ['accept', 'continue', 'stop', 'unknown'] } },
    states: {
      'judge-convergence': { kind: 'judge', key: 'review:{Subject}:{Visit}', on: [
        { event: 'done', guard: 'convergence', outcome: 'accept', route: 'advance', target: 'accepted' },
        { event: 'done', guard: 'convergence', outcome: 'continue', route: 'advance', target: 'judge-convergence' },
        { event: 'done', guard: 'convergence', outcome: 'stop', route: 'advance', target: 'parked' },
        { event: 'done', guard: 'convergence', outcome: 'unknown', route: 'retry', target: 'judge-convergence' },
      ] }, accepted: { kind: 'final', emits: 'https://everstandards.dev/governance/ruling-record/v0.1' }, parked: { kind: 'final' },
    } };
