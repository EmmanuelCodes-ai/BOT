// ============================================================
// Gemini AI Analyst
//
// Two modes:
//   1. Proactive — called automatically after trades and daily
//      summary. Reads full bot context and sends observations
//      to Telegram only when it finds something worth flagging.
//
//   2. Chat — called when user messages the Telegram bot.
//      Receives user question + full bot context, replies
//      directly in Telegram.
// ============================================================

import { GoogleGenerativeAI, ChatSession } from "@google/generative-ai";
import { Trade, Signal, FlowClassification, IndicatorSnapshot } from "../types";

// ── Bot context snapshot passed to Gemini ──────────────────
export interface BotContext {
  timestamp: string;
  symbol: string;
  balance: {
    opening: number;
    current: number;
    changePct: number;
  };
  session: {
    closedTrades: number;
    wins: number;
    losses: number;
    totalR: number;
    winRate: string;
  };
  openTrades: {
    direction: string;
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    strategy: string;
    openedMinsAgo: number;
  }[];
  lastSignal: {
    strategy: string;
    direction: string;
    score: number;
    flow: string;
    macroBias: string;
    rsi: number;
    atr: number;
    vwapDevPct: number;
    volumeMultiplier: number;
    entry: number;
    sl: number;
    tp: number;
  } | null;
  currentFlow: string;
  currentIndicators: {
    ema9: number;
    ema21: number;
    ema50: number;
    rsi14: number;
    atr14: number;
    vwapDevPct: number;
    volumeMultiplier: number;
  } | null;
  recentTrades: {
    strategy: string;
    direction: string;
    outcome: string;
    pnlR: number;
    durationMin: number;
  }[];
}

// ── System prompt ───────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert algorithmic trading analyst monitoring a live automated trading bot.

The bot trades BTC/USDT perpetual futures on Bybit using 5 strategies:
1. TREND_PULLBACK_EMA — EMA confluence pullback in trending markets
2. SR_FLIP_INVERSION — Support/Resistance flip retest
3. BB_MEAN_REVERSION — Bollinger Band overextension fade (RSI confirmed)
4. LIQUIDITY_SWEEP_REVERSAL — Stop hunt detection and reversal
5. VWAP_DEVIATION_REVERSAL — Session VWAP stretch fade

Risk management: 2R target, ATR-based stops, 1% account risk per trade, max 2 open trades.

Your job:
- Identify logical inconsistencies, risk issues, or strategy misfires
- Flag when the bot is trading against macro bias
- Warn about drawdown patterns or consecutive losses
- Praise good setups when warranted
- Be direct and concise — no fluff
- When chatting, answer questions about what the bot is doing and why

Keep responses under 200 words. Use plain text, no markdown formatting since this goes to Telegram.`;

export class GeminiAnalyst {
  private genAI!: GoogleGenerativeAI;
  private enabled: boolean;
  private chatSession: ChatSession | null = null;
  private tradeHistory: BotContext["recentTrades"] = [];

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY ?? "";
    this.enabled = Boolean(apiKey);

    if (!this.enabled) {
      console.warn("[Gemini] API key missing — analyst disabled");
      return;
    }

    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ──────────────────────────────────────────────────────────
  // Proactive analysis after a trade opens
  // ──────────────────────────────────────────────────────────

  async analyzeTradeOpen(
    trade: Trade,
    signal: Signal,
    context: BotContext
  ): Promise<string | null> {
    if (!this.enabled) return null;

    const prompt = `A new trade just opened. Analyze it and flag any concerns.

Bot Context:
${JSON.stringify(context, null, 2)}

Trade just opened:
- Strategy: ${trade.strategyId}
- Direction: ${trade.direction}
- Entry: ${trade.entryPrice}
- Stop Loss: ${trade.stopLoss}
- Take Profit: ${trade.takeProfit}
- Flow at entry: ${signal.flow.flow}
- Macro bias: ${signal.flow.macroBias}
- Score: ${context.lastSignal?.score ?? "?"}
- RSI at entry: ${signal.indicators.rsi14.toFixed(1)}
- VWAP deviation: ${signal.indicators.vwap.deviationPct.toFixed(3)}%
- Volume multiplier: ${signal.indicators.volumeMultiplier.toFixed(2)}x

