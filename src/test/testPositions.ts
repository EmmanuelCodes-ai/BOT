// ============================================================
// Bybit Live Position Check — Directly queries Bybit API
// Run: npx ts-node src/test/testPositions.ts
// ============================================================

import "dotenv/config";
import ccxt from "ccxt";

async function run(): Promise<void> {
  const isDemoMode = process.env.BYBIT_DEMO_MODE === "true";
  const symbol = process.env.SYMBOL ?? "SOL/USDT:USDT";

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
    timeout: 25000,
    options: {
      defaultType: process.env.MARKET_TYPE ?? "future",
      fetchCurrencies: false,
      ...(isDemoMode && { demo: true }),
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (exchange as any).fetchCurrencies = async () => ({});

  if (process.env.SANDBOX_MODE === "true") {
    exchange.setSandboxMode(true);
  }

  console.log("\n══════════════════════════════════════════════════════");
  console.log("       Bybit Live Position Query (Source of Truth)    ");
  console.log("══════════════════════════════════════════════════════");
  console.log(`Exchange API Mode  : ${isDemoMode ? "DEMO (api-demo.bybit.com)" : "LIVE (api.bybit.com)"}`);
  console.log(`Target Symbol      : ${symbol}`);
  console.log("──────────────────────────────────────────────────────");

  try {
    console.log("[1] Querying Bybit V5 Position Endpoint...");
    let rawPositions: any[] = [];
    try {
      rawPositions = await exchange.fetchPositions([symbol]);
    } catch (fetchErr: any) {
      console.log(`    fetchPositions notice: ${fetchErr.message}. Trying direct Bybit V5 endpoint...`);
      const marketId = symbol.replace("/", "").split(":")[0].replace(/[^a-zA-Z0-9]/g, "");
      const res = await (exchange as any).privateGetV5PositionList({
        category: "linear",
        symbol: marketId,
      });
      rawPositions = (res?.result?.list ?? []).map((item: any) => ({
        symbol,
        side: item.side?.toLowerCase(),
        contracts: parseFloat(item.size || "0"),
        entryPrice: parseFloat(item.avgPrice || "0"),
        unrealizedPnl: parseFloat(item.unrealisedPnl || "0"),
        leverage: parseFloat(item.leverage || "1"),
        stopLoss: parseFloat(item.stopLoss || "0"),
        takeProfit: parseFloat(item.takeProfit || "0"),
        markPrice: parseFloat(item.markPrice || "0"),
        info: item,
      }));
    }

    const activePositions = rawPositions.filter((pos: any) => {
      const contracts = Math.abs(pos.contracts ?? (pos.info as any)?.size ?? 0);
      return contracts > 0;
    });

    console.log(`[2] Query completed. Total positions returned: ${rawPositions.length}`);
    console.log(`    Active open positions on Bybit: ${activePositions.length}\n`);

    if (activePositions.length === 0) {
      console.log("✅ No open positions found on Bybit for this symbol (0 active).");
      console.log("   The bot's maxOpenTrades guard will allow new entries.");
    } else {
      activePositions.forEach((pos: any, idx: number) => {
        const rawSide = (pos.side ?? (pos.info as any)?.side ?? "").toUpperCase();
        const size = Math.abs(pos.contracts ?? (pos.info as any)?.size ?? 0);
        const entry = pos.entryPrice ?? parseFloat((pos.info as any)?.avgPrice ?? "0");
        const mark = pos.markPrice ?? parseFloat((pos.info as any)?.markPrice ?? "0");
        const upnl = pos.unrealizedPnl ?? parseFloat((pos.info as any)?.unrealisedPnl ?? "0");
        const lev = pos.leverage ?? (pos.info as any)?.leverage ?? "—";
        const sl = pos.stopLoss ?? (pos.info as any)?.stopLoss ?? "None";
        const tp = pos.takeProfit ?? (pos.info as any)?.takeProfit ?? "None";
        const liq = (pos.info as any)?.bustPrice ?? "—";

        console.log(`📌 Position #${idx + 1}:`);
        console.log(`   Symbol       : ${pos.symbol}`);
        console.log(`   Direction    : ${rawSide}`);
        console.log(`   Size         : ${size} contracts`);
        console.log(`   Entry Price  : $${entry}`);
        console.log(`   Mark Price   : $${mark}`);
        console.log(`   Floating PnL : ${upnl >= 0 ? "+" : ""}$${upnl.toFixed(4)}`);
        console.log(`   Leverage     : ${lev}x`);
        console.log(`   Stop Loss    : ${sl}`);
        console.log(`   Take Profit  : ${tp}`);
        console.log(`   Liquidation  : $${liq}`);
        console.log("──────────────────────────────────────────────────────");
      });
    }

    console.log("\n══════════════════════════════════════════════════════\n");
  } catch (err: any) {
    console.error("❌ Failed to query Bybit positions:", err.message ?? err);
    process.exit(1);
  }
}

run();
