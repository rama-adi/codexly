# Clean Electron IPC Architecture

This note documents a clean IPC architecture that can be applied to an Electron-only app.
The key idea is to keep Electron IPC as a boundary detail, not something that spreads through
renderer components, domain logic, or shared runtime code.

## Core Principle

Do not let renderer components or reusable runtime modules import Electron, call `ipcRenderer`,
or know about IPC channel names.

Instead, split responsibilities like this:

```text
Electron main process
  owns native capabilities, secrets, filesystem access, OS dialogs, background services,
  and privileged work

Electron preload
  exposes a narrow typed bridge and translates bridge methods into ipcRenderer calls

Renderer app
  calls app-level services such as settingsApi, projectApi, or shellApi
  does not call ipcRenderer directly

Renderer services/runtime
  wrap window.appBridge calls behind domain-specific functions
  expose plain async APIs and state primitives to UI components
```

## Layers

### 1. IPC Contract Layer

Create a small shared module for IPC-facing types and bridge method signatures.

In this repo, `DesktopBridge` lives in:

```text
t3code-main/packages/contracts/src/ipc.ts
```

For your app, this could live under any of these shapes:

```text
electron/shared/ipc.ts
src/electron/ipc-contract.ts
packages/contracts/src/ipc.ts
```

The contract should describe what the renderer is allowed to ask the desktop shell to do:

- read local environment bootstrap data
- manage desktop settings and saved environment secrets
- discover or launch SSH environments
- open OS dialogs and external links
- query server exposure and advertised endpoints
- subscribe to app shell events such as menu actions and update state

This contract is typed, but it is still only a boundary contract. It should not implement IPC,
read files, access Electron globals, or import UI code.

Example:

```ts
export interface AppBridge {
  settings: {
    get: () => Promise<AppSettings>;
    update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  };
  shell: {
    openExternal: (url: string) => Promise<boolean>;
    pickFolder: () => Promise<string | null>;
  };
  projects: {
    list: () => Promise<ProjectSummary[]>;
    open: (id: string) => Promise<ProjectDetails>;
  };
}
```

### 2. Electron Preload Layer

The preload script should be the only renderer-side file that imports Electron IPC APIs.

In this repo:

```text
t3code-main/apps/desktop/src/preload.ts
```

It exposes a safe bridge:

```ts
contextBridge.exposeInMainWorld("appBridge", {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (patch) => ipcRenderer.invoke("settings:update", patch),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
    pickFolder: () => ipcRenderer.invoke("shell:pick-folder"),
  },
});
```

The pattern is:

- one public `window.appBridge` object
- narrow method groups by capability
- private IPC channel strings hidden inside preload/main
- validation or result unwrapping at the boundary when needed
- no UI or domain logic in preload

Preload should translate transport only. If a method starts making product decisions, move that
logic into a renderer service or main-process service.

### 3. Electron Main Layer

The main process owns the privileged implementation behind each IPC channel.

In this repo:

```text
t3code-main/apps/desktop/src/main.ts
```

The main process registers handlers such as:

```ts
ipcMain.handle("settings:get", async () => {
  return settingsService.get();
});

ipcMain.handle("settings:update", async (_event, patch) => {
  return settingsService.update(validateSettingsPatch(patch));
});
```

Main-process handlers should stay thin:

- validate untrusted renderer input
- authorize or reject privileged actions
- call a main-process service
- return plain serializable data

Put filesystem, shell, database, keychain, process, and OS integration here or in services that
are only imported by main.

### 4. Renderer Service Layer

The renderer should not call `window.appBridge` directly from components except in very small apps.
Create renderer-side service modules that wrap the bridge in domain language.

Example:

```ts
// renderer/services/settingsService.ts
export async function loadSettings() {
  return window.appBridge.settings.get();
}

export async function setTheme(theme: Theme) {
  return window.appBridge.settings.update({ theme });
}
```

Components then depend on app services, not IPC:

```ts
const settings = await loadSettings();
await setTheme("dark");
```

This makes components easier to test and keeps IPC details out of the UI tree.

### 5. Renderer Runtime/Domain Layer

Reusable runtime code should accept plain data and plain interfaces.

For example, instead of this:

```ts
import { ipcRenderer } from "electron";

export async function refreshProjects() {
  return ipcRenderer.invoke("projects:list");
}
```

Prefer this:

