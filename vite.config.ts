import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export function contentSecurityPolicy(development: boolean): string {
  if (development) {
    return "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src data: 'self'; connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173 http://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'"
  }
  // `http://127.0.0.1:*` is the desktop event stream. It listens on an ephemeral port on
  // loopback (`electron/desktop-event-stream.ts`), so the port cannot be named here, and
  // the window's preload reads frames from it. Nothing else on the network is reachable:
  // the origin is loopback, the scheme is http, and the port is whatever the stream took.
  return "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src data: 'self'; connect-src http://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'"
}

export function replaceCspMarker(html: string, development: boolean): string {
  const marker = /<meta id="gajae-csp"[^>]*>/gu
  const matches = html.match(marker)
  if (matches?.length !== 1)
    throw new Error(`Expected exactly one Gajae CSP marker, found ${matches?.length ?? 0}`)
  return html.replace(
    marker,
    `<meta id="gajae-csp" http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(development)}" />`,
  )
}

const cspPlugin = {
  name: 'gajae-csp',
  transformIndexHtml(_: string, ctx: { command: 'build' | 'serve' }) {
    return {
      html: replaceCspMarker(_, ctx.command === 'serve'),
      tags: [],
    }
  },
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), cspPlugin],
})
