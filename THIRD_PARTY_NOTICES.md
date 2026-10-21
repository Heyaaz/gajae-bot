# Third-party notices

## herdr-web-ui

Portions of the desktop terminal are adapted from
[herdr-web-ui](https://github.com/devswha/herdr-web-ui) (MIT):

- `server/pty/pty-host.mjs` — JSON-line control frames for input, resize, and
  pause/resume, including the dimension clamp and resuming the reader before
  the process is killed
- `server/pty/session.ts` — the session methods that send those frames
- `src/components/PaneTerminal.tsx` — mounting xterm.js with the fit and
  web-links addons, and refitting when the container changes
- `src/lib/ws.ts` — acknowledging terminal output so the PTY reader can pause

The Gajae terminal spawns `node-pty` in the Electron main process. It does not
depend on herdr and does not ship herdr's sidecar.

```
MIT License

Copyright (c) 2026 devswha

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
