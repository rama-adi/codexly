# Rewrite LLM Handler To Use Codex Client Fully

The current app has a rag-tag Codex backend implementation inherited from earlier work. The goal is to replace it with a cohesive Codex client/server integration, simplify response generation to streamed markdown, clean up rendering, and add durable personalization and chat history.

Use `t3code-main` in this repo as the reference implementation for how to wrap and talk to the Codex app server. The Codex app server is the backend powering the Codex app and CLI. We should copy/adapt the clean parts of that integration instead of continuing to use undocumented Codex auth and endpoint behavior.

## Start Here

Do not spend time rediscovering the app structure. These are the files and directories to inspect first.

Current app files to change:

1. `electron/LLMHelper.ts`
   - Current rag-tag LLM implementation.
   - Contains `generateObject`, `generateText`, `openai-oauth-provider`, undocumented `chatgpt.com/backend-api/codex/*` model discovery, in-memory `chatHistory`, prompt construction, and model selection.
   - This is the main replacement target.
2. `electron/ProcessingHelper.ts`
   - Current screenshot-to-problem-to-solution flow.
   - Calls `extractProblemFromImages`, `analyzeImageFiles`, `generateSolution`, and emits `SOLUTION_SUCCESS`.
   - Replace the two-step extraction/object generation path with one streamed markdown response path.
3. `electron/AppSettings.ts`
   - Current settings schema and persistence.
   - Currently writes to `~/.codexlysetting.json`; replace with app setting folder storage modeled after `t3code-main`.
   - Extend this or split out storage modules for personalization and history.
4. `electron/ipcHandlers.ts`
   - IPC boundary for screenshots, chat, settings, model management, reset, and window actions.
   - Add/update handlers for streamed answer events, personalization, chat history, reset/new session, and directory base selection.
5. `electron/preload.ts`
   - Renderer API surface.
   - Keep this in sync with new IPC handlers and streamed markdown events.
6. `electron/main.ts`
   - App state, screenshot queues, reset behavior, and processing events.
   - Adjust active session lifecycle here if that fits the current ownership.
7. `electron/ScreenshotHelper.ts`
   - Screenshot queue and image preview behavior.
   - Use when deciding how screenshot paths are represented in history JSON.
8. `src/_pages/toolbar/Solutions.tsx`
   - Current solution renderer.
   - Convert to one streamed markdown answer display.
9. `src/_pages/toolbar/Queue.tsx`
   - Current screenshot/input queue UI.
   - Keep this focused on the already-launched toolbar interaction. Do not make it the main configuration surface.
10. `src/_pages/toolbar/Debug.tsx`
    - Current debug/update solution UI.
    - Remove, fold into the unified chat/session flow, or make unreachable if obsolete.
11. `src/_pages/main-activity/MainActivityLayout.tsx`
    - Sidebar/page layout.
    - Add `Personalization` and `History` sidebar links here.
12. `src/_pages/main-activity/Settings.tsx`
    - Existing settings UI and settings patterns.
    - Reuse local UI conventions for launcher settings, directory/base path setup, and the new personalization page.
13. `src/_pages/main-activity/Home.tsx`
    - Existing main activity page.
    - Main activity is the launcher. Working directory/base directory setup and all launch-time settings should be configured here or in main-activity pages, then passed into the toolbar at launch.
14. `src/App.tsx`
    - Current route registration.
    - Add routes for the new main activity pages.
15. `src/types/electron.d.ts` and `src/types/global.d.ts`
    - Renderer-facing Electron API types.
    - Update when preload APIs change.
16. `src/types/solutions.ts`
    - Current object-shaped solution type.
    - Remove, replace, or narrow if the app no longer uses object-generated solutions.
17. `src/components/ChatHistoryButton.tsx`
    - Current localStorage-based history UI.
    - Replace with the new Electron-backed history page, or delete if obsolete.

Reference files in `t3code-main`:

1. `t3code-main/apps/desktop/src/main.ts`
   - Shows how `t3code-main` resolves its app setting folder:
     - `BASE_DIR = process.env.T3CODE_HOME?.trim() || Path.join(OS.homedir(), ".t3")`
     - `STATE_DIR = Path.join(BASE_DIR, "userdata")`
     - settings paths are then built under `STATE_DIR`.
   - Also has `desktop:pick-folder` IPC and folder picker behavior to copy for directory base selection.
