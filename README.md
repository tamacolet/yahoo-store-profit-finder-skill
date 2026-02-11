# yahoo-store-profit-finder

Yahooショッピングの任意ストアを対象に、HTMLから以下を取得します。

- 価格
- ポイント
- 実質価格（価格 - ポイント）
- JAN

その後、`https://www.morimori-kaitori.jp/search?sk=...` で照合し、利益商品を抽出します。

## 実行例

```bash
pnpm exec node /Users/t/.claude/skills/yahoo-store-profit-finder/scripts/yahoo-store-profit-scan.mjs \
  --store yamada-denki \
  --keyword "WF-1000XM5" \
  --pages 1 \
  --max-items 20 \
  --mode normal \
  --min-profit 0 \
  --json /tmp/yahoo-profit.json
```

## 主要引数

- `--store` (必須): YahooストアID
- `--keyword`: ストア内検索キーワード
- `--pages`: 取得ページ数
- `--max-items`: 詳細取得する最大件数
- `--mode`: `normal` / `yutori` / `deposit`
- `--min-profit`: 利益しきい値（円）
- `--json`: JSON保存先
- `--storage-state`: Playwrightで作成したログイン状態JSON
- `--point-source`: `total` / `with-entry`

## ログイン後ポイントで取得する手順（Playwright）

1. Yahooに手動ログインして state を保存

```bash
pnpm exec node /Users/t/.claude/skills/yahoo-store-profit-finder/scripts/yahoo-login-save-state.mjs \
  --out /tmp/yahoo-shopping-state.json
```

2. 保存した state を使ってスキャン

```bash
pnpm exec node /Users/t/.claude/skills/yahoo-store-profit-finder/scripts/yahoo-store-profit-scan.mjs \
  --store yamada-denki \
  --pages 2 \
  --max-items 40 \
  --mode normal \
  --point-source with-entry \
  --storage-state /tmp/yahoo-shopping-state.json \
  --json /tmp/yahoo-profit-login.json
```
