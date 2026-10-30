# Developing Gajae

## Run

Developers need Node.js 24 or newer. The local development package uses an
ad-hoc signature:

```bash
npm install
npm test
npm run dev          # Vite renderer
npm run dev:web      # remote client renderer in a browser
npm run dev:desktop  # Electron + Vite
npm run build:web    # dist/web: served by the host, bundled into the app
```

Package:

```bash
npm run package:mac
```

Packaging rebuilds `node-pty` against Electron and unpacks that module from the
asar archive, including its `spawn-helper`. The chat header can switch the
open session between the conversation and a login-shell terminal.

For a public release, first store notarization credentials in the login
Keychain, then provide the Developer ID identity, Keychain profile, and an
explicit confirmation that the bundled artwork is cleared for redistribution.
The release script refuses to create an ad-hoc or unnotarized artifact when any
gate is missing:

```bash
xcrun notarytool store-credentials gajae-notary \
  --apple-id release@example.com --team-id TEAMID

GJC_DEVELOPER_IDENTITY='Developer ID Application: Example (TEAMID)' \
GAJA_NOTARY_KEYCHAIN_PROFILE='gajae-notary' \
GAJAE_ASSET_RIGHTS_CONFIRMED=1 \
npm run package:mac -- --public-release
```

Never put these credentials in the repository or the packaged application. A
successful public release produces the portable pair:

```text
release/Gajae-0.1.0-darwin-arm64/Gajae-0.1.0-darwin-arm64.zip
release/Gajae-0.1.0-darwin-arm64/Gajae-0.1.0-darwin-arm64.zip.sha256
```

Published version artifacts are immutable. Bump `package.json` before creating a
different build; the release script refuses to overwrite a same-version ZIP.

The local ad-hoc development package remains at
`release/Gajae-darwin-arm64/Gajae.app` and is not a public distribution artifact.

## Checks and layout

```bash
npm run lint
npm test
npm run verify
```

- Electron main: `electron/`
- Remote access host: `electron/remote/`
- Renderer: `src/`
- Remote client: `src/remote/`
- IPC and protocol contracts: `shared/`
- PWA assets and the web build: `web/`, `vite.web.config.ts`

## Developer notes

Bundled original project artwork is not claimed as third-party material. Asset
redistribution must be confirmed before distributing a binary release.

Settings writes go through one of two paths, and the choice is part of the
contract:

- `settings.savePreferences` replaces the whole preferences object and runs
  `authorizeDestructive`, which raises the OS “Apply runtime settings?” prompt.
  Use it for settings that change what the runtime does: workspace, model preset,
  approval mode, GJC executable.
- Field-only channels validate one value, rewrite that one field and reuse the
  store's `persist()` — no prompt. Use them for display and reading preferences.
  `setWorkspaceLabel` and `setThoughtsExpanded` are the existing ones; a card
  toggle that raised a confirmation modal on every click is why the second exists.
  A new field-only channel needs all three pieces: an entry in
  `shared/settings-ipc.ts`, the bridge method in `electron/preload.ts`, and a
  handler in `electron/settings-ipc-handlers.ts` that validates the value and
  does not call `authorizeDestructive`. `SettingsStore.validate()` stays the
  whole-object gate; the field setter checks only its own field, so an unrelated
  stale value cannot block a display toggle.

Card typography: every text element inside a card sets its own size. An unstyled
`<p>` or `<small>` inherits the browser's 16px default, which renders larger than
the card's own title in a UI whose body text is 9–12px.

## GJC SDK session CLI compatibility

<!-- gjc-matrix:start -->
<!-- gjc-matrix:end -->

Gajae targets installed `gajae-code` version `0.18.12` or newer. The live
checks below distinguish confirmed behavior from remaining runtime limitations;
the versions marked **verified on 0.19.0** were re-run against the installed
`gjc/0.19.0` release. It uses only the credential-free public surface:

```text
gjc sdk session list|inspect|send|status|tail
gjc sdk session raw control|query|global
```

Two flag rules from the 0.18.12 grammar are load-bearing:

- Every invocation passes `--json`. Failures answer a `gjc.command-error` envelope
  there, and plain human text without it, which the app cannot classify.
- Only `session list` passes `--repo`. Exact-session verbs resolve from the session
  ID and warn that the flag is ignored; `raw control` and `raw global` reject it as
  a usage error before dispatch. `session list` also states `--scope` explicitly
  because the 0.18.12 default scope is `repo`, which fails outside a git checkout.

Create, fork, resume, and delete use `raw global` with a fresh lifecycle
idempotency key. Prompt submission uses semantic `send` with a fresh operation
reference and reconciles completion with `status` plus the durable transcript.
Model, effort, commands, context, and capabilities use `raw query`. Live lifecycle
catch-up uses bounded `tail --all-events` reads with checkpoint cursors; the
session-file watcher remains the transcript source of truth.

