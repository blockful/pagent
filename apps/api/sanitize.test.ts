import { describe, it, expect } from 'vitest';
import { sanitize } from './sanitize.ts';

describe('sanitize', () => {
  it('returns clean payloads unchanged (idempotent on safe input)', () => {
    const safe = '<div class="card"><h1>Hello</h1><p>World <em>!</em></p></div>';
    expect(sanitize(safe).output).toBe(safe);
  });

  it('preserves inline <style>', () => {
    const input = '<style>.x{color:red}</style><div class="x">hi</div>';
    expect(sanitize(input).output).toContain('<style>');
    expect(sanitize(input).output).toContain('.x{color:red}');
  });

  it('preserves data: image URLs', () => {
    const input = '<img src="data:image/png;base64,iVBORw0K" alt="x">';
    expect(sanitize(input).output).toContain('data:image/png;base64');
  });

  it('preserves https: anchor hrefs', () => {
    const input = '<a href="https://example.com">link</a>';
    expect(sanitize(input).output).toContain('href="https://example.com"');
  });

  it('strips <script>', () => {
    const out = sanitize('<div>safe</div><script>alert(1)</script>').output;
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<div>safe</div>');
  });

  it('strips <iframe>', () => {
    const out = sanitize('<iframe src="https://attacker.example"></iframe>').output;
    expect(out).not.toContain('<iframe');
  });

  it('strips <object>', () => {
    const out = sanitize('<object data="x.swf"></object>').output;
    expect(out).not.toContain('<object');
  });

  it('strips <embed>', () => {
    const out = sanitize('<embed src="x.swf">').output;
    expect(out).not.toContain('<embed');
  });

  it('strips <link>', () => {
    const out = sanitize('<link rel="stylesheet" href="https://attacker.example/x.css">').output;
    expect(out).not.toContain('<link');
  });

  it('strips <base>', () => {
    const out = sanitize('<base href="https://attacker.example/">').output;
    expect(out).not.toContain('<base');
  });

  it('strips <meta http-equiv=refresh>', () => {
    const out = sanitize(
      '<meta http-equiv="refresh" content="0;url=https://attacker.example">',
    ).output;
    expect(out).not.toContain('<meta');
  });

  it('strips on* event handlers', () => {
    const out = sanitize('<button onclick="alert(1)">x</button>').output;
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('alert(1)');
  });

  it('strips onerror on <img>', () => {
    const out = sanitize('<img src="x" onerror="alert(1)">').output;
    expect(out).not.toContain('onerror');
  });

  it('strips javascript: URLs in href', () => {
    const out = sanitize('<a href="javascript:alert(1)">click</a>').output;
    expect(out).not.toMatch(/javascript:/i);
  });

  it('strips vbscript: URLs', () => {
    const out = sanitize('<a href="vbscript:msgbox(1)">click</a>').output;
    expect(out).not.toMatch(/vbscript:/i);
  });

  it('strips data:text/html (executable data URL)', () => {
    const out = sanitize('<a href="data:text/html,<script>alert(1)</script>">click</a>').output;
    expect(out).not.toContain('data:text/html');
  });

  it('strips formaction (form override attack)', () => {
    const out = sanitize('<button formaction="https://attacker.example">x</button>').output;
    expect(out).not.toContain('formaction');
  });

  it('strips srcdoc on any element', () => {
    const out = sanitize('<iframe srcdoc="<script>x</script>"></iframe>').output;
    expect(out).not.toContain('srcdoc');
  });

  it('preserves inline <svg>', () => {
    const input = '<svg width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>';
    const out = sanitize(input).output;
    expect(out).toContain('<svg');
    expect(out).toContain('<circle');
  });

  it('strips xlink:href on SVG (legacy XSS vector)', () => {
    const out = sanitize('<svg><use xlink:href="javascript:alert(1)"/></svg>').output;
    expect(out).not.toMatch(/xlink:href/i);
  });

  it('reports counts of removed tags and attrs', () => {
    const r = sanitize('<script>1</script><button onclick="x">y</button>');
    expect(r.removedTags + r.removedAttrs).toBeGreaterThan(0);
  });
});
