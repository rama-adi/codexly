# Codexly

It's [free-cluely](https://github.com/prat011/free-cluely), but using your Codex sub.

A desktop assistant that sits invisibly on top of whatever you're doing. Screenshot the screen, ask a question, get an answer — powered by your existing OpenAI Codex subscription. No API keys, no extra billing.

Codexly is an Electron app with two surfaces:

- **The overlay** — a floating, always-on-top HUD: a command bar, a screenshot queue, a streaming answer panel and a chat panel. It never takes keyboard focus, so the app you're actually working in keeps it.
- **The home window** — sessions history, personalization, and settings.

## Requirements

- **Node.js 24.18+** (`>=24.18.0 <25`) and **pnpm 10.32.1** (`corepack enable` picks this up from `package.json`)
- **macOS, Linux, or Windows** on x64 or arm64
- **A Codex login.** The Codex binary itself is bundled (`@openai/codex`, pinned to 0.144.5) so you don't need to install the CLI separately — but Codexly runs it in ChatGPT local-login mode by default, which reads the credentials Codex stores on this machine. If you've never logged in, run `codex login` once, or save a key under **Settings → API key** instead.

On macOS you'll also be asked for **Screen Recording** permission the first time you capture.

## Getting started

```bash
git clone https://github.com/rama-adi/codexly.git
cd codexly
pnpm install
pnpm dev
```

`pnpm dev` starts the Vite dev server and launches Electron against it.

## Shortcuts

These are global (they work while another app is focused) and rebindable under **Settings → Keyboard shortcuts** — click a shortcut and press the keys you want.

| Action | Default | What it does |
| --- | --- | --- |
| Show overlay | `Cmd/Ctrl + Shift + Space` | Bring the overlay to the front, starting a fresh session |
| Toggle overlay | `Cmd/Ctrl + Shift + B` | Show the overlay, or hide it and return to the home window |
| Capture display | `Cmd/Ctrl + Shift + 1` | Screenshot the display under the cursor and queue it |
| Capture selection | `Cmd/Ctrl + Shift + 2` | Draw a region to screenshot and queue it |
| Solve | `Cmd/Ctrl + Shift + Enter` | Send everything in the queue to the assistant |

## How it hangs together

```
electron/          main process
  app/             product controller — the app's single source of truth
  windows/         window manager, overlay/home window options, saved bounds
  capture/         display capture, region selection, attachment store
  conversation/    Codex app-server provider, turn controller, event normalizer
  auth/            credential store (safeStorage-encrypted API keys)
  persistence/     atomic JSON stores for settings, sessions, workspaces
  ipc/             validated IPC surface
src/
  renderer/overlay/    the floating HUD (store + turn state machine + components)
  renderer/homepage/   the home window
  shared/              Zod schemas and IPC contracts shared across processes
```

A few things worth knowing if you're poking at the code:

- **The renderer picks its surface from the URL.** `?role=overlay` renders the overlay, anything else renders the home window (`src/renderer/roles.ts`), so both windows load the same bundle.
- **Every IPC payload is Zod-validated on both sides** and every sender is checked against an allowlist (`electron/ipc/`).
- **The overlay models a turn as an explicit state machine** (`src/renderer/overlay/machine/`) rather than a pile of booleans, which is what keeps a cancelled or failed turn from leaving the HUD stuck.
- **Stealth mode is on by default** — the overlay sets content protection, so it's excluded from screen recordings and screenshots. Turn it off under **Settings → Tools & privacy** if you're trying to demo it.
- **Overlay styling is Tailwind.** The HUD palette lives as theme tokens (`hud-*`) in `src/index.css`; `src/renderer/overlay/overlay.css` holds only what utilities can't express (Streamdown's markdown output, scrollbars, the focus ring).

## Development

```bash
pnpm dev          # Vite + Electron, with HMR on the renderer
pnpm test         # unit tests (vitest)
pnpm test:watch
pnpm test:e2e     # Playwright, drives the real Electron app
pnpm typecheck    # app + node tsconfigs
pnpm lint
pnpm verify       # typecheck + lint + test + build — run before packaging
```

## Packaging

```bash
pnpm pack         # unpacked build, for a quick local check
pnpm dist         # distributable in release/
```

Both run `pnpm verify` first, then `pnpm prepare:codex`, which copies the pinned Codex native binary for **the current platform and architecture** into `.packaging/codex`. That means you have to build on the architecture you're shipping to — cross-building isn't supported.

## Notes

- Quit with `Cmd + Q` / `Ctrl + Q`.
- Sessions, settings, and captured screenshots live in the app's own user-data directory. Screenshots only leave the machine as part of a Codex turn.
- An API key you save is encrypted with Electron's `safeStorage`; it is never written to settings in plaintext.

---

**⭐ Star the repo if Codexly helps you out.**
