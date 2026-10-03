// ダッシュボード用サーバー。node:http のみ（フレームワークなし）。
// public/ の静的配信 + /api。127.0.0.1:${PORT||4173} で待つ。

import { createServer as createHttpServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, normalize, resolve, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

import { PRESETS } from './lib/presets.mjs'
import { runScan } from './lib/scan.mjs'
import { createSearchClient } from './lib/yahoo-search.mjs'
import { createBuybackClient } from './lib/buyback.mjs'
import { createPageFetcher } from './lib/item-page.mjs'
import { createStore } from './lib/store.mjs'
import { PHI_SHADOW_PATH } from './lib/paths.mjs'

const PUBLIC_DIR = resolve(import.meta.dirname, 'public')
const PORT = Number(process.env.PORT) || 4173
const HOST = '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
}

const scanBodySchema = z
  .object({
    mode: z.enum(['genre', 'keyword', 'reverse']).default('genre'),
    presets: z.array(z.string()).default([]),
    keyword: z.string().default(''),
    sellerId: z.string().default(''),
    priceFrom: z.number().int().min(0).nullable().default(null),
    priceTo: z.number().int().min(0).nullable().default(null),
    masterCategories: z.array(z.string()).default([]),
    minBuyback: z.number().int().min(0).default(0),
    deepCheck: z.enum(['phi', 'anon', 'off']).default('off'),
    deepLimit: z.number().int().positive().max(500).default(120),
    reverseLimit: z.number().int().min(1).max(2000).default(300),
  })
  .superRefine((v, ctx) => {
    const add = (message) => ctx.addIssue({ code: 'custom', message })
    if (v.mode === 'genre' && v.presets.length === 0) add('genre モードには presets が必要です')
    if (v.mode === 'keyword' && !v.keyword && !v.sellerId)
      add('keyword モードには keyword か sellerId が必要です')
    if (v.mode === 'reverse' && v.masterCategories.length === 0)
      add('reverse モードには masterCategories が必要です')
    for (const p of v.presets) {
      if (!PRESETS.some((x) => x.id === p)) add(`未知のプリセット: ${p}`)
    }
    if (v.priceFrom != null && v.priceTo != null && v.priceFrom >= v.priceTo)
      add('priceFrom は priceTo より小さくしてください')
  })

