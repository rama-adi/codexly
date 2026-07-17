# Codexly

Codexly is a desktop toolbar for asking Codex about what is on your screen. It
uses the local Codex CLI app-server, so it runs through your existing Codex
login instead of a separate API key or billing setup.

It can run in two launch modes:

- **Direct**: start Codexly without a working directory. Codex answers from the
  prompt, screenshots, chat history, and its own knowledge.
- **Directory**: import a local folder, save it as a launch profile, and start
  Codexly with that folder as the Codex working directory.

## Current Features

- Always-on-top toolbar for screenshots, solving, chat, settings, reset, and
  clearing the current buffer.
- Full-screen and selected-area screenshot capture.
- Native image-capable Codex models. Screenshots are sent directly to Codex.
- Chat and answer views backed by the active Codex session.
- Markdown rendering for assistant answers and history.
- Session history with embedded screenshot previews.
- Saved directory profiles with editable labels and open-in-Finder support.
- Prewarmed Codex startup state on the home screen.
- Settings for Codex model, model-provided reasoning effort options, and stealth
  screenshot behavior.

## Prerequisites

- Node.js
- Git
- [Codex CLI](https://github.com/openai/codex) installed, logged in, and
  available as `codex` on your `PATH`

Run this once if Codex is not already authenticated:

```bash
codex login
```

Codexly does not require a `.env` file or OpenAI API key.

## Install

```bash
git clone https://github.com/rama-adi/codexly.git
cd codexly
npm install
```

If Sharp fails to build on install:

```bash
rm -rf node_modules package-lock.json
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install --ignore-scripts
npm rebuild sharp
```

## Run

Development:

```bash
npm start
```

This starts Vite on port `5180` and launches the Electron app.

Production build:

```bash
npm run dist
```

Packaged builds are written to `release/`.

## Usage

1. Open Codexly.
2. Launch **Direct**, or add a directory and launch from that saved profile.
3. Use the toolbar to capture screenshots, solve, chat, or reset the session.
4. Use **History** to continue or inspect previous persisted sessions.

Launching from Home starts a new session. Continue old sessions from History.
Empty new sessions are not persisted.

## Keyboard Shortcuts

Global shortcuts:

- `Cmd/Ctrl + B`: show or hide the toolbar
- `Cmd/Ctrl + Shift + Space`: center and show the toolbar

Toolbar-only shortcuts:

- `Cmd/Ctrl + H`: capture the screen
- `Cmd/Ctrl + Shift + H`: capture a selected area
- `Cmd/Ctrl + Enter`: solve the current screenshot buffer
- `Cmd/Ctrl + K`: clear the current screenshot buffer and close open panes
- `Cmd/Ctrl + R`: reset the active session
- `Cmd/Ctrl + Arrow keys`: move the toolbar

Toolbar-only shortcuts are registered only while the toolbar is visible.

## Settings

- **Model**: loaded from Codex via `model/list`; only image-capable models are
  shown.
- **Reasoning effort**: shown as model-provided options with descriptions when
  Codex returns them.
- **Stealth behavior**: hides/protects the overlay during screenshot capture.

## Troubleshooting

### Codex model list is unavailable

Make sure the Codex CLI is installed, logged in, and reachable:

```bash
codex login
codex --version
```

Codexly talks to Codex through the AI SDK `ai-sdk-provider-codex-cli` package.
The provider uses your `codex login` credentials and manages the local Codex
app-server process for streaming chat.

### App does not start

Port `5180` may already be in use:

```bash
lsof -i :5180
kill <PID>
```

Then run:

```bash
npm start
```

### Screenshots do not work on macOS

Grant Screen Recording permission to the app under:

`System Settings > Privacy & Security > Screen Recording`

Then quit and reopen Codexly.

## Development Scripts

- `npm start`: run Vite and Electron for development
- `npm run dev`: run only the Vite dev server
- `npm run electron:dev`: compile Electron and run it against the dev server
- `npm run build`: type-check and build the renderer
- `npm run electron:build`: compile Electron for production
- `npm run dist`: build and package with electron-builder

## License

ISC License.
