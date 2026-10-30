# Remote access

A phone or a second personal machine runs the same app as a *remote client* of
the host, over an HTTPS address the host publishes with Tailscale Serve. It is not
a second runtime: both clients drive the one `GjcSdkController` in the host
process, so a session started here shows up there and the result of an action is
the same on both screens.

Setup, on the desktop, in Settings → 원격 접속:

1. Turn it on. The host binds `127.0.0.1:8791` (configurable) and maps it with
   `tailscale serve --bg --https=443`. Loopback only; Tailscale Funnel / public
   exposure is not supported.
2. Press `보기 전용 코드` or `조작 가능 코드`. A code is valid for five minutes and
   works exactly once.
3. Scan the QR code, or open `https://<machine>.<tailnet>.ts.net/` and type the
   code.

A device signed in to the same tailnet account as this machine skips the code.
`tailscale serve` stamps each request with the login that owns the node it came
from, so a request that arrived through the local tailscaled, from a tailnet
address, not through Funnel, and naming this machine's own login is the owner and
is admitted directly. Everything else — another person's device, a tagged node, a
forged header — still needs a code.

What a paired device may do:

| Permission        | Allowed                                                                                            | Refused (stays desktop-only)                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 보기 전용 (view)   | session list, status, transcripts, diffs, artifacts, queued messages                                | everything below                                                                  |
| 조작 가능 (control) | those, plus send, steer, queue, cancel, tool approval, mark read                                   | create/delete/rename/compact sessions, git commit/push, file preview, host settings |

Host-destructive work keeps its host confirmation dialog, which a remote
device cannot answer, so it is not exposed at all. The permission is enforced in
the host: a view-only device that calls the control endpoints directly gets
`403`.

The host confirmation is drawn in the app's style but owned by the main
process (`electron/confirm-overlay.ts`): a separate window over Gajae with
JavaScript off, whose two buttons submit to a URL that never loads; the main
process reads the answer from the navigation it cancels. The renderer can ask
for it but cannot answer it. Sidebar delete and hide ask first through
`confirmSessionRemoval`, so the row leaves only after the user agrees, and the
delete itself then reuses that answer once (`IpcSecurity.preauthorize`) instead
of asking twice.

Security shape:

- `Host` and `Origin` are checked against this machine's loopback and tailnet
  names, and a cross-origin write is refused before authentication.
- Tailnet identity is only believed when `tailscale serve` produced it: the request
  must arrive from the local tailscaled, carry a single `X-Forwarded-For` address
  on the tailnet, name this machine's own login, and show no `Tailscale-Funnel-Request`.
  If `tailscale status` stops answering, identity access closes with it.
- Static app assets are public; session data never is. The device token travels
  in an `Authorization` header, never in a URL.
- A device token is 32 random bytes. The host stores only `HMAC(secret, token)`
  in `remote-devices.json` (mode `0600`); the phone keeps the token in
  `localStorage`.
- A pairing code is carried in the URL fragment (`#pair=…`), which browsers never
  send to a server, and is removed from the address bar before it is used.
- `접근 해제` deletes the device record immediately: later requests answer `401`
  and the device's open event stream is closed. A device admitted by identity never
  paired and is not in that list: to cut one off, turn remote access off or remove
  the device from the tailnet.

Reconnection and duplicate safety:

- The event stream is `text/event-stream` with sequence numbers. A reconnect
  resumes from the last sequence the client actually received; a gap the host can
  no longer replay becomes a snapshot refresh instead of a guess.
- Every control request carries an operation ID. A repeat replays the recorded
  outcome instead of running the instruction twice, and
  `GET /api/operations/<id>` answers what happened to a request whose reply was
  lost.
- A control request that dies without an answer is never resent: the client looks
  the outcome up and reports `전송 결과를 확인할 수 없습니다` when there is none.

The remote client installs as a PWA. Its service worker caches static app assets
only — `/api/` responses and the device token are always fetched live.
