#!/usr/bin/env node

/**
 * Playwright login helper for Yahoo Shopping.
 * Opens browser, keeps it alive for manual login, saves storageState.
 */

function parseArgs(argv) {
  const out = {
    outPath: "/tmp/yahoo-shopping-state.json",
    headless: false,
    waitSeconds: 180,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--out") {
      out.outPath = next;
      i += 1;
    } else if (arg === "--wait-seconds") {
      out.waitSeconds = Number(next);
      i += 1;
    } else if (arg === "--headless") {
      out.headless = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    }
  }

  return out;
}

function printHelp() {
  console.log(`Usage:
  node scripts/yahoo-login-save-state.mjs [options]

Options:
  --out <path>     storageState JSON output (default: /tmp/yahoo-shopping-state.json)
  --wait-seconds   Browser keep-alive time for manual login (default: 180)
  --headless       Run headless (usually not recommended for manual login)
  --help           Show this help
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("playwright is required. Run: pnpm add -D playwright");
  }

  const browser = await chromium.launch({ headless: args.headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const loginUrl =
    "https://login.yahoo.co.jp/config/login?.src=shp&.intl=jp&.done=https%3A%2F%2Fshopping.yahoo.co.jp%2F";

  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  console.log("Yahooログイン画面を開きました。");
  console.log(`ブラウザを ${args.waitSeconds} 秒間開きます。ログイン操作を完了してください。`);

  const started = Date.now();
  while (Date.now() - started < args.waitSeconds * 1000) {
    const remain = Math.max(0, args.waitSeconds - Math.floor((Date.now() - started) / 1000));
    if (remain % 15 === 0 || remain <= 10) {
      console.log(`残り ${remain} 秒...`);
    }
    await sleep(1000);
  }

  await context.storageState({ path: args.outPath });
  console.log(`storageState saved: ${args.outPath}`);

  await browser.close();
}

main().catch((err) => {
  console.error(`Error: ${err.message || err}`);
  process.exit(1);
});
