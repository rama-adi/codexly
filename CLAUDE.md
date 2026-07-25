# Codexly

Electron + React overlay for Codex. `electron/` is the main process, `src/renderer/`
is the UI (two roles: `overlay` and `homepage`), `src/shared/` holds the zod
contracts and test fixtures both sides use.

## Commands

```bash
pnpm typecheck        # tsc for the app and the node/electron project
pnpm test             # vitest (unit, property, chaos)
pnpm lint             # eslint, --max-warnings 0
pnpm build            # vite build (must stay free of harness code)
pnpm verify           # all of the above
pnpm dev              # the desktop app
pnpm dev:harness      # the renderer in a browser, no Electron — see docs/testing.md
```

## Testing

See [docs/testing.md](docs/testing.md) for the test layers, the browser harness
(`pnpm dev:harness`, `?role=…&scenario=…`) and its `window.__codexly` inspector.
Use the harness — not a hand-rolled mock — whenever you need to see or drive a UI
state. Any UI state is a URL: `&delay=0` for the settled view, `&pauseAfter=<n>`
to freeze a turn mid-stream for deterministic screenshots, then
`bridge.step()`/`resume()` to walk it forward. Fixtures come from
`src/shared/fixtures/`; never hand-roll a session/settings/event literal.
