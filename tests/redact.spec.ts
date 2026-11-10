import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../src/redact.js'

describe('redactSecrets', () => {
  it('removes the exact live API key wherever it appears', () => {
    const key = 'ZDM4YTYzOGYtYjM3Ny00YTNkLWJhZmItMGYwNTc0'
    const text = `relay error: invalid key ZDM4YTYzOGYtYjM3Ny00YTNkLWJhZmItMGYwNTc0 provided`
    expect(redactSecrets(text, key)).not.toContain(key)
    expect(redactSecrets(text, key)).toContain('[REDACTED]')
  })

  it('redacts sk- style keys even when the exact value is unknown', () => {
    const text = 'upstream said: sk-proj-abcdefgh1234567890 is not valid'
    expect(redactSecrets(text)).toBe('upstream said: [REDACTED] is not valid')
  })

  it('redacts Google-style keys', () => {
    // Assembled from fragments so secret scanners do not flag the fixture itself.
    const fakeGoogleKey = ['AIza', 'Sy', 'SampleKey1234', 'UsedOnlyInTests'].join('')
    const text = `request failed for key ${fakeGoogleKey}`
    expect(redactSecrets(text)).not.toContain('AIza')
  })

  it('redacts Bearer authorization values echoed in error bodies', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 expired'
    expect(redactSecrets(text)).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
  })

  it('redacts echoed key/value pairs', () => {
    for (const text of [
      '{"error":"invalid api_key: abcdef1234567890"}',
      'config: api-key=abcdef1234567890 rejected',
      'invalid token "abcdef1234567890"',
    ]) {
      expect(redactSecrets(text)).not.toContain('abcdef1234567890')
    }
  })

  it('leaves ordinary error text untouched', () => {
    const text = 'Request failed with status 429: rate limit exceeded, retry after 30s'
    expect(redactSecrets(text)).toBe(text)
  })

  it('ignores secrets too short to be distinguishable', () => {
    expect(redactSecrets('the key abc was rejected', 'abc')).toBe('the key abc was rejected')
  })
  it('redacts URL userinfo but leaves ordinary URLs, paths and emails readable', () => {
    expect(redactSecrets('GET https://user:password@relay.example/v1 failed')).toBe('GET https://[REDACTED]@relay.example/v1 failed')
    expect(redactSecrets('from //token@cdn.example/a.png')).toBe('from //[REDACTED]@cdn.example/a.png')
    expect(redactSecrets('https://cdn.example/@user/a.png and mail me@example.com')).toBe('https://cdn.example/@user/a.png and mail me@example.com')
  })
})
