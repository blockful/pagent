export function nextPollDelay(currentMs: number, factor: number, maxMs: number): number {
  return Math.min(currentMs * factor, maxMs);
}
