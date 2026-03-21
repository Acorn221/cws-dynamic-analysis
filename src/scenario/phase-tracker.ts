export interface PhaseTracker {
  current: string;
}

export function createPhaseTracker(): PhaseTracker {
  return { current: 'pre' };
}
