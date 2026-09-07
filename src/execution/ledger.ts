// ============================================================
// Trade & Financial Ledger — Complete Dollar-Accurate Accounting
// Persisted in logs/ledger.json across server restarts
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { Trade, TradeOutcome, SignalDirection } from "../types";

export interface PositionLedgerEntry {
  id: string;
  symbol: string;
  direction: SignalDirection;
  strategyId: string;
  size: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskUSD: number;
  targetUSD: number;
  notionalUSD: number;
  currentPrice: number;
  unrealizedPnLUSD: number;
  unrealizedPnLPct: number;
  unrealizedR: number;
  peakPnLUSD: number;
  maxAdversePnLUSD: number;
  openedAt: number;
  durationMinutes: number;
}

export interface ClosedTradeLedgerEntry {
  id: string;
  symbol: string;
  direction: SignalDirection;
  strategyId: string;
  size: number;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskUSD: number;
  realizedPnLUSD: number;
  realizedPnLR: number;
  outcome: TradeOutcome;
  openedAt: number;
  closedAt: number;
  durationMinutes: number;
  notes: string;
}

export interface AccountFinancialSnapshot {
  startingBalanceUSD: number;
  cashBalanceUSD: number;
  lockedMarginUSD: number;
  totalEquityUSD: number;
  totalRealizedPnLUSD: number;
  totalUnrealizedPnLUSD: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  winRatePct: number;
  grossProfitUSD: number;
  grossLossUSD: number;
  profitFactor: number;
  expectancyUSD: number;
  peakEquityUSD: number;
  currentDrawdownUSD: number;
  currentDrawdownPct: number;
  maxDrawdownPct: number;
  lastUpdated: string;
}

interface PersistedLedgerData {
  startingBalanceUSD: number;
  peakEquityUSD: number;
  maxDrawdownPct: number;
  openPositions: PositionLedgerEntry[];
  closedTrades: ClosedTradeLedgerEntry[];
}

export class TradeLedger {
  private ledgerPath: string;
  private startingBalanceUSD: number = 0;
  private peakEquityUSD: number = 0;
  private maxDrawdownPct: number = 0;
  private openPositions: Map<string, PositionLedgerEntry> = new Map();
  private closedTrades: ClosedTradeLedgerEntry[] = [];

  constructor(logDir: string = path.resolve(process.cwd(), "logs")) {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    this.ledgerPath = path.join(logDir, "ledger.json");
    this.loadFromDisk();
  }

  // ── Initialize or update initial capital ───────────────────
  initCapital(balanceUSD: number): void {
    if (this.startingBalanceUSD === 0 && balanceUSD > 0) {
      this.startingBalanceUSD = balanceUSD;
      if (this.peakEquityUSD === 0) {
        this.peakEquityUSD = balanceUSD;
      }
      this.saveToDisk();
    }
  }

  // ── Record a newly opened trade ────────────────────────────
  recordOpen(trade: Trade, currentPrice?: number): PositionLedgerEntry {
    const markPrice = currentPrice ?? trade.entryPrice;
    const stopDist = Math.abs(trade.entryPrice - trade.stopLoss);
    const targetDist = Math.abs(trade.takeProfit - trade.entryPrice);
    const riskUSD = parseFloat((stopDist * trade.size).toFixed(4));
    const targetUSD = parseFloat((targetDist * trade.size).toFixed(4));
    const notionalUSD = parseFloat((trade.entryPrice * trade.size).toFixed(4));

    const pnlUSD = this.calculatePnL(trade.direction, trade.entryPrice, markPrice, trade.size);
    const pnlR = riskUSD > 0 ? parseFloat((pnlUSD / riskUSD).toFixed(3)) : 0;
    const pnlPct = notionalUSD > 0 ? parseFloat(((pnlUSD / notionalUSD) * 100).toFixed(3)) : 0;

    const entry: PositionLedgerEntry = {
      id: trade.id,
      symbol: trade.symbol,
      direction: trade.direction,
      strategyId: trade.strategyId,
      size: trade.size,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      riskUSD,
      targetUSD,
      notionalUSD,
      currentPrice: markPrice,
      unrealizedPnLUSD: pnlUSD,
      unrealizedPnLPct: pnlPct,
      unrealizedR: pnlR,
      peakPnLUSD: Math.max(0, pnlUSD),
      maxAdversePnLUSD: Math.min(0, pnlUSD),
      openedAt: trade.openedAt,
      durationMinutes: Math.round((Date.now() - trade.openedAt) / 60000),
    };

    this.openPositions.set(trade.id, entry);
    this.updateEquityAndDrawdown();
    this.saveToDisk();
    return entry;
  }

