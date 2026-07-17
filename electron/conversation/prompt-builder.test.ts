import { describe, expect, it } from 'vitest'

import {
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
})
