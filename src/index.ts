// ============================================================
// Bot Entry Point — Orchestrator
//
// Boot sequence:
//   1. Load config from environment
//   2. Connect to exchange (sandbox or live)
//   3. Wire up all subsystems
//   4. Enter the main loop — polls for new closed M5 candles 24/7
//   5. On each new closed candle:
//      a. Fetch H1/H4 context candles
//      b. Run FlowClassifier → get signal or null
//      c. Log the evaluation record
//      d. If signal: log it, attempt execution
//      e. Check all open trades for SL/TP hits
//   6. Daily summary at 00:00 WAT (23:00 UTC) — read-only, never
//      closes open trades
//   7. Graceful shutdown on SIGINT/SIGTERM
//
// Notes on candle alignment:
//   - M5 candles fetched from Bybit use NY-close alignment
//     (candle day boundary at 17:00 UTC / midnight NY time).
//   - VWAP resets daily at NY session open (13:00 UTC) so the
//     deviation metric stays meaningful intraday.
// ============================================================

import "dotenv/config";
import ccxt, { Exchange } from "ccxt";
import { BotConfig, Candle, EvaluationRecord } from "./types";
import { FlowClassifier } from "./classifier";
import { ExecutionEngine } from "./execution";
import { BotLogger } from "./logger";
import { buildStrategyRegistry } from "./strategies";
import { startHealthServer, registerTestSummaryCallback } from "./healthCheck";
import { TelegramNotifier } from "./notifications";
import { TelegramPoller } from "./notifications/telegramPoller";
import { GeminiAnalyst, BotContext } from "./analyst";
import { v4 as uuidv4 } from "uuid";

// ============================================================
// 1. Load & validate configuration
// ============================================================

function loadConfig(): BotConfig {
  const required = ["EXCHANGE_ID", "API_KEY", "API_SECRET", "SYMBOL"];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return {
    symbol: process.env.SYMBOL!,
    timeframe: process.env.TIMEFRAME ?? "5m",
    riskPerTradePct: parseFloat(process.env.RISK_PER_TRADE_PCT ?? "0.01"),
    riskRewardRatio: parseFloat(process.env.RISK_REWARD_RATIO ?? "2"),
    atrMultiplierSL: parseFloat(process.env.ATR_MULTIPLIER_SL ?? "1.5"),
    // NY session open hour (UTC) — used only to anchor the rolling VWAP.
    // Does NOT gate trade execution.
    sessionStartUTC: parseInt(process.env.SESSION_START_UTC ?? "13", 10),
    sessionEndUTC: parseInt(process.env.SESSION_END_UTC ?? "21", 10),
    h1Timeframe: "1h",
    h4Timeframe: "4h",
    minVolumeMultiplier: parseFloat(process.env.MIN_VOLUME_MULTIPLIER ?? "0.8"),
    maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES ?? "2", 10),
    paperTrading: process.env.PAPER_TRADING !== "false",
    paperBalance: parseFloat(process.env.PAPER_BALANCE ?? "10000"),
  };
}

// ============================================================
// 2. Exchange factory
// ============================================================

