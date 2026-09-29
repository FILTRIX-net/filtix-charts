export class TerminalMutationSupersededError extends Error {
  constructor() {
    super('Terminal mutation was superseded');
    this.name = 'TerminalMutationSupersededError';
  }
}

export function isTerminalMutationSuperseded(value: unknown): value is TerminalMutationSupersededError {
  return value instanceof TerminalMutationSupersededError;
}

export function reportUnlessMutationSuperseded(error: unknown, report: (error: unknown) => void): void {
  if (!isTerminalMutationSuperseded(error)) report(error);
}
