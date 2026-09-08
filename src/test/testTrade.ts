// ============================================================
// Direct Terminal Test: Bybit Test Order Placement
// Run with: npm run test:trade
// ============================================================

import "dotenv/config";
import ccxt from "ccxt";

async function run(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════");
  console.log("   Bybit Real Test Order — Direct Terminal Runner     ");
  console.log("══════════════════════════════════════════════════════\n");

  const apiKey = process.env.API_KEY;
  const secret = process.env.API_SECRET;
  const symbol = process.env.SYMBOL ?? "BTC/USDT:USDT";
  const isDemoMode = process.env.BYBIT_DEMO_MODE === "true";
  const marketType = process.env.MARKET_TYPE ?? "future";

  if (!apiKey || !secret) {
    console.error("❌ ERROR: API_KEY or API_SECRET is missing in .env!");
    process.exit(1);
  }

  console.log(`Config:`);
  console.log(`  Symbol   : ${symbol}`);
  console.log(`  Demo Mode: ${isDemoMode}`);
  console.log(`  Market   : ${marketType}`);
  console.log(`  API Key  : ${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`);

  console.log("\n[1] Initializing Bybit connection...");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exchange = new (ccxt as any).bybit({
    apiKey,
    secret,
    ...(isDemoMode && {
      urls: {
        api: {
          public: "https://api-demo.bybit.com",
          private: "https://api-demo.bybit.com",
        },
      },
    }),
    options: {
      defaultType: marketType,
      fetchCurrencies: false,
      ...(isDemoMode && { demo: true }),
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (exchange as any).fetchCurrencies = async () => ({});

  if (process.env.SANDBOX_MODE === "true") {
    exchange.setSandboxMode(true);
  }

  console.log("[2] Loading market limits...");
  await exchange.loadMarkets();

  const market = exchange.markets[symbol];
  if (!market) {
    throw new Error(`Symbol ${symbol} not found on Bybit!`);
  }

  console.log("[3] Fetching current ticker...");
  const ticker = await exchange.fetchTicker(symbol);
  const price = ticker.last ?? ticker.close;
  if (!price) throw new Error("Could not retrieve current market price");
  console.log(`    Current ${symbol} price: $${price}`);

  const minSize = market?.limits?.amount?.min ?? 0.001;
  const orderSize = parseFloat(exchange.amountToPrecision(symbol, minSize));
  const sl = parseFloat(exchange.priceToPrecision(symbol, price * 0.995));
  const tp = parseFloat(exchange.priceToPrecision(symbol, price * 1.005));

  console.log(`\n[4] Submitting Market Buy Order:`);
  console.log(`    Size       : ${orderSize}`);
  console.log(`    Stop Loss  : ${sl} (-0.5%)`);
  console.log(`    Take Profit: ${tp} (+0.5%)`);

  try {
    const resp = await exchange.createOrder(
      symbol,
      "market",
      "buy",
      orderSize,
      undefined,
      {
        stopLoss: sl,
        takeProfit: tp,
        slTriggerBy: "LastPrice",
        tpTriggerBy: "LastPrice",
      }
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawOrderId = (resp.info as any)?.orderId ?? resp.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawOrderLinkId = (resp.info as any)?.orderLinkId;

    console.log("\n══════════════════════════════════════════════════════");
    console.log("   ✅ SUCCESS! ORDER PLACED ON BYBIT                 ");
    console.log("══════════════════════════════════════════════════════");
    console.log(`CCXT Unified Order ID (resp.id) : ${resp.id}`);
    console.log(`Bybit Result Order ID           : ${rawOrderId}`);
    console.log(`Bybit Short ID (first 8 chars)  : ${String(rawOrderId).slice(0, 8)}`);
    console.log(`Bybit Order Link ID             : ${rawOrderLinkId ?? "none"}`);
    console.log("\nFull Raw Response from Bybit:");
    console.log(JSON.stringify(resp.info ?? resp, null, 2));
    console.log("══════════════════════════════════════════════════════\n");
    console.log("👉 Go to Bybit UI now: Check if this matches your Order ID or Position!\n");
  } catch (err: any) {
    console.error("\n❌ FAILED TO PLACE ORDER ON BYBIT:");
    console.error(err.message ?? err);
    process.exit(1);
  }
}

run();
