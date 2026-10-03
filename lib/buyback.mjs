// 買取価格。kaitori-app のスキャナを import して使う（書き換えない）。
// トークン解決: loadToken → tryReuseStaleToken → getTokenFromPhi。
// 買取マスターは最初の利用時に読み、索引をメモリに持つ（24hで読み直し）。
// 価格は data/cache/buyback.json に3時間キャッシュ。

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildMasterIndex } from './matcher.mjs'
import { KAITORI_SCANNER_PATH as DEFAULT_SCANNER } from './paths.mjs'

const MASTER_TTL_MS = 24 * 60 * 60 * 1000
const PRICE_CACHE_TTL_MS = 3 * 60 * 60 * 1000
export const TOKEN_REQUIRED_MESSAGE =
  'Phi で hikaku（https://hikaku-342505.firebaseapp.com/search/）にログインしてください'

export function createBuybackClient({
  scannerPath = DEFAULT_SCANNER,
  cachePath = resolve(import.meta.dirname, '../data/cache/buyback.json'),
  cacheTtlMs = PRICE_CACHE_TTL_MS,
  log = () => {},
  now = () => new Date(),
} = {}) {
  let mod = null
  let masterCache = null // { items, index, loadedAt }
  let priceCache = null // { [jan]: { cachedAt, data } }

  async function scanner() {
    if (!mod) mod = await import(pathToFileURL(scannerPath).href)
    return mod
  }

  // 保存済みの有効トークンだけ返す（ブラウザ復旧はしない。/api/status・/api/presets 用）
  async function storedToken() {
    try {
      const s = await scanner()
      return s.loadToken({ silent: true }) || null
    } catch {
      return null
    }
  }

  // トークンは約1時間で切れるので毎回ファイルの期限を見る（メモリに持ち続けない）。
  // 期限切れ時の復旧（stale再利用→Phi）は同時に1本だけ走らせる。
  let refreshing = null
  async function ensureToken({ force = false } = {}) {
    const s = await scanner()
    if (!force) {
      const t = s.loadToken({ silent: true })
      if (t) return t
    }
    refreshing ??= (async () => {
      try {
        if (!force) {
          const stale = await s.tryReuseStaleToken({ silent: true }).catch(() => null)
          if (stale) return stale
        }
        return await s.getTokenFromPhi({ silent: true })
      } catch (e) {
        throw new Error(`${TOKEN_REQUIRED_MESSAGE}\n（自動復旧の失敗理由: ${e.message}）`)
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  async function loadPriceCache() {
    if (priceCache) return priceCache
    priceCache = {}
    try {
      priceCache = JSON.parse(await readFile(cachePath, 'utf8'))
    } catch {}
    return priceCache
  }

  let saveTimer = null
  async function savePriceCache() {
    try {
      await mkdir(dirname(cachePath), { recursive: true })
      await writeFile(cachePath, JSON.stringify(priceCache), 'utf8')
    } catch (e) {
      log(`買取キャッシュの保存に失敗: ${e.message}`)
    }
  }
  function scheduleSave() {
    if (saveTimer) return
    saveTimer = setTimeout(async () => {
      saveTimer = null
      await savePriceCache()
    }, 2000)
    saveTimer.unref?.()
  }

  // 買取マスター（[{JAN,itemName,category}]）。初回利用時に読み、24hで読み直し。
  async function master({ fast = false } = {}) {
    if (masterCache && now() - masterCache.loadedAt < MASTER_TTL_MS) return masterCache.items
    const s = await scanner()
    // fast: ローカルトークンが無ければブラウザ復旧せず諦める（ステータス表示用）
    const t = fast ? await storedToken() : await ensureToken()
    if (!t) throw new Error(TOKEN_REQUIRED_MESSAGE)
    const items = await s.getItemJan(t)
    masterCache = { items, index: buildMasterIndex(items), loadedAt: now() }
    return items
  }

  async function masterIndex(opts) {
    await master(opts)
    return masterCache.index
  }

  async function masterCategories(opts) {
    const items = await master(opts)
    const counts = new Map()
    for (const m of items) {
      const c = m?.category || 'その他'
      counts.set(c, (counts.get(c) || 0) + 1)
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
  }

  // 1件の買取価格（3hキャッシュ付き）。戻り値は formatPriceData のJSONオブジェクト。
  async function priceForJan(jan) {
    const cache = await loadPriceCache()
    const hit = cache[jan]
    if (hit && now().getTime() - new Date(hit.cachedAt).getTime() < cacheTtlMs) return hit.data
    const s = await scanner()
    let raw
    try {
      raw = await s.getPriceByJan(await ensureToken(), jan)
    } catch (e) {
      // 期限内でも失効していることがある。401/403 なら取り直して1回だけ再試行
      if (!/40[13]/.test(e.message)) throw e
      raw = await s.getPriceByJan(await ensureToken({ force: true }), jan)
    }
    const data = JSON.parse(s.formatPriceData(raw, 'json'))
    cache[jan] = { cachedAt: now().toISOString(), data }
    scheduleSave()
    return data
  }

  // 複数JANを並列で取得。prefetched: Map<jan,data> で既取得を再利用可。
  async function pricesForJans(jans, { concurrency = 8, signal, onProgress, prefetched } = {}) {
    const out = new Map(prefetched || [])
    const todo = [...new Set(jans)].filter((j) => j && !out.has(j))
    const total = todo.length
    let done = 0
    let idx = 0
    const worker = async () => {
      while (idx < todo.length) {
        if (signal?.aborted) return
        const jan = todo[idx]
        idx += 1
        try {
          out.set(jan, await priceForJan(jan))
        } catch (e) {
          out.set(jan, { error: e.message, jan })
        }
        done += 1
        onProgress?.(done, total)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker))
    return out
  }

  return {
    // /api/status 用: 'ok' | 'expired' | 'missing'
    async tokenStatus() {
      try {
        const s = await scanner()
        if (s.loadToken({ silent: true })) return 'ok'
        const stored = s.readStoredTokenFile?.()
        return stored?.token ? 'expired' : 'missing'
      } catch {
        return 'missing'
      }
    },
    // 読み込み済みのマスター件数（未読み込みなら null。取得はしない）
    masterCount() {
      return masterCache ? masterCache.index.count : null
    },
    master,
    masterIndex,
    masterCategories,
    priceForJan,
    pricesForJans,
    // キャッシュの遅延書き込みを確定させる（終了時用）
    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
        await savePriceCache()
      }
    },
  }
}
