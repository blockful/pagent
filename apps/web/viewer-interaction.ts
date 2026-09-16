import type { EngagementTracker } from './viewer-tracking.ts';

type ObserverInput = {
  readonly root: ParentNode;
  readonly tracker: EngagementTracker;
};

export function observeViewerStage(input: ObserverInput): IntersectionObserver | null {
  const stage = input.root.querySelector('.viewer-stage');
  if (!(stage instanceof HTMLElement)) return null;
  const observer = new IntersectionObserver(
    ([entry]) => input.tracker.setVisibleRatio(entry?.intersectionRatio ?? 0),
    { threshold: [0, 0.5, 1] },
  );
  observer.observe(stage);
  return observer;
}

export async function toggleFullscreen(element: HTMLElement): Promise<void> {
  if (document.fullscreenElement === null) await element.requestFullscreen();
  else await document.exitFullscreen();
}
