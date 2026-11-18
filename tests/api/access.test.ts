// The access gate against guessing: wrong codes are counted per client address by a rate limiter.
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { accessGate, postSession } from '../../worker/auth'
import type { Env } from '../../worker/env'

const ORIGIN = 'https://stepwise.test'

describe('guessing the access code', () => {
  function gate(limit: number) {
    const counts = new Map<string, number>()
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        counts.set(key, (counts.get(key) ?? 0) + 1)
        return { success: counts.get(key)! <= limit }
      },
    }
    const a = new Hono<{ Bindings: Env }>()
    a.use('/api/*', accessGate)
    a.post('/api/session', postSession)
    a.get('/api/projects', (c) => c.json([]))
    const e = { ACCESS_CODE: 'a-long-secret-code', ACCESS_LIMITER: limiter } as unknown as Env
    const signIn = (code: string, ip: string) => a.request(`${ORIGIN}/api/session`, { method: 'POST', body: JSON.stringify({ code }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip } }, e)
    const bearer = (code: string, ip: string) => a.request(`${ORIGIN}/api/projects`, { headers: { authorization: `Bearer ${code}`, 'cf-connecting-ip': ip } }, e)
    return { signIn, bearer, counts }
  }

  it('stops listening to an address after too many wrong codes, even to the right one, and only to that address', async () => {
    const { signIn, bearer, counts } = gate(3)
    for (let i = 0; i < 3; i++) expect((await signIn(`guess-${i}`, '203.0.113.1')).status).toBe(401)
    const over = await bearer('guess-3', '203.0.113.1')
    expect(over.status).toBe(429)
    expect(over.headers.get('Retry-After')).toBe('60')
    // Locked out: the right code is not even compared, on either route.
    expect((await signIn('a-long-secret-code', '203.0.113.1')).status).toBe(429)
    expect((await bearer('a-long-secret-code', '203.0.113.1')).status).toBe(429)
    expect(counts.get('203.0.113.1')).toBe(4)
    // Someone else is not affected, and right codes are never counted.
    expect((await bearer('a-long-secret-code', '203.0.113.2')).status).toBe(200)
    expect((await signIn('a-long-secret-code', '203.0.113.2')).status).toBe(200)
    expect(counts.has('203.0.113.2')).toBe(false)
  })

  it('does not count a request that offers no code at all', async () => {
    const { counts } = gate(1)
    const a = new Hono<{ Bindings: Env }>()
    a.use('/api/*', accessGate)
    a.get('/api/projects', (c) => c.json([]))
    const res = await a.request(`${ORIGIN}/api/projects`, { headers: { 'cf-connecting-ip': '203.0.113.9' } }, { ACCESS_CODE: 'a-long-secret-code', ACCESS_LIMITER: { limit: async () => ({ success: false }) } } as unknown as Env)
    expect(res.status).toBe(401)
    expect(counts.size).toBe(0)
  })
})
