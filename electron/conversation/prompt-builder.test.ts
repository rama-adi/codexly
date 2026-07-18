import { describe, expect, it } from 'vitest'

import {
  buildDeveloperInstructions,
  buildPrompt,
  buildPromptAttachments,
  DEVELOPER_INSTRUCTIONS,
} from './prompt-builder'

describe('buildPrompt', () => {
  it('separates untrusted user data from locked-down developer instructions', () => {
    const result = buildPrompt({
      message: 'Explain this failure.',
      context: [{ title: 'Logs', content: 'permission denied' }],
      attachments: [
        {
          name: 'screen.png',
          data: Buffer.from([1, 2, 3]),
          mediaType: 'image/png',
        },
      ],
    })

    expect(result.developerInstructions).toBe(DEVELOPER_INSTRUCTIONS)
    expect(result.developerInstructions).toContain('read-only')
    expect(result.developerInstructions).toContain('Do not ask an interactive tool question')
    expect(result.prompt).toContain('<user_message>\nExplain this failure.')
    expect(result.prompt).toContain('<section title="Logs">')
    expect(result.prompt).toContain('"byteLength":3')
  })

  it('passes verified attachment bytes into AI SDK file parts', () => {
    const data = Buffer.from([1, 2, 3])
    expect(
      buildPromptAttachments([
        { name: 'screen.png', data, mediaType: 'image/png' },
      ]),
    ).toEqual([{ type: 'file', data, mediaType: 'image/png' }])
  })

  it('rejects an empty message', () => {
    expect(() => buildPrompt({ message: '   ' })).toThrow(/required/i)
  })

  it('preserves the security posture while layering assistant preferences', () => {
    const instructions = buildDeveloperInstructions({
      mode: 'coding',
      verbosity: 'verbose',
      codingLanguage: 'python',
      responseLanguage: 'Spanish',
      customInstructionsEnabled: true,
      customInstructions: 'Prefer functional style.',
    })

    expect(instructions.startsWith(DEVELOPER_INSTRUCTIONS)).toBe(true)
    expect(instructions).toContain('read-only')
    expect(instructions).toContain('Use python')
    expect(instructions).toContain('step-by-step')
    expect(instructions).toContain('Respond in Spanish')
    expect(instructions).toContain('Prefer functional style.')
  })

  it('omits disabled custom instructions and empty response language', () => {
    const instructions = buildDeveloperInstructions({
      mode: 'question',
      verbosity: 'concise',
      codingLanguage: 'javascript',
      responseLanguage: '',
      customInstructionsEnabled: false,
      customInstructions: 'ignored',
    })

    expect(instructions).toContain('answer only what was asked')
    expect(instructions).not.toContain('Respond in')
    expect(instructions).not.toContain('ignored')
  })
})
