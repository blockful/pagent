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
  const pathname = location.pathname;
  const deckDetailMatch = /^\/decks\/([0-9a-f-]{36})\/?$/i.exec(pathname);
  const shareMatch = /^\/share\/([^/]+)\/?$/.exec(pathname);

  if (pathname === '/_components') {
    root.classList.add('is-home');
    root.appendChild(document.createElement('components-showcase'));
  } else if (pathname === '/_product-components') {
    root.classList.add('is-home');
    void import('./product-components.ts').then(() => {
      root.appendChild(document.createElement('product-components'));
    });
  } else if (pathname === '/demo' || pathname === '/demo/') {
    root.classList.add('is-home');
    void import('./demo').then(() => {
      root.appendChild(document.createElement('pagent-demo'));
    });
  } else if (pathname === '/decks' || pathname === '/decks/') {
    root.classList.add('is-home');
    void Promise.all([import('./product-navigation.ts'), import('./deck-library.ts')]).then(() => {
      root.appendChild(document.createElement('deck-library'));
    });
  } else if (deckDetailMatch !== null) {
    root.classList.add('is-home');
    void Promise.all([import('./product-navigation.ts'), import('./deck-detail.ts')]).then(() => {
      const element = document.createElement('deck-detail-page');
      element.setAttribute('deckid', deckDetailMatch[1] ?? '');
      root.appendChild(element);
    });
  } else if (shareMatch !== null) {
    root.classList.add('is-home');
    void import('./deck-viewer.ts').then(() => {
      const element = document.createElement('deck-viewer');
      element.setAttribute('sharetoken', decodeURIComponent(shareMatch[1] ?? ''));
      root.appendChild(element);
    });
  } else if (pathname === '/view' || pathname === '/view/') {
    root.classList.add('is-home');
    void import('./deck-viewer.ts').then(() => {
      root.appendChild(document.createElement('deck-viewer'));
    });
  } else if (pathname === '/privacy' || pathname === '/privacy/') {
    root.classList.add('is-home');
    void Promise.all([import('./product-navigation.ts'), import('./privacy-page.ts')]).then(() => {
      root.appendChild(document.createElement('privacy-page'));
    });
  } else if (!pageId) {
    root.classList.add('is-home');
    root.appendChild(document.createElement('home-page'));
  } else {
    root.appendChild(document.createElement('agent-ui-app'));
  }
}
