# Testing

Three layers, in the order you should reach for them:

| Layer | Command | What it covers |
| --- | --- | --- |
| Unit / property / chaos | `pnpm test` | Pure logic, the turn machine, stores, IPC contracts, the main-process composition root (no Electron mock needed). |
| Browser harness | `pnpm dev:harness` | The REAL renderer in a browser, driven by an in-memory bridge. Look at and drive every UI state without spawning Electron. |
| End-to-end | `pnpm test:e2e` | Playwright against the packaged app. |

Fixtures for all of them live in `src/shared/fixtures/` (one factory per shared
schema, plus `turnScript(...)` for scripted product-event streams).

## Browser harness

`src/harness/` installs a complete in-memory `CodexlyDesktopBridgeV1`
(`fake-bridge.ts`) on `window.codexly` before React mounts, so the actual
overlay and homepage code runs unmodified in plain Vite.

```bash
pnpm dev:harness          # http://localhost:5173, no Electron window
```

`dev:harness` sets `CODEXLY_HARNESS=1`, which drops the Electron plugin from the
dev server. Plain `pnpm dev` still starts the desktop app as before.

The harness only installs when the page asks for it (`?harness=1` or
`?scenario=…`), only in dev, and never when a real bridge is present — an
Electron window is unaffected. Production builds do not contain it; verify with:

```bash
pnpm build && grep -r "codexly-harness\|__codexlyDevStores" dist/   # expect no matches
```

### URL parameters

- `role=overlay | homepage` — which surface to mount (default `homepage`).
- `scenario=<name>` — initial state + scripted response (default `empty`).
- `delay=<ms>` — per-chunk streaming delay (0–5000; scenario default otherwise).
- `pauseAfter=<frames>` — freeze every turn after N frames (`0` = right after the
  announcement, i.e. the pre-first-token "thinking" state). The page then holds
  that exact mid-stream state until `bridge.resume()`/`bridge.step()`.
- `harness=1` — install with the default scenario; `harness=off` disables.
- `#history`, `#settings`, … — the homepage section (normal app routing).

The overlay normally renders on a transparent Electron window, so the harness
page gives it a checkered dark backdrop and a corner badge naming the role and
scenario.

### Scenario catalog

| Scenario | URL | What you see |
| --- | --- | --- |
| `empty` | `/?role=overlay&scenario=empty` | Cold start: empty queue, nothing persisted. |
| `streaming` | `/?role=overlay&scenario=streaming` | A short answer streaming into the chat panel. |
| `longAnswer` | `/?role=overlay&scenario=longAnswer` | A long, slow answer — long enough to hit Stop. |
| `reasoningHeavy` | `/?role=overlay&scenario=reasoningHeavy` | Reasoning first, answer last (thinking disclosure). |
| `toolUse` | `/?role=overlay&scenario=toolUse` | A shell activity with output, then the answer. |
| `error` | `/?role=overlay&scenario=error` | A turn that fails mid-answer; error banner. |
| `stopMidStream` | `/?role=overlay&scenario=stopMidStream` | A scripted interruption and its terminal presentation. |
| `attachments` | `/?role=overlay&scenario=attachments` | Three queued screenshots waiting for Solve. |
| `resyncGap` | `/?role=overlay&scenario=resyncGap` | The transport drops a middle chunk; the UI re-syncs from the authoritative snapshot (the dropped text appears without ever being streamed). |
| `sessions` | `/?role=homepage&scenario=sessions#history` | Four persisted conversations on the History page. |

Every scenario works in both roles — `?role=homepage&scenario=toolUse#history`
streams into the History composer instead of the overlay.

### Inspector API

Dev-only, installed alongside the fake bridge as `window.__codexly`:

