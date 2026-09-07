// ============================================================
// Gemini AI Analyst
//
// Uses @google/genai SDK with gemini-2.5-flash model.
//
// Two modes:
//   1. Proactive — fires after trades and daily summary.
//      Sends observations to Telegram only when worth flagging.
//
//   2. Chat — user messages the Telegram bot, Gemini replies
//      with full live bot context.
// ============================================================

import { GoogleGenAI } from "@google/genai";
import { Trade, Signal } from "../types";

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

Keep responses under 200 words. Use plain text, no markdown since this goes to Telegram.`;

// ── Chat history entry ──────────────────────────────────────
interface ChatMessage {
  role: "user" | "model";
  parts: string;
}

export class GeminiAnalyst {
  private ai: GoogleGenAI | null = null;
  private enabled: boolean;
  private chatHistory: ChatMessage[] = [];
  private tradeHistory: BotContext["recentTrades"] = [];

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY ?? "";
    this.enabled = Boolean(apiKey);

    if (!this.enabled) {
      console.warn("[Gemini] API key missing — analyst disabled");
      return;
    }

    this.ai = new GoogleGenAI({ apiKey });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ──────────────────────────────────────────────────────────
  // Proactive: trade opened
  // ──────────────────────────────────────────────────────────

  async analyzeTradeOpen(
    trade: Trade,
    signal: Signal,
    context: BotContext
  ): Promise<string | null> {
    if (!this.enabled || !this.ai) return null;

    const prompt = `A new trade just opened. Analyze it and flag any concerns.

Context: ${JSON.stringify(context, null, 2)}

Trade: ${trade.strategyId} ${trade.direction} @ ${trade.entryPrice}
SL: ${trade.stopLoss} | TP: ${trade.takeProfit}
Flow: ${signal.flow.flow} | Macro bias: ${signal.flow.macroBias}
RSI: ${signal.indicators.rsi14.toFixed(1)} | VWAP dev: ${signal.indicators.vwap.deviationPct.toFixed(3)}% | Vol: ${signal.indicators.volumeMultiplier.toFixed(2)}x

Is this a good setup? Flag any concerns briefly.`;

    return await this.generate(prompt);
  }

  // ──────────────────────────────────────────────────────────
  // Proactive: trade closed
  // ──────────────────────────────────────────────────────────

  async analyzeTradeClose(
    trade: Trade,
    context: BotContext
  ): Promise<string | null> {
    if (!this.enabled || !this.ai) return null;

    this.tradeHistory.push({
      strategy: trade.strategyId,
      direction: trade.direction,
      outcome: trade.outcome,
      pnlR: trade.pnlR ?? 0,
      durationMin: Math.round((trade.durationMs ?? 0) / 60000),
    });
    if (this.tradeHistory.length > 10) {
      this.tradeHistory = this.tradeHistory.slice(-10);
    }

    const prompt = `Trade closed. Review the result and recent pattern.

Context: ${JSON.stringify(context, null, 2)}

Closed: ${trade.strategyId} ${trade.direction} → ${trade.outcome}
PnL: ${trade.pnlR?.toFixed(2)}R (${trade.pnlRaw?.toFixed(2)} USDT) | Duration: ${Math.round((trade.durationMs ?? 0) / 60000)}m

Recent history:
${this.tradeHistory.map((t, i) => `${i + 1}. ${t.strategy} ${t.direction} → ${t.outcome} (${t.pnlR.toFixed(2)}R)`).join("\n")}

Any patterns worth flagging?`;

    return await this.generate(prompt);
  }

  // ──────────────────────────────────────────────────────────
  // Proactive: daily summary
  // ──────────────────────────────────────────────────────────

  async analyzeDailySummary(context: BotContext): Promise<string | null> {
    if (!this.enabled || !this.ai) return null;

    const prompt = `End of day. Give a brief performance review.

Context: ${JSON.stringify(context, null, 2)}

Cover: overall performance, which strategies worked/failed, risk concerns, and one recommendation for tomorrow. Under 150 words.`;

    return await this.generate(prompt);
  }

  // ──────────────────────────────────────────────────────────
  // Chat — user message → Gemini reply
  // ──────────────────────────────────────────────────────────

  async chat(userMessage: string, context: BotContext): Promise<string> {
    if (!this.enabled || !this.ai) return "Gemini analyst is not configured.";

    try {
      const model = this.ai.models;

      // Build contents array from history + new message
      const contents = [
        ...this.chatHistory.map((m) => ({
          role: m.role,
          parts: [{ text: m.parts }],
        })),
        {
          role: "user" as const,
          parts: [
            {
              text: `Current bot state:\n${JSON.stringify(context, null, 2)}\n\nUser: ${userMessage}`,
            },
          ],
        },
      ];

      const response = await model.generateContent({
        model: "gemini-2.5-flash",
        contents,
        config: { systemInstruction: SYSTEM_PROMPT },
      });

      const reply = response.text ?? "No response.";

      // Store in history for context continuity
      this.chatHistory.push({ role: "user", parts: userMessage });
      this.chatHistory.push({ role: "model", parts: reply });

      // Keep last 10 exchanges
      if (this.chatHistory.length > 20) {
        this.chatHistory = this.chatHistory.slice(-20);
      }

      return reply;
    } catch (err: any) {
      console.error("[Gemini] Chat error:", err.message);
      this.chatHistory = []; // reset on error
      return `Sorry, I ran into an error: ${err.message}`;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Private: one-shot generation
  // ──────────────────────────────────────────────────────────

  private async generate(prompt: string): Promise<string | null> {
    if (!this.ai) return null;

    try {
      const response = await this.ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { systemInstruction: SYSTEM_PROMPT },
      });

      const text = response.text?.trim() ?? "";
      return text.length > 10 ? text : null;
    } catch (err: any) {
      console.error("[Gemini] Generation error:", err.message);
      return null;
    }
  }
}
