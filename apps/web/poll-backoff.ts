export function nextPollDelay(currentMs: number, factor: number, maxMs: number): number {
  return Math.min(currentMs * factor, maxMs);
}

export function pollTimeoutMessage(): string {
  return "The agent hasn't picked up yet. Your submission is saved; the agent should fetch it on its next poll.";
}