function buildExchange(config: BotConfig): Exchange {
  const exchangeId = process.env.EXCHANGE_ID!;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExchangeClass = (ccxt as any)[exchangeId];
  if (!ExchangeClass) {
    throw new Error(`Unknown CCXT exchange: ${exchangeId}`);
  }

  const isDemoMode =
    process.env.BYBIT_DEMO_MODE === "true" &&
    process.env.EXCHANGE_ID === "bybit";

  const exchange: Exchange = new ExchangeClass({
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

  const sandboxMode = process.env.SANDBOX_MODE === "true";
  if (sandboxMode) {
    exchange.setSandboxMode(true);
  }

  return exchange;
}

// ============================================================
// 3. CCXT candle fetching helpers
// ============================================================

async function fetchClosedCandles(
  exchange: Exchange,
  symbol: string,
  timeframe: string,
  limit: number
): Promise<Candle[]> {
  const raw = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit + 1);
  const closed = raw.slice(0, -1);
  return closed.map((c) => ({
    timestamp: c[0] as number,
    open: c[1] as number,
    high: c[2] as number,
    low: c[3] as number,
    close: c[4] as number,
    volume: c[5] as number,
  }));
}

// ============================================================
// 4. VWAP anchor — filter candles to current NY session
//    Resets at 13:00 UTC (NY open) regardless of when the bot
//    is running, so VWAP deviation always reflects the live
//    intraday stretch from the NY open price anchor.
// ============================================================

function filterNYSessionCandles(candles: Candle[], nyOpenHourUTC: number): Candle[] {
  const now = new Date();

  // Determine the most recent NY open timestamp
  // If current UTC hour >= nyOpenHourUTC → today's open
  // If current UTC hour < nyOpenHourUTC → yesterday's open
  const utcHour = now.getUTCHours();
  const dayOffset = utcHour >= nyOpenHourUTC ? 0 : -1;

  const anchorDate = new Date(now);
  anchorDate.setUTCDate(anchorDate.getUTCDate() + dayOffset);
  anchorDate.setUTCHours(nyOpenHourUTC, 0, 0, 0);

  const anchorTs = anchorDate.getTime();
  return candles.filter((c) => c.timestamp >= anchorTs);
}

// ============================================================
// 5. Daily summary trigger — fires once at 23:00 UTC (00:00 WAT)
//    Read-only: never closes or modifies open trades.
// ============================================================

function isMidnightWAT(): boolean {
  const now = new Date();
  // WAT = UTC+1 → midnight WAT = 23:00 UTC
  return now.getUTCHours() === 23 && now.getUTCMinutes() === 0;
}

// ============================================================
// 6. Main TradingBot class
// ============================================================

class TradingBot {
  private config: BotConfig;
  private exchange: Exchange;
  private classifier: FlowClassifier;
  private engine: ExecutionEngine;
  private logger: BotLogger;
  private telegram: TelegramNotifier;
  private analyst: GeminiAnalyst;
  private poller: TelegramPoller | null = null;
  private lastSignal: any = null; // stored for Gemini context

  private lastProcessedCandleTs: number = 0;
  private dailySummaryFiredDate: string = "";
  private running: boolean = false;

  constructor(
    config: BotConfig,
    exchange: Exchange,
    classifier: FlowClassifier,
    engine: ExecutionEngine,
    logger: BotLogger,
    telegram: TelegramNotifier,
    analyst: GeminiAnalyst
  ) {
    this.config = config;
    this.exchange = exchange;
    this.classifier = classifier;
    this.engine = engine;
    this.logger = logger;
    this.telegram = telegram;
    this.analyst = analyst;

    // Wire trade events to logger + telegram + gemini
    this.engine.onTradeUpdate = (trade) => {
      this.logger.logTrade(trade);

      if (trade.outcome === "OPEN") {
        const scoreMatch = trade.notes.match(/Score:\s*(\d+)/);
        const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;

        this.telegram.notifyTradeOpen({
          id: trade.id,
          strategy: trade.strategyId,
          direction: trade.direction,
          symbol: trade.symbol,
          entry: trade.entryPrice,
          stopLoss: trade.stopLoss,
          takeProfit: trade.takeProfit,
          size: trade.size,
          flow: trade.flow.flow,
          score,
        });

        // Gemini proactive analysis on trade open
        if (this.lastSignal && this.analyst.isEnabled()) {
          const ctx = this.buildContext();
          this.analyst.analyzeTradeOpen(trade, this.lastSignal, ctx).then((insight) => {
            if (insight) {
              this.telegram.notifyError(`🤖 AI Analyst:\n\n${insight}`);
            }
          }).catch(() => {});
        }
      } else {
        this.telegram.notifyTradeClose({
          id: trade.id,
          outcome: trade.outcome,
          pnlRaw: trade.pnlRaw ?? 0,
          pnlR: trade.pnlR ?? 0,
          exitPrice: trade.exitPrice ?? 0,
          strategy: trade.strategyId,
          durationMin: Math.round((trade.durationMs ?? 0) / 60000),
        });

        // Gemini proactive analysis on trade close
        if (this.analyst.isEnabled()) {
          const ctx = this.buildContext();
          this.analyst.analyzeTradeClose(trade, ctx).then((insight) => {
            if (insight) {
              this.telegram.notifyError(`🤖 AI Analyst:\n\n${insight}`);
            }
          }).catch(() => {});
        }
      }
    };
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.info("Bot started — running 24/7", {
      symbol: this.config.symbol,
      paperTrading: this.config.paperTrading,
      vwapAnchorUTC: `${this.config.sessionStartUTC}:00`,
      dailySummaryWAT: "00:00 (23:00 UTC)",
    });

    this.telegram.notifyBotStarted(
      this.config.symbol,
      "24/7 — daily summary at 00:00 WAT"
    );

    // Register test summary endpoint
    registerTestSummaryCallback(() => this.fireDailySummary(true));

    // Start Telegram message poller for chat with Gemini
    const token = process.env.TELEGRAM_TOKEN ?? "";
    const chatId = process.env.TELEGRAM_CHAT_ID ?? "";
    if (token && chatId && this.analyst.isEnabled()) {
      this.poller = new TelegramPoller(token, chatId);
      this.poller.setMessageHandler(async (id, text, fromName) => {
        this.logger.info(`[Chat] Message from ${fromName}: ${text}`);
        const ctx = this.buildContext();
        const reply = await this.analyst.chat(text, ctx);
        await this.poller!.sendMessage(id, `🤖 AI Analyst:\n\n${reply}`);
      });
      this.poller.start();
    }

    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));

    await this.loop();
  }

  private async loop(): Promise<void> {
    const POLL_INTERVAL_MS = 15_000;

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.logger.error("Unhandled error in main loop tick", {
          error: String(err),
        });
      }

      await sleep(POLL_INTERVAL_MS);
    }
  }

  private async tick(): Promise<void> {
    // ── Daily summary — fires once at 23:00 UTC (00:00 WAT) ──
    // Read-only: closed trades only, open positions untouched.
    if (isMidnightWAT()) {
      await this.fireDailySummary();
    }

    // ── Fetch M5 candles (300 ≈ 25 hours) ─────────────────
    const m5Candles = await fetchClosedCandles(
      this.exchange,
      this.config.symbol,
      this.config.timeframe,
      300
    );

    if (m5Candles.length < 50) {
      this.logger.warn("Insufficient M5 candles returned", {
        count: m5Candles.length,
      });
      return;
    }

    const latestCandle = m5Candles[m5Candles.length - 1];

    // ── Deduplication ──────────────────────────────────────
    if (latestCandle.timestamp <= this.lastProcessedCandleTs) {
      return;
    }

    this.logger.debug(
      `New M5 candle: ${new Date(latestCandle.timestamp).toISOString()} close=${latestCandle.close}`
    );

    // ── Fetch H1 / H4 context ──────────────────────────────
    const [h1Candles, h4Candles] = await Promise.all([
      fetchClosedCandles(this.exchange, this.config.symbol, this.config.h1Timeframe, 100),
      fetchClosedCandles(this.exchange, this.config.symbol, this.config.h4Timeframe, 100),
    ]);

    // ── VWAP anchor: NY session candles only ───────────────
    const nySessionCandles = filterNYSessionCandles(
      m5Candles,
      this.config.sessionStartUTC
    );

    // ── Check open trades for SL/TP hits ──────────────────
    this.engine.checkOpenTrades(latestCandle);

    // ── Run flow classifier ────────────────────────────────
    const output = this.classifier.classify(
      m5Candles,
      h1Candles,
      h4Candles,
      nySessionCandles,
      this.config.atrMultiplierSL,
      this.config.riskRewardRatio,
      this.config.symbol
    );

    // ── Build and log evaluation record ───────────────────
    const evalRecord: EvaluationRecord = {
      id: uuidv4(),
      timestamp: Date.now(),
      symbol: this.config.symbol,
      candleTimestamp: latestCandle.timestamp,
      flow: output.flow,
      strategyScores: output.results.map((r) => ({
        strategyId: r.strategyId,
        score: r.score,
        triggered: r.triggered,
        reason: r.reason,
      })),
      winningStrategy: output.winner?.strategyId ?? null,
      signalFired: output.signal !== null,
      signal: output.signal,
      indicators: output.indicators,
      sessionActive: true,
    };

    this.logger.logEvaluation(evalRecord);

    // ── Execute signal if present ──────────────────────────
    if (output.signal) {
      this.lastSignal = output.signal; // store for Gemini context
      this.logger.logSignal(output.signal);

      const trade = await this.engine.execute(
        output.signal,
        latestCandle.timestamp
      );

      if (trade) {
        this.logger.info("Trade execution confirmed", {
          tradeId: trade.id.slice(0, 8),
          strategy: trade.strategyId,
        });
      }
    }

    this.lastProcessedCandleTs = latestCandle.timestamp;
  }

  // ──────────────────────────────────────────────────────────
  // Daily summary — fires once per calendar day at 00:00 WAT
  // Reads closed trades only. Open trades are never touched.
  // ──────────────────────────────────────────────────────────

  private async fireDailySummary(force: boolean = false): Promise<void> {
    // Build today's date string in WAT for deduplication
    const watDate = new Date(Date.now() + 60 * 60 * 1000) // UTC+1
      .toISOString()
      .slice(0, 10); // YYYY-MM-DD

    if (!force && this.dailySummaryFiredDate === watDate) {
      return; // already fired today
    }

    this.dailySummaryFiredDate = watDate;

    const closedTrades = this.engine.getClosedTrades();
    const openTrades = this.engine.getOpenTrades();

    const wins = closedTrades.filter((t) => t.outcome === "WIN").length;
    const losses = closedTrades.filter((t) => t.outcome === "LOSS").length;
    const be = closedTrades.filter((t) => t.outcome === "BREAKEVEN").length;
    const totalR = closedTrades.reduce((s, t) => s + (t.pnlR ?? 0), 0);
    const totalPnl = closedTrades.reduce((s, t) => s + (t.pnlRaw ?? 0), 0);
    const winRate =
      wins + losses > 0
        ? ((wins / (wins + losses)) * 100).toFixed(1)
        : "0";

    // Log to file
    this.logger.logSessionSummary(closedTrades, Date.now() - 86_400_000, Date.now());

    // Send Telegram — includes open trade count as context
    this.telegram.notifySessionSummary({
      date: `${watDate} (daily @ 00:00 WAT)`,
      totalTrades: closedTrades.length,
      wins,
      losses,
      totalR: parseFloat(totalR.toFixed(2)),
      totalPnl: parseFloat(totalPnl.toFixed(4)),
      winRate,
      openingBalance: this.engine.getDayStartBalance(),
      closingBalance: await this.engine.getCurrentBalanceAsync(),
    });

    // Append open positions note
    if (openTrades.length > 0) {
      const openSummary = openTrades
        .map(
          (t) =>
            `• ${t.direction} @ ${t.entryPrice} | SL=${t.stopLoss} | TP=${t.takeProfit}`
        )
        .join("\n");

      this.telegram.isEnabled() && this.sendOpenPositionsNote(openSummary);
    }

    this.logger.info("Daily summary fired", {
      date: watDate,
      closedTrades: closedTrades.length,
      openTrades: openTrades.length,
      totalR,
    });

    // Gemini daily analysis
    if (this.analyst.isEnabled()) {
      const ctx = this.buildContext();
      this.analyst.analyzeDailySummary(ctx).then((insight) => {
        if (insight) {
          this.telegram.notifyError(`🤖 AI Daily Analysis:\n\n${insight}`);
        }
      }).catch(() => {});
    }
  }

  private sendOpenPositionsNote(summary: string): void {
    // Access internal send method via the notifier
    // We reuse notifyError as an informal channel for the open positions note
    this.telegram.notifyError(
      `📋 <b>Open Positions at midnight WAT</b>\n${summary}\n\n<i>These positions were not modified.</i>`
    );
  }

  private buildContext(): BotContext {
    const closed = this.engine.getClosedTrades();
    const open = this.engine.getOpenTrades();
    const opening = this.engine.getDayStartBalance();
    const current = this.engine.getCurrentBalance();

    return {
      timestamp: new Date().toISOString(),
      symbol: this.config.symbol,
      balance: {
        opening,
        current,
        changePct: opening > 0
          ? parseFloat(((current - opening) / opening * 100).toFixed(2))
          : 0,
      },
      session: {
        closedTrades: closed.length,
        wins: closed.filter((t) => t.outcome === "WIN").length,
        losses: closed.filter((t) => t.outcome === "LOSS").length,
        totalR: parseFloat(closed.reduce((s, t) => s + (t.pnlR ?? 0), 0).toFixed(2)),
        winRate: closed.length > 0
          ? ((closed.filter((t) => t.outcome === "WIN").length / closed.length) * 100).toFixed(1)
          : "0",
      },
      openTrades: open.map((t) => ({
        direction: t.direction,
        entryPrice: t.entryPrice,
        stopLoss: t.stopLoss,
        takeProfit: t.takeProfit,
        strategy: t.strategyId,
        openedMinsAgo: Math.round((Date.now() - t.openedAt) / 60000),
      })),
      lastSignal: this.lastSignal
        ? {
            strategy: this.lastSignal.strategyId,
            direction: this.lastSignal.direction,
            score: this.lastSignal.allScores?.find((s: any) => s.strategyId === this.lastSignal.strategyId)?.score ?? 0,
            flow: this.lastSignal.flow.flow,
            macroBias: this.lastSignal.flow.macroBias,
            rsi: this.lastSignal.indicators.rsi14,
            atr: this.lastSignal.indicators.atr14,
            vwapDevPct: this.lastSignal.indicators.vwap.deviationPct,
            volumeMultiplier: this.lastSignal.indicators.volumeMultiplier,
            entry: this.lastSignal.entryPrice,
            sl: this.lastSignal.stopLoss,
            tp: this.lastSignal.takeProfit,
          }
        : null,
      currentFlow: "UNKNOWN",
      recentTrades: closed.slice(-5).map((t) => ({
        strategy: t.strategyId,
        direction: t.direction,
        outcome: t.outcome,
        pnlR: t.pnlR ?? 0,
        durationMin: Math.round((t.durationMs ?? 0) / 60000),
      })),
    };
  }

  private async fetchLastPrice(): Promise<number> {
    try {
      const ticker = await this.exchange.fetchTicker(this.config.symbol);
      return ticker.last ?? ticker.close ?? 0;
    } catch {
      const m5 = await fetchClosedCandles(
        this.exchange,
        this.config.symbol,
        this.config.timeframe,
        2
      );
      return m5[m5.length - 1]?.close ?? 0;
    }
  }

  private async shutdown(signal: string): Promise<void> {
    this.logger.info(`Shutdown signal received: ${signal}`);
    this.running = false;

    if (this.engine.getOpenTradeCount() > 0) {
      this.logger.warn("Closing open trades before shutdown...");
      const lastPrice = await this.fetchLastPrice().catch(() => 0);
      if (lastPrice > 0) {
        this.engine.closeAllAtMarket(lastPrice, `Shutdown: ${signal}`);
      }
    }

    if (this.engine.getClosedTrades().length > 0) {
      this.logger.logSessionSummary(
        this.engine.getClosedTrades(),
        Date.now() - 86_400_000,
        Date.now()
      );
    }

    this.logger.info("Bot shut down cleanly");
    process.exit(0);
  }
}

// ============================================================
// 7. Bootstrap
// ============================================================

async function main(): Promise<void> {
  const healthPort = parseInt(process.env.PORT ?? "3000", 10);
  startHealthServer(healthPort);

  const config = loadConfig();
  const exchange = buildExchange(config);
  const logger = new BotLogger();

  logger.info("Connecting to exchange...", {
    exchange: process.env.EXCHANGE_ID,
    demoMode: process.env.BYBIT_DEMO_MODE === "true",
    paperTrading: config.paperTrading,
  });

  await exchange.loadMarkets();
  logger.info("Markets loaded");

  const strategies = buildStrategyRegistry();
  const classifier = new FlowClassifier(strategies);
  const engine = new ExecutionEngine(exchange, config, logger);

  // Fetch and snapshot real opening balance immediately on startup
  await engine.initBalance();

  const telegram = new TelegramNotifier();
  const analyst = new GeminiAnalyst();

  const bot = new TradingBot(config, exchange, classifier, engine, logger, telegram, analyst);
  await bot.start();
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
