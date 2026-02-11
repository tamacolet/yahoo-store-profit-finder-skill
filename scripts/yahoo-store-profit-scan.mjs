#!/usr/bin/env node

/**
 * Yahoo Shopping store scraper (HTML only, no Yahoo API)
 * -> extracts price/point/effective price/JAN
 * -> searches morimori-kaitori and computes profit candidates
 */

const DEFAULTS = {
  pages: 1,
  maxItems: 30,
  concurrency: 5,
  minProfit: 0,
  mode: "normal",
  pointSource: "total",
  timeoutMs: 30000,
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--store") {
      args.store = next;
      i += 1;
    } else if (arg === "--keyword") {
      args.keyword = next ?? "";
      i += 1;
    } else if (arg === "--pages") {
      args.pages = Number(next);
      i += 1;
    } else if (arg === "--max-items") {
      args.maxItems = Number(next);
      i += 1;
    } else if (arg === "--concurrency") {
      args.concurrency = Number(next);
      i += 1;
    } else if (arg === "--min-profit") {
      args.minProfit = Number(next);
      i += 1;
    } else if (arg === "--mode") {
      args.mode = next;
      i += 1;
    } else if (arg === "--json") {
      args.jsonPath = next;
      i += 1;
    } else if (arg === "--storage-state") {
      args.storageState = next;
      i += 1;
    } else if (arg === "--point-source") {
      args.pointSource = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/yahoo-store-profit-scan.mjs --store <storeId> [options]

Required:
  --store <id>           Yahoo store id (ex: yamada-denki)

Options:
  --keyword <text>       Search keyword in store (default: empty)
  --pages <n>            Number of search pages to crawl (default: 1)
  --max-items <n>        Max item detail pages to inspect (default: 30)
  --concurrency <n>      Parallel fetch count (default: 5)
  --mode <normal|yutori|deposit>
                         Morimori price type (default: normal)
  --point-source <total|with-entry>
                         total=point.totalPoint, with-entry=point.totalPointWithEntry
  --min-profit <yen>     Filter by min profit (default: 0)
  --storage-state <path> Playwright storageState JSON (logged-in Yahoo session)
  --json <path>          Write full JSON result
  --help                 Show this help
`);
}

function ensureValidArgs(args) {
  if (!args.store) {
    throw new Error("--store is required");
  }
  if (!Number.isFinite(args.pages) || args.pages < 1) {
    throw new Error("--pages must be >= 1");
  }
  if (!Number.isFinite(args.maxItems) || args.maxItems < 1) {
    throw new Error("--max-items must be >= 1");
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
    throw new Error("--concurrency must be >= 1");
  }
  if (!["normal", "yutori", "deposit"].includes(args.mode)) {
    throw new Error("--mode must be one of: normal, yutori, deposit");
  }
  if (!["total", "with-entry"].includes(args.pointSource)) {
    throw new Error("--point-source must be one of: total, with-entry");
  }
}

function normalizeYen(value) {
  if (value == null) return null;
  const n = String(value).replace(/[^\d.-]/g, "");
  if (!n) return null;
  const num = Number(n);
  return Number.isFinite(num) ? num : null;
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url, timeoutMs = DEFAULTS.timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function createHttpClient(args) {
  if (!args.storageState) {
    return {
      fetchText: (url, timeoutMs) => fetchText(url, timeoutMs),
      close: async () => {},
      mode: "default-fetch",
    };
  }

  let request;
  try {
    ({ request } = await import("playwright"));
  } catch {
    throw new Error(
      "playwright is required when --storage-state is used. Run: pnpm add -D playwright",
    );
  }

  const ctx = await request.newContext({
    storageState: args.storageState,
    extraHTTPHeaders: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    ignoreHTTPSErrors: true,
  });

  return {
    mode: "playwright-storage-state",
    fetchText: async (url, timeoutMs = DEFAULTS.timeoutMs) => {
      const res = await ctx.get(url, { timeout: timeoutMs });
      if (!res.ok()) {
        throw new Error(`HTTP ${res.status()} for ${url}`);
      }
      return await res.text();
    },
    close: async () => {
      await ctx.dispose();
    },
  };
}

function extractYahooItemUrls(searchHtml, storeId) {
  const absRe = new RegExp(
    `https://store\\.shopping\\.yahoo\\.co\\.jp/${storeId}/[^"'\\s<>]+\\.html`,
    "g",
  );
  const relRe = new RegExp(`href=["'](/${storeId}/[^"'#?\\s<>]+\\.html)`, "g");

  const urls = new Set();
  for (const m of searchHtml.matchAll(absRe)) {
    urls.add(m[0]);
  }
  for (const m of searchHtml.matchAll(relRe)) {
    urls.add(`https://store.shopping.yahoo.co.jp${m[1]}`);
  }

  const blocked = new Set(["guide.html", "info.html", "review.html"]);
  return [...urls].filter((u) => ![...blocked].some((x) => u.includes(x)));
}

