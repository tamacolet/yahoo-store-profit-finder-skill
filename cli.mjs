#!/usr/bin/env node
// 無人実行CLI。進捗は stderr、最後に A/B 上位20件を表で stdout に出す。
//
// 例:
//   node cli.mjs --preset smartphone,tablet --deep phi --deep-limit 40
//   node cli.mjs --mode keyword --keyword "iPhone" --seller ebest
//   node cli.mjs --mode reverse --category スマートフォン --min-buyback 20000
//   node cli.mjs --preset tablet --deep off --json out.json

import { pathToFileURL } from 'node:url'
import { runScan } from './lib/scan.mjs'
import { createSearchClient } from './lib/yahoo-search.mjs'
import { createBuybackClient } from './lib/buyback.mjs'
import { createPageFetcher } from './lib/item-page.mjs'
import { createStore } from './lib/store.mjs'
import { PRESETS } from './lib/presets.mjs'
import { PHI_SHADOW_PATH } from './lib/paths.mjs'

function parseArgs(argv) {
  const args = {
    mode: 'genre',
    presets: [],
    keyword: '',
    sellerId: '',
    priceFrom: null,
    priceTo: null,
    masterCategories: [],
    minBuyback: 0,
    deepCheck: 'off',
    deepLimit: 120,
    reverseLimit: 300,
    jsonPath: null,
  }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--preset' || a === '--presets') {
      args.presets = String(next || '').split(',').map((s) => s.trim()).filter(Boolean)
      i += 1
    } else if (a === '--mode') { args.mode = next; i += 1 }
    else if (a === '--keyword') { args.keyword = next ?? ''; i += 1 }
    else if (a === '--seller' || a === '--seller-id') { args.sellerId = next ?? ''; i += 1 }
    else if (a === '--category' || a === '--categories') {
      args.masterCategories = String(next || '').split(',').map((s) => s.trim()).filter(Boolean)
      i += 1
    } else if (a === '--min-buyback') { args.minBuyback = Number(next); i += 1 }
    else if (a === '--price-from') { args.priceFrom = Number(next); i += 1 }
    else if (a === '--price-to') { args.priceTo = Number(next); i += 1 }
    else if (a === '--deep' || a === '--deep-check') { args.deepCheck = next; i += 1 }
    else if (a === '--deep-limit') { args.deepLimit = Number(next); i += 1 }
    else if (a === '--reverse-limit') { args.reverseLimit = Number(next); i += 1 }
    else if (a === '--json') { args.jsonPath = next; i += 1 }
    else if (a === '--help' || a === '-h') { args.help = true }
  }
  return args
}

function printHelp() {
  process.stdout.write(`使い方:
  node cli.mjs --preset smartphone,tablet [--deep phi|anon|off] [--deep-limit 40]
  node cli.mjs --mode keyword --keyword "iPhone" [--seller ebest]
  node cli.mjs --mode reverse --category スマートフォン [--min-buyback 20000] [--reverse-limit 300]

オプション:
  --preset <id,id>    ジャンルプリセット（${PRESETS.map((p) => p.id).join(', ')}）
  --mode <m>          genre|keyword|reverse（既定 genre）
  --keyword <語>      キーワード検索（--mode keyword）
  --seller <id>       ストアIDで絞る（旧CLIのストア巡回相当）
  --category <名,名>  買取マスターのカテゴリ（--mode reverse）
  --min-buyback <円>  reverseで対象にする最低買取価格
  --price-from/--price-to <円>  価格帯の切り詰め（ジャンル巡回の下限は既定 10000。0 で全価格帯）
  --deep <m>          商品ページの確定値取得 phi|anon|off（既定 off）
  --deep-limit <n>    確定値を取る上限件数（既定 120）
  --reverse-limit <n> 逆引きJAN検索の上限件数（既定 300、最大 2000）
  --json <path>       結果JSONの保存先（別途 data/scans/ にも保存）
`)
}

