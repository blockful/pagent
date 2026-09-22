import { z } from 'zod';

const rendererOriginSchema = z
  .string()
  .url()
  .pipe(
    z.string().refine((value) => {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.origin === value &&
        !/[\s*,;]/.test(value)
      );
    }),
  )
  .brand('RendererOrigin');

export type RendererOrigin = z.infer<typeof rendererOriginSchema>;

export function documentOrigins(
  configured: readonly string[] | undefined,
): readonly RendererOrigin[] {
  return (configured ?? []).flatMap((value) => {
    const parsed = rendererOriginSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

export function documentCsp(origins: readonly RendererOrigin[]): string {
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${origins.length === 0 ? "'none'" : origins.join(' ')}`,
  ].join('; ');
}

export function renderHtmlDocument(
  html: string,
  origin: RendererOrigin,
  revisionId: string,
): string {
  const config = `{origin:${scriptString(origin)},revisionId:${scriptString(revisionId)}}`;
  return `${html}\n<script>(()=>{
const {origin,revisionId}=${config};
let last=-Infinity;
const report=(event)=>{
  if(!event.isTrusted)return;
  const now=performance.now();
  if(now-last<1000)return;
  last=now;
  parent.postMessage({type:"pagent:activity"},origin);
};
for(const name of ["pointerdown","keydown","wheel","touchstart"]){
  addEventListener(name,report,{capture:true,passive:true});
}
parent.postMessage({type:"pagent:ready",revisionId},origin);
})();</script>`;
}

export function renderDocumentError(origin: RendererOrigin): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page unavailable</title></head><body><p>The page could not be opened. Return to the sharing page and try again.</p><script>parent.postMessage({type:"pagent:error"},${scriptString(origin)});</script></body></html>`;
}

function scriptString(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