2. `t3code-main/apps/desktop/src/clientPersistence.ts`
   - JSON persistence helpers for client settings and saved records.
   - Copy the atomic JSON write pattern:
     - create parent directory
     - write to temp file
     - rename temp file into place
   - Use this pattern for personalization config, history index, and session JSON files.
3. `t3code-main/apps/desktop/src/desktopSettings.ts`
   - Settings read/write pattern with defaults and tolerant parsing.
   - Good reference for app-level JSON settings.
4. `t3code-main/packages/effect-codex-app-server/src/client.ts`
   - Typed Codex app server client.
   - Use this as the primary reference for how requests, notifications, and handlers are shaped.
5. `t3code-main/packages/effect-codex-app-server/src/protocol.ts`
   - Protocol transport details for the app server.
6. `t3code-main/packages/effect-codex-app-server/src/_generated/namespaces.gen.ts`
   - Generated method names and payload types.
   - Look here for thread/turn methods and streaming notification names.
7. `t3code-main/packages/effect-codex-app-server/src/_generated/schema.gen.ts`
   - Generated schemas for request/notification payloads.
8. `t3code-main/apps/server/src/server.ts`, `t3code-main/apps/server/src/ws.ts`, and `t3code-main/apps/server/src/bootstrap.ts`
   - Reference if the desktop wrapper needs to understand how the app server is started or connected.
9. `t3code-main/apps/web/src/orchestrationEventEffects.ts`
   - Reference for handling streaming/orchestration events in the web UI.
10. `t3code-main/apps/web/src/threadRoutes.ts`, `t3code-main/apps/web/src/historyBootstrap.ts`, and `t3code-main/apps/web/src/store.ts`
    - Reference for thread/history concepts and client-side thread state.

Search terms that should quickly find the relevant reference behavior:

1. In this app: `rg -n "openai-oauth-provider|backend-api/codex|generateObject|generateText|chatHistory|SOLUTION_SUCCESS|clearChatHistory|reset-queues|app-settings" electron src`
2. In `t3code-main`: `rg -n "BASE_DIR|STATE_DIR|client-settings|desktop:pick-folder|ThreadStart|TurnStart|AgentMessageDelta|thread/start|turn/start|CodexAppServerClient" t3code-main`

## Current Problems

1. The app has two modes, coding and Q&A, that use wildly different rendering and generation paths.
2. The mode differences should be prompt changes, not separate object-generation paths.
3. Responses should stream as markdown via `streamText()` or the equivalent Codex client streaming API.
4. Verbosity should also be prompt-only, with rendering handled by the same markdown UI.
5. Rendering in `src/_pages/toolbar` is confusing because there are too many renderer paths. The toolbar should be the toolbar plus a single markdown renderer for the solution answer.
6. History handling is confusing. The user currently has to reset every time they want to feed a new screenshot.
7. Storage is messy. Config and chat history should live in the app setting folder using the same app-setting-folder approach that `t3code-main` uses for itself.
8. The toolbar launch cannot currently take a directory as its base, which is useful when users want to bring their own notes.
9. The app is not using the Codex app server and instead relies on undocumented Codex auth and endpoints.

## Target Architecture

Use the Codex client/server integration from `t3code-main` as the model for the new LLM handler.

The main activity app is the launcher and settings surface. It owns launch-time configuration, including personalization settings, working directory/base directory, model/runtime settings, and any other context needed before opening the toolbar. The toolbar is launched with those settings already resolved.

The toolbar should not become the place where users configure the working directory, personalization, or other launch-level settings. It should consume the launched configuration and focus on capture, input, session continuation, and streamed answer display.

The LLM path should be:

1. Build a prompt from the active chat session, screenshots, user input, personalization config, and optional custom instructions.
2. Send it through the Codex client/server wrapper.
3. Stream markdown text back to the UI.
4. Render the streamed markdown through one markdown renderer.