```js
window.__codexly.role                                 // 'overlay' | 'homepage'
window.__codexly.scenario                             // the active scenario name
window.__codexly.scenarios                            // every scenario name
window.__codexly.recipes                              // every scripted response name
window.__codexly.help()                               // the one-liners below

window.__codexly.getState()                           // { role, scenario, stores, bridge, eventCount }
window.__codexly.getState().stores.overlay.turn       // the turn machine state
window.__codexly.getState().stores.overlay.answer     // rendered transcript
window.__codexly.getState().stores.conversation       // homepage History store
window.__codexly.getState().bridge.sessions           // what the fake has persisted

window.__codexly.events.map((event) => event.type)    // bounded product-event log (500)
window.__codexly.events.at(-1)                        // the newest event

window.__codexly.bridge.emitScript('toolUse')         // start a scripted turn now
window.__codexly.bridge.emitScript('toolUse', { pauseAfter: 3 })  // …frozen after 3 frames
window.__codexly.bridge.pause()                       // freeze the player where it is
window.__codexly.bridge.step()                        // publish exactly one frame, stay frozen
window.__codexly.bridge.resume()                      // let the turn run to its terminal
window.__codexly.bridge.setDelay(0)                   // stream the rest instantly
window.__codexly.bridge.capture()                     // queue one more screenshot
window.__codexly.bridge.stopTurn('turn-1')            // stop a live turn
window.__codexly.bridge.emitOverlayOpened({ fresh: true })
window.__codexly.bridge.emit({ type: 'sessions.changed' })   // any contract event
window.__codexly.bridge.emitSubscription({ type: 'session.changed', session })
window.__codexly.bridge.state()                       // settings, sessions, attachments, live turns
```

`stores` is populated by the real zustand stores, which register themselves in a
dev-only registry (`globalThis.__codexlyDevStores`) — so `getState()` reports the
same machine state the UI is rendering, not a copy.

The fake honours the main process' sequencing rules: `conversation.started`
carries no sequence, every later turn-scoped event is numbered contiguously from
1, and `transcriptSnapshot(turnId)` answers with the authoritative prefix at that
moment (including content a `transcript.gap` hid from the stream), so the
gap/re-sync path genuinely runs in the browser.

### Testing UI views (for agents and humans)

Because the renderer is fully decoupled from Electron, **any UI state is a URL**,
and verifying visual work is the same loop as verifying logic:

1. `preview_start` with `name: "harness"` (from `.claude/launch.json`).
2. `navigate` to the state you want to look at.
3. Assert it three ways, cheapest first:
   - `read_page` / `get_page_text` — structure and visible text;
   - `javascript_tool` — the real machine/store state behind the pixels;
   - `computer {screenshot}` — the pixels themselves.

```js
JSON.stringify(window.__codexly.getState().stores.overlay.turn)
JSON.stringify(window.__codexly.events.map((event) => event.type))
```

**Settled states** — append `delay=0`: the turn completes instantly and the page
shows the final answer. Good for "does the finished view look right".

**Frozen mid-stream states** — append `pauseAfter=<n>`: the player publishes
exactly n frames and stops, so the page holds a *stable* mid-stream state
(reasoning disclosure open, half an answer, a running tool row) that a
screenshot can capture deterministically. `pauseAfter=0` freezes in the
pre-first-token "thinking" state — the one where the Stop button must already
work. From there, `bridge.step()` advances frame by frame (screenshot each
step to walk a whole turn visually) and `bridge.resume()` lets it finish.

```text
/?role=overlay&scenario=toolUse&pauseAfter=4        # tool running, no answer yet
/?role=overlay&scenario=reasoningHeavy&pauseAfter=2 # thinking disclosure mid-reasoning
/?role=overlay&scenario=streaming&pauseAfter=0      # pre-first-token, Stop must work
```

**Interactions** — drive the real UI with `computer` (click Stop, type in the
composer, click Solve) and assert the state changed:

```js
// after clicking Stop on a frozen turn:
window.__codexly.getState().stores.overlay.turn.phase   // expect 'idle'
```

Responsive/dark-mode: `resize_window` with a preset and `colorScheme` — the
harness page follows the app's own theming.

Screenshots: the overlay is centered near the top of the page on a checkered
dark backdrop; the badge in the top-right corner tells you which role and
scenario the page installed (it is `aria-hidden` and ignored by `read_page`
text queries).

## Smoke tests

`src/harness/harness.smoke.test.tsx` mounts `<App />` against the same fake
bridge in jsdom (overlay streams to a completed answer with `delay: 0`, the
homepage lists the fixture sessions, a stopped mid-stream turn releases the
composer). `src/harness/fake-bridge.test.ts` covers the fake itself — including a
test that reads `src/types/desktop-bridge.ts` and fails until every declared
bridge method is implemented.
