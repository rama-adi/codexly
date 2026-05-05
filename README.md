# Codexly

It's [free-cluely](https://github.com/prat011/free-cluely), but using your Codex sub.

An invisible desktop assistant that provides real-time insights, answers, and support during meetings, interviews, presentations, and professional conversations — powered by your existing OpenAI Codex subscription via OAuth. No API keys, no extra billing.

## 🚀 Quick Start

### Prerequisites
- Node.js installed
- Git installed
- **[Codex CLI](https://github.com/openai/codex)** installed and logged in — Codexly piggybacks on your existing Codex subscription via the OAuth token Codex stores locally. Make sure `codex` is installed, you're logged in, and your sub is active.

### Installation

1. Clone the repository:
```bash
git clone https://github.com/rama-adi/codexly.git
cd codexly
```

2. Install dependencies:
```bash
# If you hit Sharp/Python build errors:
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install --ignore-scripts
npm rebuild sharp

# Otherwise:
npm install
```

3. Make sure Codex is set up:
```bash
codex login
```
That's it — no `.env`, no API keys. Codexly reads the same OAuth token Codex uses.

### Running

#### Development
```bash
npm start
```
Starts the Vite dev server on port 5180 and launches the Electron app.

#### Production build
```bash
npm run dist
```
Built app lands in the `release` folder.

## ⚠️ Notes

1. **Closing the app**:
   - `Cmd + Q` (Mac) or `Ctrl + Q` (Windows/Linux)
   - The X button currently doesn't work (known issue)

2. **If the app doesn't start**:
   - Make sure no other app is using port 5180:
     ```bash
     lsof -i :5180
     kill [PID]
     ```
   - Make sure `codex` is logged in (`codex login`)

3. **Keyboard shortcuts**:
   - `Cmd/Ctrl + B`: Toggle window visibility
   - `Cmd/Ctrl + H`: Take screenshot
   - `Cmd/Ctrl + Enter`: Get solution
   - `Cmd/Ctrl + Arrow keys`: Move window

## 🔧 Troubleshooting

### Sharp/Python build errors
```bash
rm -rf node_modules package-lock.json
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install --ignore-scripts
npm rebuild sharp
```

### General install issues
1. Delete `node_modules` and `package-lock.json`
2. Run `npm install` again
3. Run `npm start`

## Key Features

### Invisible AI assistant
- Translucent, always-on-top window
- Click-through over empty regions
- Hide/show with global hotkeys

### Screenshot analysis
- `Cmd/Ctrl + H` to capture anything on screen
- Auto-analyzed by Codex; terse answers in chat

### Contextual chat
- Chat about whatever's on screen
- Conversation context maintained per session

### Uses your Codex sub
- OAuth token from the Codex CLI — no separate API key
- No extra billing on top of what you already pay

## 📄 License

ISC License — free for personal and commercial use.

---

**⭐ Star the repo if Codexly helps you out.**
