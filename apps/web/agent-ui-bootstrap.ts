import './home';
import './components-showcase';

function setCanonicalUrl(): void {
  const url = location.origin + location.pathname.replace(/\/$/, '');
  document.querySelector('link[rel="canonical"]')?.setAttribute('href', url || location.origin);
  document
    .querySelector('meta[property="og:url"]')
    ?.setAttribute('content', url || location.origin);
}

export function mountAgentUI(pageId: string): void {
  setCanonicalUrl();

  const root = document.getElementById('app');
  if (root === null) throw new TypeError('Missing #app mount point');

  if (location.pathname === '/_components') {
    root.classList.add('is-home');
    root.appendChild(document.createElement('components-showcase'));
  } else if (location.pathname === '/demo' || location.pathname === '/demo/') {
    root.classList.add('is-home');
    void import('./demo').then(() => {
      root.appendChild(document.createElement('pagent-demo'));
    });
  } else if (!pageId) {
    root.classList.add('is-home');
    root.appendChild(document.createElement('home-page'));
  } else {
    root.appendChild(document.createElement('agent-ui-app'));
  }
}
