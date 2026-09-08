// ============================================================
// Execution Engine
//
// Responsibilities:
//   1. Candle-close validation — only acts on fully closed M5 bars
//   2. Per-candle execution lock — prevents duplicate orders in the
//      same 5-minute block
//   3. Order sanity validation — strict directional checks before sizing
//   4. Position sizing — risk-pct of account balance / ATR-based stop
//   5. CCXT precision normalization — tick/lot size compliance
//   6. Order placement — paper (simulated) or live via CCXT
//   7. Open trade tracking — monitors SL/TP and marks outcomes
//   8. maxOpenTrades guard
// ============================================================

import { Exchange } from "ccxt";
import { v4 as uuidv4 } from "uuid";
import {
  Signal,
  SignalDirection,
  StrategyId,
  Order,
  OrderStatus,
  Trade,
  TradeOutcome,
  BotConfig,
  Candle,
} from "../types";
import { BotLogger } from "../logger";
import { TradeLedger } from "./ledger";

// ── Internal state ─────────────────────────────────────────
interface ExecutionState {
  lastOrderCandleTs: number;
  openTrades: Map<string, Trade>;
  closedTrades: Trade[];
  dayStartBalance: number;   // balance snapshotted at first fetch of the day
  dayStartDate: string;      // YYYY-MM-DD in WAT to detect day rollover
}

// ── Sanity check result ─────────────────────────────────────
interface SanityCheckResult {
  valid: boolean;
  reason: string;
}

export class ExecutionEngine {
  private exchange: Exchange;
  private config: BotConfig;
  private state: ExecutionState;
  private logger: BotLogger;
  private ledger: TradeLedger;
  private latestBalanceInfo: { equity: number; walletBalance: number; availableBalance: number } = {
    equity: 0,
    walletBalance: 0,
    availableBalance: 0,
  };

  public onTradeUpdate: ((trade: Trade) => void) | null = null;

  constructor(exchange: Exchange, config: BotConfig, logger: BotLogger) {
    this.exchange = exchange;
    this.config = config;
    this.logger = logger;
    this.ledger = new TradeLedger();
    this.state = {
      lastOrderCandleTs: 0,
      openTrades: new Map(),
      closedTrades: [],
      dayStartBalance: 0,
      dayStartDate: "",
    };
  }

  // ──────────────────────────────────────────────────────────
  // Public: attempt to execute a signal
  // ──────────────────────────────────────────────────────────