Is this a good setup? Flag any concerns. If it looks solid, say so briefly.`;

    return await this.generate(prompt);
  }

  // ──────────────────────────────────────────────────────────
  // Proactive analysis after a trade closes
  // ──────────────────────────────────────────────────────────

  async analyzeTradeClose(
    trade: Trade,
    context: BotContext
  ): Promise<string | null> {
    if (!this.enabled) return null;

    // Track history for pattern detection
    this.tradeHistory.push({
      strategy: trade.strategyId,
      direction: trade.direction,
      outcome: trade.outcome,
      pnlR: trade.pnlR ?? 0,
      durationMin: Math.round((trade.durationMs ?? 0) / 60000),
    });

    // Keep last 10
    if (this.tradeHistory.length > 10) {
      this.tradeHistory = this.tradeHistory.slice(-10);
    }

    const prompt = `A trade just closed. Review the result and recent pattern.

Bot Context:
${JSON.stringify(context, null, 2)}

Trade closed:
- Strategy: ${trade.strategyId}
- Direction: ${trade.direction}
- Outcome: ${trade.outcome}
- PnL: ${trade.pnlR?.toFixed(2)}R (${trade.pnlRaw?.toFixed(2)} USDT)
- Duration: ${Math.round((trade.durationMs ?? 0) / 60000)} minutes
- Exit price: ${trade.exitPrice}

Recent trade history (last ${this.tradeHistory.length}):
${this.tradeHistory.map((t, i) => `${i + 1}. ${t.strategy} ${t.direction} → ${t.outcome} (${t.pnlR.toFixed(2)}R)`).join("\n")}

Any patterns worth flagging? Consecutive losses? Strategy bias issues?`;

    return await this.generate(prompt);
  }

  // ──────────────────────────────────────────────────────────
  // Proactive analysis on daily summary
  // ──────────────────────────────────────────────────────────

  async analyzeDailySummary(context: BotContext): Promise<string | null> {
    if (!this.enabled) return null;

    const prompt = `End of day summary. Give a brief performance review.

Bot Context:
${JSON.stringify(context, null, 2)}

Analyze:
1. Overall day performance
2. Strategy attribution — which strategies worked/failed?
3. Risk management — any concerns about position sizing or drawdown?
4. Recommendations for tomorrow

Keep it under 150 words.`;

    return await this.generate(prompt);
  }

  // ──────────────────────────────────────────────────────────
  // Chat — user sends a message, Gemini responds with context
  // ──────────────────────────────────────────────────────────

  async chat(userMessage: string, context: BotContext): Promise<string> {
    if (!this.enabled) return "Gemini analyst is not configured.";

    try {
      // Start or reuse chat session
      if (!this.chatSession) {
        const model = this.genAI.getGenerativeModel({
          model: "gemini-1.5-flash",
          systemInstruction: SYSTEM_PROMPT,
        });
        this.chatSession = model.startChat();
      }

      const contextStr = `Current bot state:
${JSON.stringify(context, null, 2)}

User question: ${userMessage}`;

      const result = await this.chatSession.sendMessage(contextStr);
      return result.response.text();
    } catch (err: any) {
      console.error("[Gemini] Chat error:", err.message);
      // Reset session on error so next message starts fresh
      this.chatSession = null;
      return `Sorry, I ran into an error: ${err.message}`;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Private: one-shot generation (for proactive analysis)
  // ──────────────────────────────────────────────────────────

  private async generate(prompt: string): Promise<string | null> {
    try {
      const model = this.genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        systemInstruction: SYSTEM_PROMPT,
      });

      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();

      // Only return if there's something meaningful to say
      if (text.length < 10) return null;
      return text;
    } catch (err: any) {
      console.error("[Gemini] Generation error:", err.message);
      return null;
    }
  }
}
