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

export function deviceClass(): 'mobile' | 'tablet' | 'desktop' {
  if (innerWidth < 640) return 'mobile';
  if (innerWidth < 1024) return 'tablet';
  return 'desktop';
}

export function browserFamily(): string {
  const agent = navigator.userAgent;
  if (agent.includes('Firefox/')) return 'Firefox';
  if (agent.includes('Edg/')) return 'Edge';
  if (agent.includes('Chrome/')) return 'Chromium';
  if (agent.includes('Safari/')) return 'Safari';
  return 'Other';
}
