import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppServer } from '../server.mjs'
import { createStore } from '../lib/store.mjs'

const store = createStore({ dir: mkdtempSync(join(tmpdir(), 'server-test-')) })
const server = createAppServer({
  appid: 'test-appid',
  deps: {
    store,
    search: {},
    buyback: {
      tokenStatus: async () => 'missing',
      masterCount: () => null,
      masterCategories: async () => [{ name: 'スマートフォン', count: 3 }],
      masterIndex: async () => ({ byJan: new Map(), byModel: new Map(), count: 0 }),
      master: async () => [],
      pricesForJans: async () => new Map(),
    },
    pageFetcherFactory: () => ({ source: 'page-anon', fetch: async () => null, close: async () => {} }),
  },
})

let base
await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`
    resolve()
  })
})

afterAll(() => server.close())

describe('server API', () => {
  it('GET /api/presets', async () => {
    const res = await fetch(`${base}/api/presets`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.presets.length).toBeGreaterThan(0)
    expect(body.presets[0]).toHaveProperty('id')
    expect(body.presets[0]).toHaveProperty('genreIds')
    expect(body.masterCategories).toEqual([{ name: 'スマートフォン', count: 3 }])
  })

  it('GET /api/status', async () => {
    const res = await fetch(`${base}/api/status`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.yahooApi).toBe(true)
    expect(body.buybackToken).toBe('missing')
    expect(body.running).toBeNull()
  })

  it('不正な POST /api/scans は 400', async () => {
    const res = await fetch(`${base}/api/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'bogus', deepCheck: 'x' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBeTruthy()
  })

  it('genre で presets 無しも 400', async () => {
    const res = await fetch(`${base}/api/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'genre' }),
    })
    expect(res.status).toBe(400)
  })

  it('JSONでないbodyも400', async () => {
    const res = await fetch(`${base}/api/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
  })

  it('パス走査は拒否する', async () => {
    const res = await fetch(`${base}/../package.json`)
    expect([403, 404]).toContain(res.status)
    const res2 = await fetch(`${base}/%2e%2e/package.json`)
    expect([403, 404]).toContain(res2.status)
  })

  it('reverseLimitの範囲を検証し、deepLimitの既定を120にする', async () => {
    const invalid = await fetch(`${base}/api/scans`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'reverse', masterCategories: ['スマートフォン'], reverseLimit: 2001 }),
    })
    expect(invalid.status).toBe(400)
    const accepted = await fetch(`${base}/api/scans`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'keyword', keyword: 'test' }),
    })
    expect(accepted.status).toBe(202)
    const { id } = await accepted.json()
    let doc
    for (let i = 0; i < 20; i += 1) {
      doc = await store.get(id)
      if (doc) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(doc.params).toMatchObject({ deepLimit: 120, reverseLimit: 300 })
  })

  it('/api/status は直近スキャンのログイン状態を返す', async () => {
    const statusStore = createStore({ dir: mkdtempSync(join(tmpdir(), 'server-status-')) })
    await statusStore.save({ id: '20261003-120000', summary: { loginState: 'premium' }, items: [] })
    const statusServer = createAppServer({ appid: 'test', deps: {
      store: statusStore,
      buyback: { tokenStatus: async () => 'ok', masterCount: () => null },
      search: {},
    } })
    try {
      await new Promise((resolve) => statusServer.listen(0, '127.0.0.1', resolve))
      const res = await fetch(`http://127.0.0.1:${statusServer.address().port}/api/status`)
      expect((await res.json()).phi).toBe('premium')
    } finally {
      await new Promise((resolve) => statusServer.close(resolve))
    }
  })
})
