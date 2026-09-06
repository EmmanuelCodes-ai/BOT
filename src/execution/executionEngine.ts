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
  Order,
  OrderStatus,
  Trade,
  TradeOutcome,
  BotConfig,
  Candle,
} from "../types";
import { BotLogger } from "../logger";

// ── Internal state ─────────────────────────────────────────
interface ExecutionState {
  lastOrderCandleTs: number;
  openTrades: Map<string, Trade>;
  closedTrades: Trade[];
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

  public onTradeUpdate: ((trade: Trade) => void) | null = null;

  constructor(exchange: Exchange, config: BotConfig, logger: BotLogger) {
    this.exchange = exchange;
    this.config = config;
    this.logger = logger;
    this.state = {
      lastOrderCandleTs: 0,
      openTrades: new Map(),
      closedTrades: [],
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
      entryPrice: entry,
      exitPrice: null,
      stopLoss: sl,
      takeProfit: tp,
      size,
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
      // ── Entry market order ────────────────────────────
      const entryResp = await this.exchange.createOrder(
        signal.symbol,
        "market",
        side,
        size
      );
      order.exchangeOrderId = entryResp.id;
      order.status = OrderStatus.OPEN;
      order.filledAt = Date.now();

      // ── Stop-loss order ───────────────────────────────
      await this.exchange.createOrder(
        signal.symbol,
        "stop_market" as any,
        slSide,
        size,
        sl,
        { stopPrice: sl, reduceOnly: true }
      );

      // ── Take-profit order ─────────────────────────────
      await this.exchange.createOrder(
        signal.symbol,
        "take_profit_market" as any,
        slSide,
        size,
        tp,
        { stopPrice: tp, reduceOnly: true }
      );

      order.status = OrderStatus.FILLED;

      this.logger.info("[Engine] Live orders placed", {
        entryOrderId: entryResp.id,
        sl,
        tp,
      });
    } catch (err) {
      this.logger.error("[Engine] Order placement failed", { error: String(err) });
      order.status = OrderStatus.REJECTED;
      return null;
    }

    return order;
  }

  // ──────────────────────────────────────────────────────────
  // Private: balance fetching
  // ──────────────────────────────────────────────────────────

  private async fetchBalance(): Promise<number> {
    if (this.config.paperTrading) {
      return this.config.paperBalance;
    }

    try {
      const balances = await this.exchange.fetchBalance();
      const quote = this.config.symbol.split("/")[1] ?? "USDT";
      const free = balances?.free as unknown as Record<string, number | undefined> | undefined;
      return free?.[quote] ?? 0;
    } catch (err) {
      this.logger.error("[Engine] fetchBalance failed", { error: String(err) });
      return 0;
    }
  }
}