const yen = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toLocaleString()}円`)

function printTable(items) {
  const top = items.filter((r) => r.rank === 'A' || r.rank === 'B').slice(0, 20)
  if (top.length === 0) {
    process.stdout.write('\nA/Bランクの商品はありませんでした。\n')
    return
  }
  process.stdout.write('\n=== 上位候補（A/B・最大20件）===\n')
  const rows = top.map((r, i) => [
    String(i + 1).padStart(2),
    r.rank,
    yen(r.profit?.max).padStart(9),
    yen(r.profit?.conservative).padStart(9),
    (r.effective?.max?.toLocaleString() ?? '—').padStart(9),
    (r.buyback?.max?.toLocaleString() ?? '—').padStart(9),
    (r.sellerId || '').slice(0, 14).padEnd(14),
    r.matchType === 'model' ? '型番' : 'JAN ',
    (r.name || '').slice(0, 44),
  ])
  process.stdout.write('No | R | 利益(最大) | 利益(確実) | 実質(最大) | 買取最高 | ストア         | 照合 | 商品名\n')
  process.stdout.write('---+-----------+------------+------------+------------+----------------+------+--------\n')
  for (const r of rows) process.stdout.write(r.join(' | ') + '\n')
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) return printHelp()

  const log = (m) => process.stderr.write(`${m}\n`)
  const appid = process.env.YAHOO_CLIENT_ID
  if (!appid) throw new Error('YAHOO_CLIENT_ID が未設定です。環境変数に設定して再実行してください。')
  if (!['genre', 'keyword', 'reverse'].includes(args.mode)) {
    throw new Error(`--mode は genre|keyword|reverse のいずれかです（指定: ${args.mode}）`)
  }
  if (args.mode === 'genre' && args.presets.length === 0) {
    throw new Error('genre モードには --preset が必要です')
  }
  if (args.mode === 'keyword' && !args.keyword && !args.sellerId) {
    throw new Error('keyword モードには --keyword か --seller が必要です')
  }
  if (args.mode === 'reverse' && args.masterCategories.length === 0) {
    throw new Error('reverse モードには --category が必要です')
  }
  if (!['phi', 'anon', 'off'].includes(args.deepCheck)) {
    throw new Error('--deep は phi|anon|off のいずれかです')
  }
  if (!Number.isInteger(args.reverseLimit) || args.reverseLimit < 1 || args.reverseLimit > 2000) {
    throw new Error('--reverse-limit は 1〜2000 の整数で指定してください')
  }

  const store = createStore({})
  const buyback = createBuybackClient({ log })
  const search = createSearchClient({ appid, log })
  const pageFetcherFactory = ({ mode }) => createPageFetcher({ mode, log })

  const startedAt = Date.now()
  const doc = await runScan(
    {
      mode: args.mode,
      presets: args.presets,
      keyword: args.keyword,
      sellerId: args.sellerId,
      // ジャンル巡回は1万円未満に付属品が多く時間だけかかるため、既定で1万円以上に絞る
      priceFrom: args.priceFrom ?? (args.mode === 'genre' ? 10000 : null),
      priceTo: args.priceTo,
      masterCategories: args.masterCategories,
      minBuyback: args.minBuyback,
      deepCheck: args.deepCheck,
      deepLimit: args.deepLimit,
      reverseLimit: args.reverseLimit,
    },
    {
      deps: { search, buyback, pageFetcherFactory, store, now: () => new Date() },
      onEvent: (ev) => {
        if (ev.type === 'progress') {
          const t = ev.total ? ` ${ev.done}/${ev.total}` : ''
          log(`[${ev.stage}]${t} ${ev.message}`)
        } else if (ev.type === 'error') {
          log(`エラー: ${ev.message}`)
        } else if (ev.type === 'warning') {
          log(`警告: ${ev.message}`)
        }
      },
    },
  )
  await buyback.flush?.()

  if (args.jsonPath) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(args.jsonPath, JSON.stringify(doc, null, 2), 'utf8')
    log(`JSON: ${args.jsonPath}`)
  }

  const s = doc.summary
  log(
    `完了(${doc.status}): 出品${s.listings}件 / 照合${s.matched}件（型番${s.matchedByModel}）` +
      ` / 買取${s.buybackHits}件 / 確定${s.deepChecked}件 / A:${s.rankA} B:${s.rankB} C:${s.rankC}` +
      ` / ${s.durationSec}秒 / レート制限${s.rateLimitHits}回 / point:${s.pointSource}` +
      ` / loginState:${s.loginState ?? 'null'} / duplicatesMerged:${s.duplicatesMerged}`,
  )
  printTable(doc.items)
  process.stderr.write(`saved: data/scans/${doc.id}.json（${Math.round((Date.now() - startedAt) / 1000)}秒）\n`)
}

main()
  .then(async () => {
    // Phi の socket が残って node が終わらないことがあるため endPhi で終える
    try {
      const { endPhi } = await import(pathToFileURL(PHI_SHADOW_PATH).href)
      await endPhi(0)
    } catch {
      process.exit(0)
    }
  })
  .catch(async (e) => {
    process.stderr.write(`エラー: ${e?.message || e}\n`)
    try {
      const { endPhi } = await import(pathToFileURL(PHI_SHADOW_PATH).href)
      await endPhi(1)
    } catch {
      process.exit(1)
    }
  })
