import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The web client build.
 *
 * It is the same renderer as the desktop app, compiled for a browser that talks
 * to the host over the remote API. The desktop build's CSP reaches only the
 * loopback event stream; this one must reach its own origin for `/api/*` and the
 * event stream, and nothing else.
 *
 * Output goes to `dist/web`, which the host serves and the macOS package bundles.
 */

export function webContentSecurityPolicy(development: boolean): string {
  const connect = development
    ? "'self' ws://127.0.0.1:5173 http://127.0.0.1:5173"
    : "'self'"
  return [
    "default-src 'none'",
    "script-src 'self'" + (development ? " 'unsafe-eval'" : ''),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-src data: 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

export function replaceWebCspMarker(html: string, development: boolean): string {
  const marker = /<meta id="gajae-web-csp"[^>]*>/gu
  const matches = html.match(marker)
  if (matches?.length !== 1)
    throw new Error(
      `Expected exactly one Gajae web CSP marker, found ${matches?.length ?? 0}`,
    )
  return html.replace(
    marker,
    `<meta id="gajae-web-csp" http-equiv="Content-Security-Policy" content="${webContentSecurityPolicy(development)}" />`,
  )
}

const cspPlugin = {
  name: 'gajae-web-csp',
  transformIndexHtml(html: string, ctx: { command: 'build' | 'serve' }) {
    return {
      html: replaceWebCspMarker(html, ctx.command === 'serve'),
      tags: [],
    }
  },
}

export default defineConfig({
  base: '/',
  publicDir: 'web',
  plugins: [react(), cspPlugin],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    rollupOptions: {
      input: 'index.web.html',
    },
  },
})
