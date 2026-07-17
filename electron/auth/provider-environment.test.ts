import { describe, expect, it } from 'vitest'

import { createProviderEnvironment } from './provider-environment'

describe('createProviderEnvironment', () => {
  it('passes an API key as a child-process override without mutating process.env', () => {
    const prior = process.env.OPENAI_API_KEY
    const environment = createProviderEnvironment({
      mode: 'api-key',
      apiKey: 'sk-provider',
      revision: 1,
    })

    expect(environment).toEqual({ OPENAI_API_KEY: 'sk-provider' })
    expect(process.env.OPENAI_API_KEY).toBe(prior)
  })

  it('masks an inherited API key in ChatGPT local-login mode', () => {
    expect(
      createProviderEnvironment({
        mode: 'chatgpt-local',
        revision: 0,
      }),
    ).toEqual({ OPENAI_API_KEY: '' })
  })

  it('rejects API-key mode when no key can be decrypted', () => {
    expect(() =>
      createProviderEnvironment({
        mode: 'api-key',
        revision: 2,
      }),
    ).toThrow(/no key/i)
  })
})