  async execute(signal: Signal, triggerTs: number): Promise<Trade | null> {
    // ── 1. Execution lock ──────────────────────────────────
    if (triggerTs <= this.state.lastOrderCandleTs) {
      this.logger.warn("[Engine] Execution blocked — already acted on candle block", {
        candleTs: new Date(triggerTs).toISOString(),
      });
      return null;
    }

    // ── 2. Max open trades guard ───────────────────────────
    if (this.state.openTrades.size >= this.config.maxOpenTrades) {
      this.logger.warn("[Engine] Max open trades reached — skipping signal", {
        max: this.config.maxOpenTrades,
        current: this.state.openTrades.size,
      });
      return null;
    }

    // ── 3. Order sanity validation ─────────────────────────
    const sanity = this.validateSignal(signal);
    if (!sanity.valid) {
      this.logger.error("[Engine] Signal failed sanity check — aborting", {
        reason: sanity.reason,
        direction: signal.direction,
        entry: signal.entryPrice,
        sl: signal.stopLoss,
        tp: signal.takeProfit,
      });
      return null;
    }

    // ── 4. Fetch current balance ───────────────────────────
    const balance = await this.fetchBalance();
    if (balance <= 0) {
      this.logger.error("[Engine] Unable to fetch valid balance");
      return null;
    }

    // ── 5. Position sizing ─────────────────────────────────
    const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    const riskAmount = balance * this.config.riskPerTradePct;
    const rawSize = riskAmount / stopDistance;

    if (rawSize <= 0 || !isFinite(rawSize)) {
      this.logger.error("[Engine] Calculated size is invalid", {
        rawSize,
        riskAmount,
        stopDistance,
      });
      return null;
    }

    // ── 6. CCXT precision normalization ────────────────────
    const { entry, sl, tp, size } = this.normalizePrecision(
      signal.symbol,
      signal.entryPrice,
      signal.stopLoss,
      signal.takeProfit,
      rawSize
    );

    // ── 7. Place order (paper or live) ────────────────────
    const order = this.config.paperTrading
      ? this.paperOrder(signal, entry, sl, tp, size)
      : await this.liveOrder(signal, entry, sl, tp, size);

    if (!order) return null;

    // ── 8. Lock this candle block ──────────────────────────
    this.state.lastOrderCandleTs = triggerTs;

    // ── 9. Build Trade record ─────────────────────────────
    const trade: Trade = {
      id: uuidv4(),
      signalId: signal.id,
      order,
      symbol: signal.symbol,
      strategyId: signal.strategyId,
      flow: signal.flow,
      direction: signal.direction,
      entryPrice: order.entryPrice,
      exitPrice: null,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      size: order.size,
      pnlRaw: null,
      pnlR: null,
      outcome: TradeOutcome.OPEN,
      openedAt: Date.now(),
      closedAt: null,
      durationMs: null,
      indicators: signal.indicators,
      notes: `Strategy: ${signal.strategyId} | Flow: ${signal.flow.flow} | Score: ${
        signal.allScores.find((s) => s.strategyId === signal.strategyId)?.score ?? "?"
      }`,
    };

    this.state.openTrades.set(trade.id, trade);
    this.ledger.recordOpen(trade, order.entryPrice);
    this.onTradeUpdate?.(trade);

    this.logger.info("[Engine] Trade OPENED", {
      id: trade.id.slice(0, 8),
      direction: trade.direction,
      symbol: trade.symbol,
      entry,
      sl,
      tp,
      size,
    });

    return trade;
  }

  // ──────────────────────────────────────────────────────────
  // Public: check open trades against latest candle
  // ──────────────────────────────────────────────────────────

