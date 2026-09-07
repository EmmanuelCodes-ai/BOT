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
    this.ledger.recordOpen(trade, entry);
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

      this.logger.info("[Engine] Live order placed", {
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
