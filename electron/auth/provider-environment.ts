import type { ProviderCredentialSnapshot } from './credential-store'

export type ProviderEnvironment = Record<string, string> & {
  readonly OPENAI_API_KEY: string
}

/**
 * Returns overrides for the Codex child process. It never mutates process.env.
 * An empty key deliberately prevents an inherited shell API key from changing
 * ChatGPT local-login mode.
 */
export function createProviderEnvironment(
  credentials: ProviderCredentialSnapshot,
): ProviderEnvironment {
  if (credentials.mode === 'api-key') {
    if (!credentials.apiKey) {
      throw new Error('API-key authentication is selected but no key is available')
    }
    return { OPENAI_API_KEY: credentials.apiKey }
  }

  return { OPENAI_API_KEY: '' }
}