  // ── Update mark prices for open positions ──────────────────
  updateMarkPrice(currentPrice: number): void {
    if (this.openPositions.size === 0) return;

    for (const [, pos] of this.openPositions) {
      pos.currentPrice = currentPrice;
      pos.durationMinutes = Math.round((Date.now() - pos.openedAt) / 60000);
      const pnlUSD = this.calculatePnL(pos.direction, pos.entryPrice, currentPrice, pos.size);
      pos.unrealizedPnLUSD = pnlUSD;
      pos.unrealizedR = pos.riskUSD > 0 ? parseFloat((pnlUSD / pos.riskUSD).toFixed(3)) : 0;
      pos.unrealizedPnLPct = pos.notionalUSD > 0
        ? parseFloat(((pnlUSD / pos.notionalUSD) * 100).toFixed(3))
        : 0;

      if (pnlUSD > pos.peakPnLUSD) pos.peakPnLUSD = pnlUSD;
      if (pnlUSD < pos.maxAdversePnLUSD) pos.maxAdversePnLUSD = pnlUSD;
    }

    this.updateEquityAndDrawdown();
    this.saveToDisk();
  }

  // ── Record a closed trade ──────────────────────────────────
  recordClose(trade: Trade): ClosedTradeLedgerEntry {
    const exitPrice = trade.exitPrice ?? trade.entryPrice;
    const closedAt = trade.closedAt ?? Date.now();
    const durationMinutes = Math.round((closedAt - trade.openedAt) / 60000);

    const pnlUSD = trade.pnlRaw !== null
      ? parseFloat(trade.pnlRaw.toFixed(4))
      : this.calculatePnL(trade.direction, trade.entryPrice, exitPrice, trade.size);

    const stopDist = Math.abs(trade.entryPrice - trade.stopLoss);
    const riskUSD = parseFloat((stopDist * trade.size).toFixed(4));
    const pnlR = trade.pnlR !== null
      ? parseFloat(trade.pnlR.toFixed(3))
      : (riskUSD > 0 ? parseFloat((pnlUSD / riskUSD).toFixed(3)) : 0);

    const closedEntry: ClosedTradeLedgerEntry = {
      id: trade.id,
      symbol: trade.symbol,
      direction: trade.direction,
      strategyId: trade.strategyId,
      size: trade.size,
      entryPrice: trade.entryPrice,
      exitPrice,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      riskUSD,
      realizedPnLUSD: pnlUSD,
      realizedPnLR: pnlR,
      outcome: trade.outcome,
      openedAt: trade.openedAt,
      closedAt,
      durationMinutes,
      notes: trade.notes,
    };

    this.openPositions.delete(trade.id);
    this.closedTrades.push(closedEntry);
    this.updateEquityAndDrawdown();
    this.saveToDisk();
    return closedEntry;
  }