The desktop additionally starts a read-only `sdk serve --stdio --session <id>`
relay for each attached session. After `hello`, it negotiates `turn_stream` and
`session_host_observer_v1` using `event_replay`. Tool updates replace the previous
output snapshot; `tool_execution_end` finalizes it. The relay reconnects after
failure and is terminated on detach or shutdown, without signalling the agent.
Durable tail/file reads remain authoritative. The app never opens a session
WebSocket itself, reads endpoint credentials, or uses discovery records to attach.

**Verified on 0.19.0.** The observer negotiation now delivers live
`tool_execution_start/update/end` frames during a multi-second bash loop:
`AGENT_CONTROL_GJC_PRESET=<working-profile> node scripts/gjc-tool-stream-e2e.mjs`
reported four intermediate running snapshots (`GJCLINE1` through `GJCLINE4`) that
were replaced, never appended, plus the authoritative completed result. Upstream
[PR #6832](https://github.com/Yeachan-Heo/gajae-code/pull/6832) fixed broker
observer delivery after v0.18.12 and is included in v0.19.0. Until that release
the same probe received no tool frames at all, so a build older than 0.19.0 still
has no live tool output. Partial bash output is labelled as a snapshot whose
beginning may be omitted: upstream tail-only updates do not always carry explicit
truncation metadata.

Desktop Esc/Stop sends:

```ts
turn.abort {
  mode: "terminal",
  scope: "owned",
  operator: true,
}
--confirm
--idempotency-key "gajae-abort-<uuid>"
```

Gajae requires the following behavior, shipped by the supported runtime:

1. Forward the CLI idempotency key on control-request envelopes
2. `turn.abort` `operator: true` — an external controller can stop owned work. Requires `--confirm`

**Resolved in 0.18.12.** 0.18.11 answered the terminal abort with
`{turn:"no_active_turn", terminal:"terminal_no_effect"}` through this route even
while a turn was verifiably running (`status` in_flight and `turn.steer` accepted
on the same session), and the turn kept running. The same payload over a live
`sdk serve --stdio` connection was rejected with `operation_prohibited` ("Operator
terminal aborts are available only through the Broker control route"). Stop
therefore reported that it could not confirm the abort instead of claiming the run
stopped; the transcript stayed the source of truth for whether work continued.
Upstream https://github.com/Yeachan-Heo/gajae-code/pull/6776 (reported as
https://github.com/Yeachan-Heo/gajae-code/issues/6772) scoped the active-submission
lookup to the broker-authorized `operator` flag. On 0.18.12 the route does confirm
`turn:"stopped"` once the host has registered the active submission, and Gajae
re-asks briefly because a local `running` event precedes that registration. The
0.18.12 e2e still reproduced `no_active_turn` while a 30-second bash turn was
verifiably running; that path remains unconfirmed and is never reported as
stopped. Re-run on 0.19.0, `scripts/gjc-cancel-e2e.mjs` reports
`terminalAbortVerified: true`, `finalStatus: idle`, and `transcriptStable: true`
with the host actually executing a bash turn. Only `turn:"stopped"` is treated as
a confirmation. Confirmed cancellation remains idle during discovery even when
the durable file ends at an aborted tool result rather than a terminal assistant
message. The local cancellation notice survives durable refreshes. Upstream
#6860 (in 0.19.0) also stopped a direct CLI `/new` from leaving the previous
session id live; measured on 0.19.0, the old row became `live:false` and the new
id was registered under the same pid.

**Resolved in 0.18.12.** `session.delete` requires the durable transcript path,
and a call that omits it is refused with `invalid_input` ("session.delete requires
sessionPath and its configured cwd."). 0.18.11 rendered that refusal as
`operation_failed` ("The operation failed. Its outcome could not be established.",
`outcomeCertainty: unknown`, retryability `unknown`, guidance "do not blindly
retry"), so a refused delete was indistinguishable from a delete that may have
half-applied. Upstream https://github.com/Yeachan-Heo/gajae-code/pull/6777 adds the
`lifecycle_input_refused` diagnostic for that admission refusal. Gajae still passes
the path it located; an unknown outcome preserves the transcript, metadata, and
worktree and marks the session as recovering rather than reporting a deletion it
cannot prove. Close-then-delete succeeds for a session that only replied, but a
session containing tool execution still answered an unknown outcome on 0.18.12
(upstream #6828).

**Verified on 0.19.0.** The limitation remains: a disposable session that ran one
bash tool, and a separate empty session that never received a message, both got
`operation_failed` with `outcomeCertainty: unknown` and stayed `deleted:false`.
Neither response carried the `lifecycle_legacy_history_ambiguous` diagnostic, so
per the 0.19.0 guidance the legacy ledger fence was not the reported cause.

**Root cause identified on 0.19.0.** The broker settled each delete and persisted
the correct terminal row, then rejected its own read-back: `readTerminal` scans
every ledger row and returns `shape` on three rows from a 2026-10-15
`cleanup_pending` receipt whose `artifactTree.snapshot.entries` array has 1066
entries, over `isBoundedLedgerJson`'s 1024-element cap.
`verifyTerminalPersistence` converts that rejection into `terminal_uncertain`, and
the public CLI reports it as `operation_failed` without diagnostics. A copy of
the ledger with only those three rows removed returns the real
`invalid_input` / `lifecycle_input_refused` response, so this is GJC ledger
self-poisoning, not an app path. Upstream report:
[#7134](https://github.com/Yeachan-Heo/gajae-code/issues/7134). The owner-local
CLI session picker does not go through this broker read-back and remains the
supported way to delete saved history until GJC repairs or compacts the ledger.
The app never edits, truncates, or deletes the ledger, and a live host this
window created, forked, or resumed is closed first; a terminal's host is never
signalled.

Gajae now preserves the public envelope's diagnostics and outcome certainty.
`lifecycle_input_refused` produces an actionable input-refusal error, but it is not
proof that deletion was unapplied: unless broker reconciliation proves deletion,
the session remains recovering and all local evidence is retained. There is no
automatic retry. The existing empty `27f32a06…` probe failed deletion on 0.18.12
and still did on 0.19.0 with an unknown outcome and `deleted:false` (see
[upstream #6828](https://github.com/Yeachan-Heo/gajae-code/issues/6828)).
PR #6832 adds the `lifecycle_legacy_history_ambiguous` diagnostic, not permission
to clear the admission fence, and v0.19.0 includes it. That diagnostic was absent
from the 0.19.0 delete attempts above because admission passed: the failure came
from the post-persistence read-back described above, not from the legacy
`accepted` row. The isolation experiment removed rows only from a copy of the
ledger; the live ledger was never edited. Gajae surfaces the diagnostic
distinctly when a broker does return it and retains the session and evidence: the
current request was not dispatched, but earlier effects remain unresolved.
Preserve the original operation, request key, target, and ledger; do not edit the
ledger, force deletion, or retry under a new key. v0.19.0's new
`gjc sdk session retire` (`session.reconcile_uncertain`) only retires an indexed
`terminalUncertain` create effect with dead-host proof; it is not an override for
opaque legacy history.

Older GJC versions are unsupported. After updating GJC, restart running `gjc` /
`gjc --resume` session hosts because they do not hot-reload runtime code.

If the CLI rejects the `operator` field, the app reports failure instead of pretending the run stopped.

Steer itself is unchanged in GJC. The desktop uses `raw control` with the existing
`turn.steer` operation. Empty Enter only aborts so the Composer's held work is
consumed once through steering (steer-on-interrupt). Do not dequeue and
`abort_and_prompt` the same text.

## Lifecycle receipts

`Lifecycle terminal evidence could not be verified after persistence; retained
artifacts require reconciliation` means GJC could not confirm it recorded the
operation. It does not mean the operation failed.

Creating and forking both hit this for work that had already succeeded. The broker
index is consulted for the retained session instead of raising an error; the error
is raised only when nothing appears. GJC's public list/inspect projection strips
the ledger's internal `lifecycleRequestId`, so the caller's idempotency key never
matches a row: the app adopts the one new live generation>=1 session in that
workspace whose endpoint appeared after the request began. Two such sessions mean
a concurrent creator and stay a reconciliation error rather than a guess. A
resumed session stays readable and marked `recovering`, since its transcript comes
from the session file either way and only live control is unproven.

The receipt failures themselves come from the GJC ledger and are not fixable here.
On 0.18.12 the broker logs `mismatches:["readBack:shape"]` when one unrelated
ledger row exceeds its JSON field bound (for example a large `cleanup_pending`
response), which makes every terminal read-back look rejected. Do not edit the
ledger to clear it; the broker index is the recovery authority.

## Do not

- `SIGINT` / kill the GJC process to cancel
- Use `turn.abort_and_prompt` as a cancel fallback (the control sentence becomes a real user message)
- Force `idle` / “cancelled” UI from the abort ACK alone
- Treat session delete as hiding a row in the list
- Treat an unverifiable lifecycle receipt as a failed operation
- Route a display-only preference through `settings.savePreferences` (whole-object save, host confirmation modal); add a field-only channel instead
- Keep a card's own copy of a window-wide preference, or let it fall behind the stored value
- Render card text without a rule of its own and let the 16px browser default decide its size