```ts
export interface ProjectClient {
  listProjects: () => Promise<ProjectSummary[]>;
}

export async function refreshProjects(client: ProjectClient) {
  return client.listProjects();
}
```

Then the Electron renderer wires it up:

```ts
const projectClient: ProjectClient = {
  listProjects: () => window.appBridge.projects.list(),
};
```

This keeps runtime state, caching, models, and business logic independent from Electron transport.

In this repo, `packages/client-runtime` follows this style:

```text
t3code-main/packages/client-runtime
```

It exports portable helpers like:

- `createKnownEnvironment`
- `attachEnvironmentDescriptor`
- `getKnownEnvironmentHttpBaseUrl`
- `getKnownEnvironmentWsBaseUrl`
- `createAdvertisedEndpoint`
- `normalizeHttpBaseUrl`
- `deriveWsBaseUrl`
- scoped project/thread key helpers
- source-control discovery state primitives

It does not know where the data came from. In your Electron-only app, the data may always
originate from IPC, but shared runtime code still should not know that.

That separation is the point.

## Data Flow Example

Loading settings:

```text
settings component mounts
  -> renderer settingsService.loadSettings()
  -> window.appBridge.settings.get()
  -> preload calls ipcRenderer.invoke("settings:get")
  -> main handler validates request context
  -> main settingsService reads disk/store/keychain
  -> plain AppSettings returned to renderer
  -> renderer state updates
```

Opening a project:

```text
project list item clicked
  -> renderer projectService.openProject(id)
  -> window.appBridge.projects.open(id)
  -> preload calls ipcRenderer.invoke("projects:open", id)
  -> main validates id and loads project
  -> main returns ProjectDetails
  -> renderer runtime normalizes/caches the project data
```

## Design Rules For Your App

Use these rules when copying the architecture.

1. Keep Electron imports out of renderer components and shared runtime modules.
2. Put IPC channel strings in preload/main, not in UI components.
3. Define a typed bridge contract that describes capabilities, not transport details.
4. Expose one narrow `window.appBridge` object from preload.
5. Group bridge methods by domain, such as `settings`, `projects`, `shell`, and `updates`.
6. Add renderer services that wrap `window.appBridge` before UI components use it.
7. Convert bridge results into domain models as soon as they enter renderer services.
8. Let runtime modules depend on plain TypeScript types and small client interfaces.
9. Pass capability clients into runtime state managers instead of importing platform APIs.
10. Keep secrets, filesystem access, shell commands, databases, and OS dialogs in main.
11. Validate all renderer-provided input in main before doing privileged work.
12. Return serializable data only. Avoid leaking class instances, Electron objects, or handles.

## Suggested Folder Shape

```text
electron
  shared
    ipc.ts                    # AppBridge and IPC data types
    channels.ts               # optional private channel constants
  main
    index.ts                  # app bootstrap
    ipc.ts                    # ipcMain handler registration
    services
      settingsService.ts      # filesystem/store/keychain work
      projectService.ts       # privileged project operations
      shellService.ts         # dialogs, openExternal, OS integration
  preload
    index.ts                  # contextBridge + ipcRenderer translation
  renderer
    global.d.ts               # window.appBridge typing
    services
      settingsService.ts      # renderer-friendly domain API
      projectService.ts
    runtime
      projectState.ts         # state managers that accept plain clients/data
      models.ts               # serializable domain models
    components
      SettingsPanel.tsx       # calls renderer services, not IPC
```

If the app is large, move `shared` and `runtime` into packages:

```text
packages/contracts
packages/renderer-runtime
electron/main
electron/preload
electron/renderer
```

## Anti-Patterns

Avoid these:

- importing `electron` from React/Vue/Svelte components
- importing `electron` from renderer runtime/state modules
- calling `ipcRenderer` directly inside React components
- passing raw IPC channel names around the app
- making shared runtime helpers read `window.appBridge`
- putting business logic in preload
- letting main handlers become large, unvalidated command routers
- returning mutable main-process objects to the renderer
- using `sendSync` unless startup ordering truly requires it
- exposing generic methods like `invoke(channel, ...args)` to the renderer

## Why This Works

This architecture keeps each layer honest:

- Electron main handles privileged host integration.
- The preload script is a narrow transport adapter.
- Renderer services speak domain language.
- UI components do not know IPC exists.
- Runtime modules only model data, clients, and state.

The result is cleaner IPC, smaller security boundaries, easier tests, and renderer code that is
not welded to Electron transport details.