  checkOpenTrades(latestCandle: Candle): void {
    this.ledger.updateMarkPrice(latestCandle.close);

    for (const [, trade] of this.state.openTrades) {
      const { high, low } = latestCandle;

      let outcome: TradeOutcome | null = null;
      let exitPrice: number | null = null;

      if (trade.direction === SignalDirection.LONG) {
        if (low <= trade.stopLoss) {
          outcome = TradeOutcome.LOSS;
          exitPrice = trade.stopLoss;
        } else if (high >= trade.takeProfit) {
          outcome = TradeOutcome.WIN;
          exitPrice = trade.takeProfit;
        }
      } else {
        if (high >= trade.stopLoss) {
          outcome = TradeOutcome.LOSS;
          exitPrice = trade.stopLoss;
        } else if (low <= trade.takeProfit) {
          outcome = TradeOutcome.WIN;
          exitPrice = trade.takeProfit;
        }
      }

      if (outcome !== null && exitPrice !== null) {
        this.closeTrade(trade, exitPrice, outcome, latestCandle.timestamp);
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // Public: force-close all open trades (end of session)
  // ──────────────────────────────────────────────────────────

  closeAllAtMarket(currentPrice: number, reason: string = "Session end"): void {
    for (const [, trade] of this.state.openTrades) {
      const pnl =
        trade.direction === SignalDirection.LONG
          ? currentPrice - trade.entryPrice
          : trade.entryPrice - currentPrice;

      const outcome =
        pnl > 0
          ? TradeOutcome.WIN
          : pnl < 0
          ? TradeOutcome.LOSS
          : TradeOutcome.BREAKEVEN;

      this.closeTrade(trade, currentPrice, outcome, Date.now(), reason);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Getters
  // ──────────────────────────────────────────────────────────

  getOpenTrades(): Trade[] {
    return Array.from(this.state.openTrades.values());
  }

  getClosedTrades(): Trade[] {
    return this.state.closedTrades;
  }

  getOpenTradeCount(): number {
    return this.state.openTrades.size;
  }

  // ──────────────────────────────────────────────────────────
  // Public: initialise balance snapshot on startup
  // Call this once after the exchange is ready
  // ──────────────────────────────────────────────────────────

  async initBalance(): Promise<void> {
    const balance = await this.fetchBalance();
    this.snapshotDayStart(balance);
    this.ledger.initCapital(balance);
    this.logger.info("[Engine] Opening balance initialised", { balance });
  }

  getLedger(): TradeLedger {
    return this.ledger;
  }

  getDayStartBalance(): number {
    return this.state.dayStartBalance;
  }

  /**
   * Async version — fetches real balance from exchange when not paper trading.
   * Use this for the daily summary to get accurate closing balance.
   */
  async getCurrentBalanceAsync(): Promise<number> {
    if (this.config.paperTrading) {
      return this.getCurrentBalance();
    }
    return await this.fetchBalance();
  }

  /**
   * Sync version — paper balance adjusted by closed trade PnL.
   * Used internally where async is not available.
   */
  getCurrentBalance(): number {
    const totalPnl = this.state.closedTrades.reduce(
      (s, t) => s + (t.pnlRaw ?? 0),
      0
    );
    const base = this.state.dayStartBalance > 0
      ? this.state.dayStartBalance
      : this.config.paperBalance;
    return parseFloat((base + totalPnl).toFixed(4));
  }

  // ──────────────────────────────────────────────────────────
  // Private: order sanity validation
  // ──────────────────────────────────────────────────────────

  private validateSignal(signal: Signal): SanityCheckResult {
    const { direction, entryPrice, stopLoss, takeProfit } = signal;
    const stopDistance = Math.abs(entryPrice - stopLoss);

    if (stopDistance === 0) {
      return { valid: false, reason: "Stop distance is zero" };
    }

    if (direction === SignalDirection.LONG) {
      if (stopLoss >= entryPrice) {
        return {
          valid: false,
          reason: `LONG signal invalid: stopLoss (${stopLoss}) must be < entryPrice (${entryPrice})`,
        };
      }
      if (takeProfit <= entryPrice) {
        return {
          valid: false,
          reason: `LONG signal invalid: takeProfit (${takeProfit}) must be > entryPrice (${entryPrice})`,
        };
      }
    } else {
      if (stopLoss <= entryPrice) {
        return {
          valid: false,
          reason: `SHORT signal invalid: stopLoss (${stopLoss}) must be > entryPrice (${entryPrice})`,
        };
      }
      if (takeProfit >= entryPrice) {
        return {
          valid: false,
          reason: `SHORT signal invalid: takeProfit (${takeProfit}) must be < entryPrice (${entryPrice})`,
        };
      }
    }

    return { valid: true, reason: "OK" };
  }

  // ──────────────────────────────────────────────────────────
  // Private: CCXT precision normalization
  // ──────────────────────────────────────────────────────────

  /**
   * Normalizes all price and size values to the exchange's
   * tick size and lot size requirements using CCXT built-ins.
   * Falls back to raw values if the market is not found.
   */
  private normalizePrecision(
    symbol: string,
    entryPrice: number,
    stopLoss: number,
    takeProfit: number,
    size: number
  ): { entry: number; sl: number; tp: number; size: number } {
    try {
      const market = this.exchange.markets?.[symbol];
      if (!market) {
        this.logger.warn("[Engine] Market not found for precision normalization — using raw values", {
          symbol,
        });
        return { entry: entryPrice, sl: stopLoss, tp: takeProfit, size };
      }

      const entry = parseFloat(this.exchange.priceToPrecision(symbol, entryPrice));
      const sl = parseFloat(this.exchange.priceToPrecision(symbol, stopLoss));
      const tp = parseFloat(this.exchange.priceToPrecision(symbol, takeProfit));
      const normalizedSize = parseFloat(this.exchange.amountToPrecision(symbol, size));

      this.logger.debug("[Engine] Precision normalization applied", {
        raw: { entryPrice, stopLoss, takeProfit, size },
        normalized: { entry, sl, tp, size: normalizedSize },
      });

      return { entry, sl, tp, size: normalizedSize };
    } catch (err) {
      this.logger.warn("[Engine] Precision normalization failed — using raw values", {
        error: String(err),
      });
      return { entry: entryPrice, sl: stopLoss, tp: takeProfit, size };
    }
  }

  // ──────────────────────────────────────────────────────────
  // Private: trade closing
  // ──────────────────────────────────────────────────────────

  private closeTrade(
    trade: Trade,
    exitPrice: number,
    outcome: TradeOutcome,
    closedAt: number,
    notes?: string
  ): void {
    const stopDistance = Math.abs(trade.entryPrice - trade.stopLoss);
    const pnlRaw =
      trade.direction === SignalDirection.LONG
        ? (exitPrice - trade.entryPrice) * trade.size
        : (trade.entryPrice - exitPrice) * trade.size;

    const pnlR = stopDistance > 0 ? pnlRaw / (stopDistance * trade.size) : 0;

    const closed: Trade = {
      ...trade,
      exitPrice,
      pnlRaw: parseFloat(pnlRaw.toFixed(8)),
      pnlR: parseFloat(pnlR.toFixed(3)),
      outcome,
      closedAt,
      durationMs: closedAt - trade.openedAt,
      notes: notes ? `${trade.notes} | ${notes}` : trade.notes,
    };

    this.state.openTrades.delete(trade.id);
    this.state.closedTrades.push(closed);
    this.ledger.recordClose(closed);
    this.onTradeUpdate?.(closed);

    this.logger.info("[Engine] Trade CLOSED", {
      id: closed.id.slice(0, 8),
      outcome,
      pnl: `${pnlRaw.toFixed(4)} (${pnlR.toFixed(2)}R)`,
      exit: exitPrice,
    });
  }

  // ──────────────────────────────────────────────────────────
  // Private: order methods
  // ──────────────────────────────────────────────────────────

  private paperOrder(
    signal: Signal,
    entry: number,
    sl: number,
    tp: number,
    size: number
  ): Order {
    const now = Date.now();
    return {
      id: uuidv4(),
      exchangeOrderId: `PAPER-${uuidv4().slice(0, 8)}`,
      symbol: signal.symbol,
      direction: signal.direction,
      size,
      entryPrice: entry,
      stopLoss: sl,
      takeProfit: tp,
      status: OrderStatus.FILLED,
      placedAt: now,
      filledAt: now,
      closedAt: null,
    };
  }

  private async liveOrder(
    signal: Signal,
    entry: number,
    sl: number,
    tp: number,
    size: number
  ): Promise<Order | null> {
    const side = signal.direction === SignalDirection.LONG ? "buy" : "sell";
    const slSide = side === "buy" ? "sell" : "buy";
    const now = Date.now();

    const order: Order = {
      id: uuidv4(),
      exchangeOrderId: null,
      symbol: signal.symbol,
      direction: signal.direction,
      size,
      entryPrice: entry,
      stopLoss: sl,
      takeProfit: tp,
      status: OrderStatus.PENDING,
      placedAt: now,
      filledAt: null,
      closedAt: null,
    };

    try {
      // ── Entry market order with SL/TP attached ────────
      // Bybit futures requires SL and TP to be set on the
      // entry order directly, not as separate orders.
      const entryResp = await this.exchange.createOrder(
        signal.symbol,
        "market",
        side,
        size,
        undefined,
        {
          stopLoss: sl,
          takeProfit: tp,
          slTriggerBy: "LastPrice",
          tpTriggerBy: "LastPrice",
        }
      );
      order.exchangeOrderId = entryResp.id;
      order.status = OrderStatus.FILLED;
      order.filledAt = Date.now();

      // Fetch real execution details directly from Bybit API
      let actualFillPrice = entryResp.average ?? entryResp.price ?? entry;
      let actualFilledSize = entryResp.filled ?? size;
      let actualStopLoss = (entryResp as any).stopLoss ?? sl;
      let actualTakeProfit = (entryResp as any).takeProfit ?? tp;

      try {
        await new Promise((r) => setTimeout(r, 250));
        const fetched: any = await this.exchange.fetchOrder(entryResp.id, signal.symbol);
        if (fetched) {
          const p = fetched.average ?? fetched.price;
          if (p && p > 0) actualFillPrice = p;
          if (fetched.filled && fetched.filled > 0) actualFilledSize = fetched.filled;
          const fetchedSl = parseFloat(fetched.stopLoss ?? fetched.info?.stopLoss);
          const fetchedTp = parseFloat(fetched.takeProfit ?? fetched.info?.takeProfit);
          if (fetchedSl && fetchedSl > 0) actualStopLoss = fetchedSl;
          if (fetchedTp && fetchedTp > 0) actualTakeProfit = fetchedTp;
        }
      } catch (fErr) {
        this.logger.warn("[Engine] Could not fetch filled order details from Bybit API", { error: String(fErr) });
      }

      order.entryPrice = actualFillPrice;
      order.size = actualFilledSize;
      order.stopLoss = actualStopLoss;
      order.takeProfit = actualTakeProfit;

      // Query Bybit for Tran ID (Trade History) and TP/SL IDs (Current Orders)
      try {
        const openOrders: any[] = await this.exchange.fetchOpenOrders(signal.symbol);
        for (const o of openOrders) {
          const id8 = (o.id ?? "").slice(-8);
          if (o.info?.stopOrderType === "TakeProfit" || (o.takeProfit && o.takeProfit > 0) || o.info?.orderType === "TakeProfit") {
            order.bybitTpId = id8;
          } else if (o.info?.stopOrderType === "StopLoss" || (o.stopLoss && o.stopLoss > 0) || o.info?.orderType === "StopLoss") {
            order.bybitSlId = id8;
          }
        }
        if (!order.bybitTpId && !order.bybitSlId && openOrders.length > 0) {
          const ids = openOrders.map((o) => (o.id ?? "").slice(-8));
          if (ids[0]) order.bybitTpId = ids[0];
          if (ids[1]) order.bybitSlId = ids[1];
        }

        const myTrades = await this.exchange.fetchMyTrades(signal.symbol, undefined, 2);
        if (myTrades.length > 0) {
          const matchTrade = myTrades.find((t) => t.order === entryResp.id) ?? myTrades[myTrades.length - 1];
          if (matchTrade) {
            order.bybitTranId = (matchTrade.id ?? (matchTrade.info as any)?.execId ?? "").slice(-8);
          }
        }
      } catch (fErr) {
        // non-fatal
      }

      const rawOrderId = (entryResp.info as any)?.orderId ?? entryResp.id;
      const rawOrderLinkId = (entryResp.info as any)?.orderLinkId;

      console.log("\n═════════════════════════════════════════════════════");
      console.log("             BYBIT LIVE ORDER PLACED                 ");
      console.log("═════════════════════════════════════════════════════");
      console.log("CCXT entryResp.id  :", entryResp.id);
      console.log("Order ID (slice-8) :", (rawOrderId ?? "").slice(-8));
      console.log("Tran ID            :", order.bybitTranId ?? "—");
      console.log("TP / SL Order IDs  :", `${order.bybitTpId ?? "—"} / ${order.bybitSlId ?? "—"}`);
      console.log("Fill Price (Bybit) :", order.entryPrice);
      console.log("Filled Size (Bybit):", order.size);
      console.log("Full Bybit response:", JSON.stringify(entryResp.info ?? entryResp, null, 2));
      console.log("═════════════════════════════════════════════════════\n");

      this.logger.info("[Engine] Live order placed", {
        entryOrderId: entryResp.id,
        bybitOrderId: (rawOrderId ?? "").slice(-8),
        tranId: order.bybitTranId,
        tpId: order.bybitTpId,
        slId: order.bybitSlId,
        fillPrice: order.entryPrice,
        size: order.size,
        sl: order.stopLoss,
        tp: order.takeProfit,
      });
    } catch (err) {
      console.error("\n❌ [Engine] Order placement FAILED:", err);
      this.logger.error("[Engine] Order placement failed", { error: String(err) });
      order.status = OrderStatus.REJECTED;
      return null;
    }

    return order;
  }

  // ──────────────────────────────────────────────────────────
  // Public: place a real minimal test trade (for /testtrade)
  // Places the smallest valid market order with SL/TP on Bybit
  // so the user can verify the Bybit order ID matches Telegram.
  // ──────────────────────────────────────────────────────────

  async placeTestTrade(): Promise<Trade | null> {
    try {
      // 1. Get current price
      const ticker = await this.exchange.fetchTicker(this.config.symbol);
      let price = ticker.last ?? ticker.close ?? 0;
      if (price <= 0) throw new Error("Could not fetch current price");

      // 2. Use minimum allowed size for BTC/USDT:USDT on Bybit (0.001 BTC)
      const market = this.exchange.markets?.[this.config.symbol];
      const minSize = market?.limits?.amount?.min ?? 0.001;
      let rawSize = parseFloat(
        this.exchange.amountToPrecision(this.config.symbol, minSize)
      );

      // 3. Tight SL/TP — 0.5% away (minimum to pass Bybit validation)
      let sl = parseFloat(
        this.exchange.priceToPrecision(this.config.symbol, price * 0.995)
      );
      let tp = parseFloat(
        this.exchange.priceToPrecision(this.config.symbol, price * 1.005)
      );

      this.logger.info("[Engine] Placing test trade", { price, size: rawSize, sl, tp });

      // 4. Place the order (paper or live)
      let exchangeOrderId: string | null = null;
      let bybitTranId: string | undefined;
      let bybitTpId: string | undefined;
      let bybitSlId: string | undefined;

      const hasApiKey = Boolean(this.exchange.apiKey && this.exchange.apiKey.trim().length > 5);

      if (!hasApiKey && this.config.paperTrading) {
        exchangeOrderId = `PAPER-${uuidv4().slice(0, 8)}`;
        console.log(`[Engine] No live API key configured; created paper test trade: ${exchangeOrderId}`);
      } else {
        console.log(`[Engine] Submitting real minimal test trade to Bybit (${rawSize} ${this.config.symbol})...`);
        const resp = await this.exchange.createOrder(
          this.config.symbol,
          "market",
          "buy",
          rawSize,
          undefined,
          {
            stopLoss: sl,
            takeProfit: tp,
            slTriggerBy: "LastPrice",
            tpTriggerBy: "LastPrice",
          }
        );
        exchangeOrderId = resp.id;

        // Fetch real execution details from Bybit
        try {
          await new Promise((r) => setTimeout(r, 250));
          const fetched: any = await this.exchange.fetchOrder(resp.id, this.config.symbol);
          if (fetched) {
            const p = fetched.average ?? fetched.price;
            if (p && p > 0) price = p;
            if (fetched.filled && fetched.filled > 0) rawSize = fetched.filled;
            const fetchedSl = parseFloat(fetched.stopLoss ?? fetched.info?.stopLoss);
            const fetchedTp = parseFloat(fetched.takeProfit ?? fetched.info?.takeProfit);
            if (fetchedSl && fetchedSl > 0) sl = fetchedSl;
            if (fetchedTp && fetchedTp > 0) tp = fetchedTp;
          }
        } catch (fErr) {
          this.logger.warn("[Engine] Could not fetch filled order details for test trade", { error: String(fErr) });
        }

        try {
          const openOrders: any[] = await this.exchange.fetchOpenOrders(this.config.symbol);
          for (const o of openOrders) {
            const id8 = (o.id ?? "").slice(-8);
            if (o.info?.stopOrderType === "TakeProfit" || (o.takeProfit && o.takeProfit > 0) || o.info?.orderType === "TakeProfit") {
              bybitTpId = id8;
            } else if (o.info?.stopOrderType === "StopLoss" || (o.stopLoss && o.stopLoss > 0) || o.info?.orderType === "StopLoss") {
              bybitSlId = id8;
            }
          }
          if (!bybitTpId && !bybitSlId && openOrders.length > 0) {
            const ids = openOrders.map((o) => (o.id ?? "").slice(-8));
            if (ids[0]) bybitTpId = ids[0];
            if (ids[1]) bybitSlId = ids[1];
          }

          const myTrades = await this.exchange.fetchMyTrades(this.config.symbol, undefined, 2);
          if (myTrades.length > 0) {
            const matchTrade = myTrades.find((t: any) => t.order === resp.id) ?? myTrades[myTrades.length - 1];
            if (matchTrade) {
              bybitTranId = (matchTrade.id ?? (matchTrade.info as any)?.execId ?? "").slice(-8);
            }
          }
        } catch (fErr) {
          // non-fatal
        }

        const rawOrderId = (resp.info as any)?.orderId ?? resp.id;
        const rawOrderLinkId = (resp.info as any)?.orderLinkId;

        console.log("\n═════════════════════════════════════════════════════");
        console.log("             BYBIT TEST TRADE PLACED                 ");
        console.log("═════════════════════════════════════════════════════");
        console.log("CCXT resp.id       :", resp.id);
        console.log("Order ID (slice-8) :", (rawOrderId ?? "").slice(-8));
        console.log("Tran ID            :", bybitTranId ?? "—");
        console.log("TP / SL Order IDs  :", `${bybitTpId ?? "—"} / ${bybitSlId ?? "—"}`);
        console.log("Fill Price (Bybit) :", price);
        console.log("Filled Size (Bybit):", rawSize);
        console.log("Full Bybit response:", JSON.stringify(resp.info ?? resp, null, 2));
        console.log("═════════════════════════════════════════════════════\n");

        this.logger.info("[Engine] Test trade placed on Bybit", {
          orderId: exchangeOrderId,
          bybitOrderId: (rawOrderId ?? "").slice(-8),
          tranId: bybitTranId,
          tpId: bybitTpId,
          slId: bybitSlId,
          fillPrice: price,
          size: rawSize,
        });
      }

      // 5. Build trade record and register in ledger/state
      const now = Date.now();
      const order: Order = {
        id: uuidv4(),
        exchangeOrderId,
        symbol: this.config.symbol,
        direction: SignalDirection.LONG,
        size: rawSize,
        entryPrice: price,
        stopLoss: sl,
        takeProfit: tp,
        status: OrderStatus.FILLED,
        placedAt: now,
        filledAt: now,
        closedAt: null,
        bybitTranId,
        bybitTpId,
        bybitSlId,
      };

      const trade: Trade = {
        id: uuidv4(),
        signalId: "TEST",
        order,
        symbol: this.config.symbol,
        strategyId: StrategyId.TREND_PULLBACK_EMA,
        flow: { flow: "BULLISH", confidence: 1, h1Bias: "BULLISH", h4Bias: "BULLISH", macroBias: "BULLISH" } as any,
        direction: SignalDirection.LONG,
        entryPrice: price,
        exitPrice: null,
        stopLoss: sl,
        takeProfit: tp,
        size: rawSize,
        pnlRaw: null,
        pnlR: null,
        outcome: TradeOutcome.OPEN,
        openedAt: now,
        closedAt: null,
        durationMs: null,
        indicators: null as any,
        notes: "Strategy: TEST_TRADE | Flow: BULLISH | Score: 100",
      };

      this.state.openTrades.set(trade.id, trade);
      this.ledger.recordOpen(trade, price);
      this.onTradeUpdate?.(trade);

      return trade;
    } catch (err) {
      this.logger.error("[Engine] Test trade failed", { error: String(err) });
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Public / Private: balance fetching
  // ──────────────────────────────────────────────────────────

  async fetchLiveAccountBalance(): Promise<{
    equity: number;
    walletBalance: number;
    availableBalance: number;
  }> {
    if (this.config.paperTrading) {
      const pnl = this.state.closedTrades.reduce((s, t) => s + (t.pnlRaw ?? 0), 0);
      const base = this.state.dayStartBalance > 0 ? this.state.dayStartBalance : this.config.paperBalance;
      const current = parseFloat((base + pnl).toFixed(4));
      const res = { equity: current, walletBalance: current, availableBalance: current };
      this.latestBalanceInfo = res;
      this.snapshotDayStart(current);
      return res;
    }

    try {
      const balances = await this.exchange.fetchBalance({ type: "unified" });
      const quote = this.config.symbol.split("/")[1]?.split(":")[0] ?? "USDT";

      const infoList = (balances as any)?.info?.result?.list;
      const uAccount = Array.isArray(infoList) ? infoList[0] : null;

      const totalEquity = uAccount?.totalEquity ? parseFloat(uAccount.totalEquity) : 0;
      const totalWallet = uAccount?.totalWalletBalance ? parseFloat(uAccount.totalWalletBalance) : 0;
      const totalAvail = uAccount?.totalAvailableBalance ? parseFloat(uAccount.totalAvailableBalance) : 0;

      const coinObj = uAccount?.coin?.find((c: any) => c?.coin === quote);
      const coinWallet = coinObj?.walletBalance ? parseFloat(coinObj.walletBalance) : 0;
      const coinEquity = coinObj?.equity ? parseFloat(coinObj.equity) : 0;

      const ccxtTotal = (balances?.total as unknown as Record<string, number | undefined>)?.[quote] ?? 0;
      const ccxtFree = (balances?.free as unknown as Record<string, number | undefined>)?.[quote] ?? 0;

      const finalEquity = totalEquity > 0 ? totalEquity : (coinEquity > 0 ? coinEquity : (ccxtTotal > 0 ? ccxtTotal : coinWallet));
      const finalWallet = totalWallet > 0 ? totalWallet : (coinWallet > 0 ? coinWallet : (ccxtTotal > 0 ? ccxtTotal : finalEquity));
      const finalAvail = totalAvail > 0 ? totalAvail : (ccxtFree > 0 ? ccxtFree : finalWallet);

      const res = {
        equity: parseFloat(finalEquity.toFixed(4)),
        walletBalance: parseFloat(finalWallet.toFixed(4)),
        availableBalance: parseFloat(finalAvail.toFixed(4)),
      };

      this.latestBalanceInfo = res;
      this.snapshotDayStart(res.equity > 0 ? res.equity : res.walletBalance);
      return res;
    } catch (err) {
      this.logger.error("[Engine] fetchLiveAccountBalance failed", { error: String(err) });
      return this.latestBalanceInfo;
    }
  }

  async fetchBalance(): Promise<number> {
    const live = await this.fetchLiveAccountBalance();
    return live.equity > 0 ? live.equity : live.walletBalance;
  }

  getLatestBalanceInfo(): { equity: number; walletBalance: number; availableBalance: number } {
    if (this.latestBalanceInfo.equity === 0) {
      const pnl = this.state.closedTrades.reduce((s, t) => s + (t.pnlRaw ?? 0), 0);
      const base = this.state.dayStartBalance > 0 ? this.state.dayStartBalance : this.config.paperBalance;
      const current = parseFloat((base + pnl).toFixed(4));
      return { equity: current, walletBalance: current, availableBalance: current };
    }
    return this.latestBalanceInfo;
  }

  /**
   * Snapshots the opening balance once per WAT calendar day.
   * WAT = UTC+1, so midnight WAT = 23:00 UTC previous day.
   */
  private snapshotDayStart(balance: number): void {
    const watDate = new Date(Date.now() + 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10); // YYYY-MM-DD in WAT

    if (this.state.dayStartDate !== watDate) {
      this.state.dayStartDate = watDate;
      this.state.dayStartBalance = balance;
      this.logger.info("[Engine] Day start balance snapshot", {
        date: watDate,
        balance,
      });
    }
  }
}
