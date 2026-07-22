import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  authorizeRequestForRole,
  BridgeAccessError,
  parseSupportedRequest,
  validateSenderUrl,
} from '../../electron/ipc/validate-sender'

const rendererFilePath = path.join('/Applications', 'Codexly.app', 'index.html')

const requestBase = {
  version: 1 as const,
  requestId: 'request-1',
  sentAt: '2026-07-18T00:00:00.000Z',
}

describe('sender URL validation', () => {
  it('accepts only the exact renderer target and managed role', () => {
    const sender = new URL(pathToFileURL(rendererFilePath))
    sender.searchParams.set('role', 'homepage')

    expect(() =>
      validateSenderUrl(sender.toString(), 'homepage', { rendererFilePath }),
    ).not.toThrow()
  })

  it.each([
    'https://attacker.example/?role=homepage',
    'file://attacker.example/Applications/Codexly.app/index.html?role=homepage',
    `${pathToFileURL(rendererFilePath).toString()}?role=overlay`,
    `${pathToFileURL(rendererFilePath).toString()}?role=homepage&debug=1`,
  ])('rejects an untrusted or role-mismatched sender: %s', (senderUrl) => {
    expect(() =>
      validateSenderUrl(senderUrl, 'homepage', { rendererFilePath }),
    ).toThrowError(BridgeAccessError)
  })
})

describe('managed window role authorization', () => {
  it('rejects overlay subscriptions outside its targeted topics', () => {
    const request = parseSupportedRequest({
      ...requestBase,
      operation: 'subscriptions.subscribe',
      payload: { topics: ['auth'] },
    })

    expect(() => authorizeRequestForRole('overlay', request)).toThrowError(
      /cannot subscribe to the auth topic/i,
    )
  })
})

describe('strict request parsing', () => {
  it.each([
    {
      ...requestBase,
      operation: 'bootstrap.get',
      payload: { unexpected: true },
    },
    {
      ...requestBase,
      operation: 'subscriptions.subscribe',
      payload: { topics: ['windows'], arbitrary: 'value' },
    },
    {
      ...requestBase,
      operation: 'windows.get',
      payload: {},
    },
  ])('rejects malformed or unsupported requests', (request) => {
    expect(() => parseSupportedRequest(request)).toThrowError(
      /does not match a supported contract/i,
    )
  })
})

describe('renderer document security policy', () => {
  it('restricts executable content while allowing packaged assets and Vite HMR', () => {
    const document = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../index.html'),
      'utf8',
    )
    expect(document).toContain('http-equiv="Content-Security-Policy"')
    expect(document).toContain("default-src 'self'")
    expect(document).toContain("script-src 'self'")
    expect(document).toContain("object-src 'none'")
    expect(document).toContain("base-uri 'none'")
    expect(document).not.toContain("script-src 'self' 'unsafe-inline'")
  })
})