function parseNextDataFromYahooItem(html) {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!m) return null;

  let root;
  try {
    root = JSON.parse(m[1]);
  } catch {
    return null;
  }

  const pp = root?.props?.pageProps;
  if (!pp || typeof pp !== "object") return null;

  const item = pp.item || {};
  const point = pp.point || {};

  const price =
    item.applicablePrice ?? item.regularPrice ?? item?.priceTable?.oneLayersPrice?.price ?? null;
  const totalPoint = point.totalPoint ?? 0;
  const totalPointWithEntry = point.totalPointWithEntry ?? totalPoint;
  const janRaw = item.janCode;
  const jan = janRaw != null ? String(janRaw).replace(/\D/g, "") : null;

  return {
    title: item.name || null,
    jan: jan || null,
    price: normalizeYen(price),
    point: normalizeYen(totalPoint) ?? 0,
    pointWithEntry: normalizeYen(totalPointWithEntry) ?? normalizeYen(totalPoint) ?? 0,
    modelHint: extractModelHint(item.name || ""),
  };
}

function extractModelHint(title) {
  if (!title) return "";
  const parts = title
    .replace(/[【】\[\]（）()]/g, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const candidate = parts.find((p) => /[A-Za-z].*\d|\d.*[A-Za-z]/.test(p) && p.length >= 5);
  return candidate || parts.slice(0, 3).join(" ");
}

function parseMorimoriProducts(html) {
  const blocks = html.split(/<div class="product-item\b/).slice(1);
  const rows = [];

  for (const block of blocks) {
    const nameRaw = block.match(/<h4 class="search-product-details-name">([\s\S]*?)<\/h4>/i)?.[1] || "";
    const name = stripHtml(nameRaw);
    const jan = (block.match(/JAN\s*[:：]\s*(\d{8,14})/i)?.[1] || null);
    const normal = normalizeYen(
      block.match(/<div class="price-normal-number">([\s\S]*?)<\/div>/i)?.[1] || "",
    );
    const yutori = normalizeYen(
      block.match(/<div class="price y-price-color">([\s\S]*?)<\/div>/i)?.[1] || "",
    );
    const deposit = normalizeYen(
      block.match(/<div class="deposit-price-number[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "",
    );
    const relUrl = block.match(/<a href=['"]([^'"]*\/product\/[^'"]+)['"]/i)?.[1] || null;

    if (!name && !jan) continue;

    rows.push({
      name,
      jan,
      normal,
      yutori,
      deposit,
      url: relUrl ? new URL(relUrl, "https://www.morimori-kaitori.jp").href : null,
    });
  }

  return rows;
}

function pickMorimoriBest(products, yahooItem, mode) {
  if (!products.length) return null;

  const priceKey = mode;
  const withPrice = products.filter((p) => normalizeYen(p[priceKey]) != null);
  if (!withPrice.length) return null;

  if (yahooItem.jan) {
    const exactJan = withPrice.filter((p) => p.jan && p.jan === yahooItem.jan);
    if (exactJan.length) {
      return exactJan.sort((a, b) => (b[priceKey] || 0) - (a[priceKey] || 0))[0];
    }
  }

  const hint = (yahooItem.modelHint || "").toLowerCase();
  if (hint) {
    const hinted = withPrice.filter((p) => p.name.toLowerCase().includes(hint));
    if (hinted.length) {
      return hinted.sort((a, b) => (b[priceKey] || 0) - (a[priceKey] || 0))[0];
    }
  }

  return withPrice.sort((a, b) => (b[priceKey] || 0) - (a[priceKey] || 0))[0];
}

async function runPool(items, concurrency, worker) {
  const out = [];
  let idx = 0;

  async function loop() {
    while (idx < items.length) {
      const myIdx = idx;
      idx += 1;
      try {
        out[myIdx] = await worker(items[myIdx], myIdx);
      } catch (err) {
        out[myIdx] = { error: err?.message || String(err) };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => loop());
  await Promise.all(workers);
  return out;
}

function buildStoreSearchUrl(storeId, keyword, page) {
  const q = new URLSearchParams();
  q.set("p", keyword || "");
  if (page > 1) q.set("page", String(page));
  return `https://store.shopping.yahoo.co.jp/${storeId}/search.html?${q.toString()}`;
}

function buildMorimoriQuery(yahooItem) {
  if (yahooItem.jan) return yahooItem.jan;
  if (yahooItem.modelHint) return yahooItem.modelHint;
  return (yahooItem.title || "").slice(0, 40);
}

function formatYen(n) {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${Math.round(n).toLocaleString("ja-JP")}円`;
}

function printResultTable(results, mode) {
  if (!results.length) {
    console.log("\n利益が出る候補は見つかりませんでした。");
    return;
  }

  const header = [
    "No",
    "利益",
    "Yahoo実質",
    `森森(${mode})`,
    "JAN",
    "商品名",
  ];
  console.log(`\n${header.join(" | ")}`);
  console.log(header.map(() => "---").join(" | "));

  results.forEach((r, i) => {
    const line = [
      String(i + 1),
      formatYen(r.selectedProfit),
      formatYen(r.selectedEffectivePrice),
      formatYen(r.morimoriPrice),
      r.jan || "-",
      (r.title || "").slice(0, 60),
    ];
    console.log(line.join(" | "));
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  ensureValidArgs(args);

  const client = await createHttpClient(args);
  console.log(
    `Scanning store=${args.store}, keyword=${args.keyword || "(empty)"}, pages=${args.pages}, source=${client.mode}, pointSource=${args.pointSource}`,
  );

  try {
    const pageUrls = Array.from({ length: args.pages }, (_, i) =>
      buildStoreSearchUrl(args.store, args.keyword || "", i + 1),
    );

    const searchHtmlList = await runPool(pageUrls, Math.min(args.concurrency, pageUrls.length), (u) =>
      client.fetchText(u, args.timeoutMs),
    );

    const urlSet = new Set();
    for (const html of searchHtmlList) {
      if (!html || typeof html !== "string") continue;
      extractYahooItemUrls(html, args.store).forEach((u) => urlSet.add(u));
    }

    const itemUrls = [...urlSet].slice(0, args.maxItems);
    console.log(`Found item URLs: ${urlSet.size} (using ${itemUrls.length})`);

    const detailRows = await runPool(itemUrls, args.concurrency, async (itemUrl) => {
      const html = await client.fetchText(itemUrl, args.timeoutMs);
      const parsed = parseNextDataFromYahooItem(html);
      if (!parsed || parsed.price == null || !parsed.title) {
        return { itemUrl, skipped: true, reason: "failed to parse yahoo item" };
      }

      const effectivePrice = parsed.price - parsed.point;
      const effectivePriceWithEntry = parsed.price - parsed.pointWithEntry;
      const selectedPoint = args.pointSource === "with-entry" ? parsed.pointWithEntry : parsed.point;
      const selectedEffectivePrice = parsed.price - selectedPoint;

      const query = buildMorimoriQuery(parsed);
      const mmUrl = `https://www.morimori-kaitori.jp/search?sk=${encodeURIComponent(query)}`;
      const mmHtml = await fetchText(mmUrl, args.timeoutMs);
      const mmProducts = parseMorimoriProducts(mmHtml);
      const best = pickMorimoriBest(mmProducts, parsed, args.mode);

      const morimoriPrice = best ? normalizeYen(best[args.mode]) : null;
      const profit = morimoriPrice != null ? morimoriPrice - effectivePrice : null;
      const profitWithEntry =
        morimoriPrice != null ? morimoriPrice - effectivePriceWithEntry : null;
      const selectedProfit = morimoriPrice != null ? morimoriPrice - selectedEffectivePrice : null;

      return {
        storeId: args.store,
        itemUrl,
        title: parsed.title,
        jan: parsed.jan,
        yahooPrice: parsed.price,
        yahooPoint: parsed.point,
        yahooPointWithEntry: parsed.pointWithEntry,
        selectedPoint,
        selectedEffectivePrice,
        pointSource: args.pointSource,
        effectivePrice,
        effectivePriceWithEntry,
        morimoriQuery: query,
        morimoriSearchUrl: mmUrl,
        morimoriMatchCount: mmProducts.length,
        morimoriMatched: best,
        morimoriPrice,
        profit,
        profitWithEntry,
        selectedProfit,
      };
    });

    const completed = detailRows.filter((r) => r && !r.error && !r.skipped);
    const profitable = completed
      .filter((r) => Number.isFinite(r.selectedProfit) && r.selectedProfit >= args.minProfit)
      .sort((a, b) => b.selectedProfit - a.selectedProfit);

    console.log(`Parsed items: ${completed.length}`);
    console.log(`Profitable candidates (>= ${args.minProfit}円): ${profitable.length}`);

    printResultTable(profitable, args.mode);

    if (args.jsonPath) {
      const fs = await import("node:fs/promises");
      await fs.writeFile(
        args.jsonPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            input: args,
            counts: {
              foundItemUrls: urlSet.size,
              usedItemUrls: itemUrls.length,
              parsedItems: completed.length,
              profitableItems: profitable.length,
            },
            profitable,
            allParsed: completed,
          },
          null,
          2,
        ),
        "utf8",
      );
      console.log(`\nJSON saved: ${args.jsonPath}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message || err}`);
  process.exit(1);
});
