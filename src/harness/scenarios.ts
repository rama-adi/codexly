import type { SessionDetail, SessionSummary, Workspace } from '../renderer/desktop'
import { createFixtureContext, type FixtureContext } from '../shared/fixtures/context'
import { makeAttachment } from '../shared/fixtures/attachments'
import { makeConversation } from '../shared/fixtures/conversations'
import type { TurnRecipeName } from './turn-recipes'

/** The queued-screenshot shape the overlay consumes (`{ id, name, preview }`). */
export interface HarnessAttachment {
  id: string
  name: string
  preview: string
}

/** A 32×20 checkered PNG, so a queued screenshot is actually visible in a browser. */
export const HARNESS_PREVIEW_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAUCAIAAABj86gYAAAANUlEQVR4nGOI6bsGR2Z2fnBELXGGUQsIWkALQ5HFRy0gbMHQT0VD34Khn4qGvgVDPxUNeQsAOVIirv/gXMoAAAAASUVORK5CYII='

export const HARNESS_SESSION_TITLES = [
  'Why does the overlay stay transparent?',
  'Recovering from a sequence gap',
  'Composition root for the main process',
  'Fixtures for every shared schema',
  'Tool activity rows out of order',
] as const

export interface HarnessScenario {
  readonly name: string
  /** One line, shown in the harness badge and in docs/testing.md. */
  readonly summary: string
  /** The scripted response every turn of this scenario plays. */
  readonly recipe: TurnRecipeName
  /** Start a turn as soon as the renderer has attached its event listeners. */
  readonly autoStart: boolean
  readonly sessionCount: number
  readonly attachmentCount: number
  /** Per-frame delay override; the default comes from the installer. */
  readonly delayMs?: number
}

export const HARNESS_SCENARIOS = {
  empty: {
    name: 'empty',
    summary: 'Nothing captured, nothing persisted — the cold-start surface.',
    recipe: 'shortAnswer',
    autoStart: false,
    sessionCount: 0,
    attachmentCount: 0,
  },
  streaming: {
    name: 'streaming',
    summary: 'A short answer streaming into the chat panel.',
    recipe: 'shortAnswer',
    autoStart: true,
    sessionCount: 1,
    attachmentCount: 0,
  },
  longAnswer: {
    name: 'longAnswer',
    summary: 'A long answer, slow enough to watch and to interrupt with Stop.',
    recipe: 'longAnswer',
    autoStart: true,
    sessionCount: 1,
    attachmentCount: 0,
    delayMs: 60,
  },
  reasoningHeavy: {
    name: 'reasoningHeavy',
    summary: 'Reasoning first, answer last — exercises the thinking disclosure.',
    recipe: 'reasoningHeavy',
    autoStart: true,
    sessionCount: 1,
    attachmentCount: 0,
  },
  toolUse: {
    name: 'toolUse',
    summary: 'A shell activity with output, then the answer.',
    recipe: 'toolUse',
    autoStart: true,
    sessionCount: 1,
    attachmentCount: 0,
  },
  error: {
    name: 'error',
    summary: 'A turn that fails mid-answer and surfaces the error banner.',
    recipe: 'failure',
    autoStart: true,
    sessionCount: 1,
    attachmentCount: 0,
  },
  stopMidStream: {
    name: 'stopMidStream',
    summary: 'A turn the script interrupts, ending in the stop presentation.',
    recipe: 'stopMidStream',
    autoStart: true,
    sessionCount: 1,
    attachmentCount: 0,
    delayMs: 120,
  },
  attachments: {
    name: 'attachments',
    summary: 'Three queued screenshots waiting for Solve.',
    recipe: 'toolUse',
    autoStart: false,
    sessionCount: 1,
    attachmentCount: 3,
  },
  resyncGap: {
    name: 'resyncGap',
    summary: 'The transport drops a middle chunk; the UI re-syncs from the snapshot.',
    recipe: 'gapAndResync',
    autoStart: true,
    sessionCount: 1,
    attachmentCount: 0,
  },
  sessions: {
    name: 'sessions',
    summary: 'Four persisted conversations for the homepage History page.',
    recipe: 'shortAnswer',
    autoStart: false,
    sessionCount: 4,
    attachmentCount: 0,
  },
} satisfies Record<string, HarnessScenario>

export type HarnessScenarioName = keyof typeof HARNESS_SCENARIOS

export const HARNESS_SCENARIO_NAMES = Object.keys(HARNESS_SCENARIOS) as HarnessScenarioName[]

export const DEFAULT_HARNESS_SCENARIO: HarnessScenarioName = 'empty'

export const resolveHarnessScenario = (value: string | null): HarnessScenarioName =>
  value !== null && Object.prototype.hasOwnProperty.call(HARNESS_SCENARIOS, value)
    ? (value as HarnessScenarioName)
    : DEFAULT_HARNESS_SCENARIO

const HARNESS_ANSWER = [
  'The overlay renders into a transparent, always-on-top window, so it has no',
  'chrome of its own. In the browser harness it sits on a checkered backdrop',
  'instead, which is the only difference between the two surfaces.',
].join(' ')

/**
 * A persisted session in the main process' shape (`SessionDetail`), composed
 * from the shared conversation fixture so ids, timestamps and message bodies
 * stay deterministic.
 */
export function makeHarnessSession(
  index: number,
  workspaceId: string,
  context: FixtureContext,
): SessionDetail {
  const title = HARNESS_SESSION_TITLES[index % HARNESS_SESSION_TITLES.length]
  const conversation = makeConversation({ title }, context)
  const messages = conversation.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.role === 'user' ? conversation.title : HARNESS_ANSWER,
    attachmentIds: [] as string[],
    createdAt: message.createdAt,
  }))
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    terminalState: 'completed',
    messageCount: messages.length,
    workspaceId,
    messages,
    toolEvents: [],
  }
}

export function makeHarnessWorkspace(context: FixtureContext): Workspace {
  const id = context.nextId('workspace')
  return {
    id,
    title: 'free-cluely',
    canonicalPath: `/Users/harness/${id}`,
    createdAt: context.nextTimestamp(),
    updatedAt: context.nextTimestamp(),
  }
}

export function makeHarnessAttachment(context: FixtureContext): HarnessAttachment {
  const attachment = makeAttachment({ kind: 'screenshot' }, context)
  return {
    id: attachment.id,
    name: `Screenshot ${attachment.id}.png`,
    preview: HARNESS_PREVIEW_PNG,
  }
}

export const summarizeHarnessSession = (session: SessionDetail): SessionSummary => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  terminalState: session.terminalState,
  messageCount: session.messageCount,
})

export interface HarnessInitialState {
  readonly sessions: SessionDetail[]
  readonly workspaces: Workspace[]
  readonly attachments: HarnessAttachment[]
}

/** Everything a scenario seeds the fake bridge with. */
export function createHarnessInitialState(
  scenario: HarnessScenario,
  context: FixtureContext = createFixtureContext(),
): HarnessInitialState {
  const workspace = makeHarnessWorkspace(context)
  return {
    workspaces: [workspace],
    sessions: Array.from({ length: scenario.sessionCount }, (_unused, index) =>
      makeHarnessSession(index, workspace.id, context),
    ),
    attachments: Array.from({ length: scenario.attachmentCount }, () =>
      makeHarnessAttachment(context),
    ),
  }
}