// deps はテストで差し替えられるよう引数で受ける。省略時は実装を作る。
export function createAppServer({ deps = {}, appid = process.env.YAHOO_CLIENT_ID } = {}) {
  const log = (m) => process.stderr.write(`${m}\n`)
  const store = deps.store || createStore({})
  const buyback = deps.buyback || createBuybackClient({ log })
  const search =
    deps.search || (appid ? createSearchClient({ appid, log }) : null)
  const pageFetcherFactory =
    deps.pageFetcherFactory || (({ mode }) => createPageFetcher({ mode, log }))

  const runs = new Map() // id → { rec }（実行中・直近終了をメモリに保持）
  let running = null
  let phiState = null // null=未確認 / 'ok' / 'unavailable'

  async function phiStatus() {
    if (phiState) return phiState
    return existsSync(PHI_SHADOW_PATH) ? 'unknown' : 'unavailable'
  }

  async function statusPhi() {
    const latest = [...runs.values()].at(-1)?.doc || (await store.list())[0]
    return latest?.summary?.loginState || phiStatus()
  }

  function startScan(params) {
    const id = params.id
    const controller = new AbortController()
    const rec = {
      id,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      params,
      events: [],
      listeners: new Set(),
      doc: null,
      controller,
    }
    runs.set(id, rec)
    running = rec
    const onEvent = (ev) => {
      rec.events.push(ev)
      for (const fn of rec.listeners) {
        try {
          fn(ev)
        } catch {}
      }
    }
    const depsForScan = {
      search,
      buyback,
      store,
      now: () => new Date(),
      pageFetcherFactory: ({ mode }) => {
        const f = pageFetcherFactory({ mode })
        const origFetch = f.fetch.bind(f)
        f.fetch = async (url) => {
          const r = await origFetch(url)
          phiState = f.source === 'page-login' ? 'ok' : mode === 'phi' ? 'unavailable' : phiState
          return r
        }
        return f
      },
    }
    runScan({ ...params, id }, { deps: depsForScan, onEvent, signal: controller.signal })
      .then((doc) => {
        rec.doc = doc
        rec.status = doc.status
        rec.finishedAt = doc.finishedAt
      })
      .catch((e) => {
        rec.status = 'error'
        rec.finishedAt = new Date().toISOString()
        onEvent({ type: 'error', message: e?.message || String(e) })
      })
      .finally(() => {
        if (running === rec) running = null
      })
    return { rec, controller }
  }

  const json = (res, code, obj) => {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const c of req) {
      size += c.length
      if (size > 1024 * 1024) throw new Error('body too large')
      chunks.push(c)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  async function serveStatic(res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname
    // パス走査を防ぐ: 正規化して public/ 配下に収まるものだけ配信
    const filePath = normalize(join(PUBLIC_DIR, rel))
    if (!filePath.startsWith(PUBLIC_DIR + '/') && filePath !== PUBLIC_DIR) {
      return json(res, 403, { error: 'forbidden' })
    }
    try {
      const data = await readFile(filePath)
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' })
      res.end(data)
    } catch {
      json(res, 404, { error: 'not found' })
    }
  }

  function sse(res, rec) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    const send = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
    const ping = setInterval(() => res.write(': ping\n\n'), 15000)
    const listener = (ev) => send(ev)
    // これまでのイベントを再生（終了済みなら done まで即届く）
    for (const ev of rec.events) send(ev)
    if (rec.status === 'running') rec.listeners.add(listener)
    res.on('close', () => {
      clearInterval(ping)
      rec.listeners.delete(listener)
    })
  }

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname
    try {
      // ---- API ----
      if (path === '/api/status' && req.method === 'GET') {
        return json(res, 200, {
          yahooApi: !!appid,
          phi: await statusPhi(),
          buybackToken: await buyback.tokenStatus(),
          masterCount: buyback.masterCount?.() ?? null,
          running: running?.id ?? null,
        })
      }

      if (path === '/api/presets' && req.method === 'GET') {
        let masterCategories = []
        try {
          // ローカルトークンが無い時にブラウザ復旧へ行かないよう fast 経路
          masterCategories = await buyback.masterCategories({ fast: true })
        } catch {}
        return json(res, 200, { presets: PRESETS, masterCategories })
      }

      if (path === '/api/scans' && req.method === 'POST') {
        if (!appid) {
          return json(res, 400, {
            error: 'YAHOO_CLIENT_ID が未設定です。環境変数を設定してサーバーを再起動してください。',
          })
        }
        if (running) {
          return json(res, 409, { error: '別のスキャンが実行中です', running: running.id })
        }
        let body
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch {
          return json(res, 400, { error: 'JSONの解析に失敗しました' })
        }
        const parsed = scanBodySchema.safeParse(body)
        if (!parsed.success) {
          const msg = parsed.error.issues.map((i) => i.message).join(' / ')
          return json(res, 400, { error: msg })
        }
        const id = await store.nextId()
        startScan({ ...parsed.data, id })
        return json(res, 202, { id })
      }

      const scanMatch = path.match(/^\/api\/scans\/([0-9A-Za-z-]+)(\/events|\/cancel)?$/)
      if (scanMatch) {
        const [, id, sub] = scanMatch
        if (sub === '/events' && req.method === 'GET') {
          const rec = runs.get(id)
          if (rec) return sse(res, rec)
          const doc = await store.get(id)
          if (!doc) return json(res, 404, { error: 'scan not found' })
          // 終了済み: done を即送る
          return sse(res, {
            status: doc.status,
            events: [
              { type: 'done', id: doc.id, status: doc.status, summary: doc.summary },
            ],
            listeners: new Set(),
          })
        }
        if (sub === '/cancel' && req.method === 'POST') {
          const rec = runs.get(id)
          if (rec?.status === 'running') rec.controller?.abort?.()
          return json(res, 200, { ok: true })
        }
        if (!sub && req.method === 'GET') {
          const rec = runs.get(id)
          if (rec?.doc) return json(res, 200, rec.doc)
          const doc = await store.get(id)
          if (!doc) return json(res, 404, { error: 'scan not found' })
          return json(res, 200, doc)
        }
        if (!sub && req.method === 'DELETE') {
          runs.delete(id)
          const ok = await store.remove(id)
          return json(res, ok ? 200 : 404, { ok })
        }
      }

      if (path === '/api/scans' && req.method === 'GET') {
        const scans = await store.list()
        if (running && !scans.some((s) => s.id === running.id)) {
          scans.unshift({
            id: running.id,
            status: 'running',
            startedAt: running.startedAt,
            finishedAt: null,
            params: running.params,
            summary: null,
          })
        }
        return json(res, 200, { scans })
      }

      if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' })

      // ---- 静的配信（public/ 配下のみ） ----
      if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(res, path)
      return json(res, 405, { error: 'method not allowed' })
    } catch (e) {
      return json(res, 500, { error: e?.message || String(e) })
    }
  })

  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createAppServer()
  server.listen(PORT, HOST, () => {
    process.stderr.write(`Yahoo!ショッピング利益商品発掘ツール: http://${HOST}:${PORT}\n`)
    if (!process.env.YAHOO_CLIENT_ID) {
      process.stderr.write('⚠ YAHOO_CLIENT_ID が未設定です（検索はできません。/api/status で確認できます）\n')
    }
  })
}
