// data/scans/<id>.json の保存・一覧・前回比較。
// id は YYYYMMDD-HHmmss（ローカル時刻）。

import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SAFE_ID = /^[0-9A-Za-z-]+$/

function pad(n) {
  return String(n).padStart(2, '0')
}

export function scanIdFor(d = new Date()) {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

export function createStore({ dir = resolve(import.meta.dirname, '../data/scans') } = {}) {
  async function ensureDir() {
    await mkdir(dir, { recursive: true })
  }

  function pathFor(id) {
    if (!SAFE_ID.test(id)) throw new Error(`不正なスキャンID: ${id}`)
    return join(dir, `${id}.json`)
  }

  async function nextId() {
    await ensureDir()
    let id = scanIdFor()
    let n = 1
    while (existsSync(pathFor(id))) {
      n += 1
      id = `${scanIdFor()}-${n}`
    }
    return id
  }

  async function ids() {
    await ensureDir()
    const files = await readdir(dir)
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort()
      .reverse()
  }

  return {
    dir,
    nextId,

    async save(doc) {
      await ensureDir()
      const path = pathFor(doc.id)
      await writeFile(path, JSON.stringify(doc), 'utf8')
      return doc.id
    },

    async get(id) {
      try {
        return JSON.parse(await readFile(pathFor(id), 'utf8'))
      } catch {
        return null
      }
    },

    // 新しい順。一覧は軽量化のため items を除く。
    async list() {
      const out = []
      for (const id of await ids()) {
        const doc = await this.get(id)
        if (!doc) continue
        const { items, ...rest } = doc
        out.push(rest)
      }
      return out
    },

    async remove(id) {
      try {
        await unlink(pathFor(id))
        return true
      } catch {
        return false
      }
    },

    // 差分検知用: 直近 limit 件のスキャンの items を key → item にマージする（新しい方が優先）。
    // 戻り値 { map, scanCount }。scanCount=0 なら isNew は付けない判定に使う。
    async recentItems({ limit = 5, excludeId } = {}) {
      const map = new Map()
      const list = (await ids()).filter((id) => id !== excludeId).slice(0, limit)
      for (const id of list) {
        const doc = await this.get(id)
        for (const it of doc?.items || []) {
          if (it?.key && !map.has(it.key)) map.set(it.key, it)
        }
      }
      return { map, scanCount: list.length }
    },
  }
}