  // ── Get financial snapshot ─────────────────────────────────
  getFinancialSnapshot(liveBalance?: number): AccountFinancialSnapshot {
    const realizedPnL = parseFloat(
      this.closedTrades.reduce((acc, t) => acc + t.realizedPnLUSD, 0).toFixed(4)
    );
    const unrealizedPnL = parseFloat(
      Array.from(this.openPositions.values())
        .reduce((acc, p) => acc + p.unrealizedPnLUSD, 0)
        .toFixed(4)
    );

    const starting = this.startingBalanceUSD > 0
      ? this.startingBalanceUSD
      : (liveBalance ?? 10000);

    const cashBalance = parseFloat((starting + realizedPnL).toFixed(4));
    const totalEquity = parseFloat((cashBalance + unrealizedPnL).toFixed(4));
    const lockedMargin = parseFloat(
      Array.from(this.openPositions.values())
        .reduce((acc, p) => acc + p.notionalUSD, 0)
        .toFixed(4)
    );

    const winning = this.closedTrades.filter((t) => t.outcome === TradeOutcome.WIN);
    const losing = this.closedTrades.filter((t) => t.outcome === TradeOutcome.LOSS);
    const be = this.closedTrades.filter((t) => t.outcome === TradeOutcome.BREAKEVEN);

    const grossProfit = parseFloat(
      winning.reduce((acc, t) => acc + Math.max(0, t.realizedPnLUSD), 0).toFixed(4)
    );
    const grossLoss = parseFloat(
      Math.abs(losing.reduce((acc, t) => acc + Math.min(0, t.realizedPnLUSD), 0)).toFixed(4)
    );

    const winRatePct = this.closedTrades.length > 0
      ? parseFloat(((winning.length / this.closedTrades.length) * 100).toFixed(1))
      : 0;

    const profitFactor = grossLoss > 0
      ? parseFloat((grossProfit / grossLoss).toFixed(2))
      : grossProfit > 0 ? 999 : 0;

    const expectancy = this.closedTrades.length > 0
      ? parseFloat((realizedPnL / this.closedTrades.length).toFixed(4))
      : 0;

    const peak = Math.max(this.peakEquityUSD, totalEquity, starting);
    const currentDrawdownUSD = parseFloat(Math.max(0, peak - totalEquity).toFixed(4));
    const currentDrawdownPct = peak > 0
      ? parseFloat(((currentDrawdownUSD / peak) * 100).toFixed(2))
      : 0;

    return {
      startingBalanceUSD: starting,
      cashBalanceUSD: cashBalance,
      lockedMarginUSD: lockedMargin,
      totalEquityUSD: totalEquity,
      totalRealizedPnLUSD: realizedPnL,
      totalUnrealizedPnLUSD: unrealizedPnL,
      totalTrades: this.closedTrades.length,
      winningTrades: winning.length,
      losingTrades: losing.length,
      breakevenTrades: be.length,
      winRatePct,
      grossProfitUSD: grossProfit,
      grossLossUSD: grossLoss,
      profitFactor,
      expectancyUSD: expectancy,
      peakEquityUSD: peak,
      currentDrawdownUSD,
      currentDrawdownPct,
      maxDrawdownPct: Math.max(this.maxDrawdownPct, currentDrawdownPct),
      lastUpdated: new Date().toISOString(),
    };
  }

  getOpenPositions(): PositionLedgerEntry[] {
    return Array.from(this.openPositions.values());
  }

  getClosedTrades(): ClosedTradeLedgerEntry[] {
    return this.closedTrades;
  }

  // ── Private helpers ────────────────────────────────────────

  private calculatePnL(
    direction: SignalDirection,
    entryPrice: number,
    currentPrice: number,
    size: number
  ): number {
    const raw = direction === SignalDirection.LONG
      ? (currentPrice - entryPrice) * size
      : (entryPrice - currentPrice) * size;
    return parseFloat(raw.toFixed(4));
  }

  private updateEquityAndDrawdown(): void {
    const snap = this.getFinancialSnapshot();
    if (snap.totalEquityUSD > this.peakEquityUSD) {
      this.peakEquityUSD = snap.totalEquityUSD;
    }
    if (snap.currentDrawdownPct > this.maxDrawdownPct) {
      this.maxDrawdownPct = snap.currentDrawdownPct;
    }
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.ledgerPath)) {
        const raw = fs.readFileSync(this.ledgerPath, "utf8");
        const data: PersistedLedgerData = JSON.parse(raw);
        this.startingBalanceUSD = data.startingBalanceUSD || 0;
        this.peakEquityUSD = data.peakEquityUSD || 0;
        this.maxDrawdownPct = data.maxDrawdownPct || 0;

        if (Array.isArray(data.openPositions)) {
          this.openPositions = new Map(data.openPositions.map((p) => [p.id, p]));
        }
        if (Array.isArray(data.closedTrades)) {
          this.closedTrades = data.closedTrades;
        }
      }
    } catch (err) {
      console.error("[Ledger] Failed to load ledger from disk:", err);
    }
  }

  private saveToDisk(): void {
    try {
      const data: PersistedLedgerData = {
        startingBalanceUSD: this.startingBalanceUSD,
        peakEquityUSD: this.peakEquityUSD,
        maxDrawdownPct: this.maxDrawdownPct,
        openPositions: Array.from(this.openPositions.values()),
        closedTrades: this.closedTrades,
      };
      fs.writeFileSync(this.ledgerPath, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.error("[Ledger] Failed to save ledger to disk:", err);
    }
  }
}