There should no longer be separate object-generation/rendering behavior for coding vs Q&A. All behavioral differences should come from prompt construction.

## Personalization

Add a new page under `src/_pages/main-activity` for personalization.

The sidebar should reference this page as `Personalization`.

The page should let the user configure:

1. Mode:
   - `question`: simple Q&A. Answer directly and avoid code unless the user explicitly asks for it.
   - `coding`: provide code, implementation guidance, or debugging detail when useful.
2. Verbosity:
   - `concise`: answer only.
   - `verbose`: break down the problem into clear steps and explain the reasoning like a human would.
3. Custom instructions:
   - Optional text field.
   - Add an enable/disable toggle.
   - When enabled, append the custom instructions to the very end of the prompt and clearly denote that they are user-enabled custom instructions.

Persist personalization config in the app setting folder using the same approach `t3code-main` uses to locate its own app settings.

## Chat History

Add a new page under `src/_pages/main-activity` for chat history.

The sidebar should reference this page as `History`.

Expected behavior:

1. When the user first sends a screenshot or message and no active chat session exists, create a new chat session.
2. When the user adds another screenshot and asks to solve, append the screenshot and message to the existing active session.
3. Text-only messages should also append to the active session, or create a new session if none exists.
4. Reset should create a fresh thread/session.
5. Chat history should survive app restarts.
6. The user should be able to see previous sessions in the main activity history page.

Storage shape:

1. Store data in the app setting folder using the same app-setting-folder approach as `t3code-main`.
2. Store one JSON file per chat session under a history folder, using `history/<session-id>.json`.
3. Store a history index JSON file for session titles and summary metadata.
4. Screenshots and other message data can be represented in JSON as appropriate for the current app architecture.

## Toolbar

Clean up `src/_pages/toolbar` so it is focused on:

1. Capture/input controls.
2. Session continuation controls.
3. Streaming markdown answer display.
4. Consuming the launch configuration provided by the main activity launcher.

Remove or make unreachable the confusing duplicate renderers. The toolbar should not have separate renderers for coding vs Q&A.

Directory/base path selection belongs in the main activity launcher flow, not in the toolbar. The toolbar should be launched with the selected working directory/base directory already included in its config.

## Worker Coordination

Spawn subagents/workers for independent areas. The main agent should coordinate them and commit frequently at logical milestones.

Suggested work slices:

1. Study `t3code-main` and implement the Codex client/server wrapper in this app.
2. Replace the current LLM handler with streamed markdown generation.
3. Implement personalization config, prompt construction, and the personalization page.
4. Implement chat session/history persistence and the history page.
5. Add directory/base path support to the main activity launcher flow and pass it into toolbar launch config.
6. Clean up toolbar rendering so it consumes launch config and displays streamed markdown.
7. Document the final architecture and what was fixed.

The main agent should make frequent commits after coherent milestones, not one large final commit.

## Acceptance Criteria

1. The app uses the Codex app server through a cohesive client wrapper modeled after `t3code-main`.
2. Undocumented Codex auth and endpoint usage is removed.
3. All LLM responses stream as markdown.
4. Coding vs Q&A is controlled by prompt configuration only.
5. Concise vs verbose is controlled by prompt configuration only.
6. The toolbar uses one markdown renderer for solution answers.
7. The personalization page exists under `src/_pages/main-activity` and is linked from the sidebar.
8. Mode, verbosity, and custom instruction settings persist in the app setting folder.
9. Custom instructions are appended to the end of the prompt only when enabled.
10. The history page exists under `src/_pages/main-activity` and is linked from the sidebar.
11. First screenshot/message creates a session when none exists.
12. Additional screenshots/messages append to the active session.
13. Reset creates a fresh session.
14. Chat sessions persist as `history/<session-id>.json`.
15. A history index file exists for titles and metadata.
16. History survives app restart and is visible in the main activity history page.
17. Main activity launcher supports choosing or providing a working directory/base directory before launching the toolbar.
18. Toolbar receives and uses the selected working directory/base directory from launch config.
19. Duplicate/obsolete renderers in `src/_pages/toolbar` are removed or made unreachable.
20. The final implementation is documented with what changed and how the new architecture works.
