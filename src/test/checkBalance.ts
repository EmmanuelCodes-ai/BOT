// ============================================================
// Balance Check — fetches current Bybit demo account balance
// Run: npm run check:balance
// ============================================================

import "dotenv/config";
import ccxt from "ccxt";

async function run(): Promise<void> {
  const isDemoMode = process.env.BYBIT_DEMO_MODE === "true";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exchange = new (ccxt as any).bybit({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    ...(isDemoMode && {
      urls: {
        api: {
          public: "https://api-demo.bybit.com",
          private: "https://api-demo.bybit.com",
        },
      },
    }),
    options: {
      defaultType: process.env.MARKET_TYPE ?? "future",
      fetchCurrencies: false,
      ...(isDemoMode && { demo: true }),
    },
  });

  (exchange as any).fetchCurrencies = async () => ({});

  console.log("\n══════════════════════════════════");
  console.log("   Bybit Demo — Account Balance   ");
  console.log("══════════════════════════════════\n");

  try {
    const balance = await exchange.fetchBalance({ type: "unified" });

    const coins = ["USDT", "BTC", "ETH", "USDC"];
    let found = false;

    for (const coin of coins) {
      const total = balance?.total?.[coin];
      const free = balance?.free?.[coin];
      const used = balance?.used?.[coin];

      if (total !== undefined && total > 0) {
        console.log(`${coin.padEnd(6)} Total: ${total}  |  Free: ${free ?? 0}  |  Used: ${used ?? 0}`);
        found = true;
      }
    }

    if (!found) {
      console.log("No non-zero balances found.");
      console.log("\nFull balance object:");
      console.log(JSON.stringify(balance?.total, null, 2));
    }

    console.log("\n══════════════════════════════════\n");
  } catch (err: any) {
    console.error("Failed to fetch balance:", err.message ?? err);
    process.exit(1);
  }
}

run();
