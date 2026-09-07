// ============================================================
// AI Analyst — powered by DeepSeek via NVIDIA NIM
//
// Uses OpenAI-compatible REST API (no extra SDK needed).
// Model: deepseek-ai/deepseek-v4-pro-0813
//
// Two modes:
//   1. Proactive — fires after trades and daily summary
//   2. Chat — user messages Telegram bot, AI replies with context
// ============================================================

import * as https from "https";

const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const MODEL = "deepseek-ai/deepseek-v4-pro-0813";
const REQUEST_TIMEOUT_MS = 30000;

// ── Bot context snapshot ────────────────────────────────────
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
- Be direct, concise, no fluff
- Answer questions about what the bot is doing and why

Keep responses under 200 words. Plain text only — no markdown since this goes to Telegram.`;

// ── Chat message type ───────────────────────────────────────
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── HTTP helper ─────────────────────────────────────────────
function nimRequest(messages: ChatMessage[], apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 400,
      temperature: 0.7,
    });

    const options = {
      hostname: "integrate.api.nvidia.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          console.log("[Analyst] NIM raw response:", JSON.stringify(parsed).slice(0, 300));
          const text = parsed?.choices?.[0]?.message?.content ?? "";
          resolve(text.trim());
        } catch {
          reject(new Error(`Failed to parse NIM response: ${data.slice(0, 300)}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`NIM request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.write(body);
    req.end();
  });
}

// ── Analyst class ───────────────────────────────────────────
export class GeminiAnalyst {
  private apiKey: string;
  private enabled: boolean;
  private chatHistory: ChatMessage[] = [];
  private tradeHistory: BotContext["recentTrades"] = [];

  constructor() {
    // Support both old GEMINI_API_KEY and new NVIDIA_API_KEY
    this.apiKey = process.env.NVIDIA_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
    this.enabled = Boolean(this.apiKey);

    if (!this.enabled) {
      console.warn("[Analyst] No API key found — analyst disabled");
    } else {
      console.log("[Analyst] DeepSeek via NVIDIA NIM initialised");
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ──────────────────────────────────────────────────────────
  // Proactive: trade opened
  // ──────────────────────────────────────────────────────────

  async analyzeTradeOpen(
    trade: any,
    signal: any,
    context: BotContext
  ): Promise<string | null> {
    if (!this.enabled) return null;

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `A new trade just opened. Analyze it and flag any concerns.

Context: ${JSON.stringify(context)}

Trade: ${trade.strategyId} ${trade.direction} @ ${trade.entryPrice}
SL: ${trade.stopLoss} | TP: ${trade.takeProfit}
Flow: ${signal.flow.flow} | Macro bias: ${signal.flow.macroBias}
RSI: ${signal.indicators.rsi14.toFixed(1)} | VWAP dev: ${signal.indicators.vwap.deviationPct.toFixed(3)}% | Vol: ${signal.indicators.volumeMultiplier.toFixed(2)}x

Is this a good setup? Flag any concerns briefly.`,
      },
    ];

    return await this.generate(messages);
  }

  // ──────────────────────────────────────────────────────────
  // Proactive: trade closed
  // ──────────────────────────────────────────────────────────

  async analyzeTradeClose(
    trade: any,
    context: BotContext
  ): Promise<string | null> {
    if (!this.enabled) return null;

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

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Trade closed. Review the result and recent pattern.

Context: ${JSON.stringify(context)}

Closed: ${trade.strategyId} ${trade.direction} → ${trade.outcome}
PnL: ${(trade.pnlR ?? 0).toFixed(2)}R (${(trade.pnlRaw ?? 0).toFixed(2)} USDT)
Duration: ${Math.round((trade.durationMs ?? 0) / 60000)}m

Recent history:
${this.tradeHistory.map((t, i) => `${i + 1}. ${t.strategy} ${t.direction} → ${t.outcome} (${t.pnlR.toFixed(2)}R)`).join("\n")}

Any patterns worth flagging?`,
      },
    ];

    return await this.generate(messages);
  }

  // ──────────────────────────────────────────────────────────
  // Proactive: daily summary
  // ──────────────────────────────────────────────────────────

  async analyzeDailySummary(context: BotContext): Promise<string | null> {
    if (!this.enabled) return null;

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `End of day. Give a brief performance review.

Context: ${JSON.stringify(context)}

Cover: overall performance, which strategies worked/failed, risk concerns, one recommendation for tomorrow. Under 150 words.`,
      },
    ];

    return await this.generate(messages);
  }

  // ──────────────────────────────────────────────────────────
  // Chat — user message with full context
  // ──────────────────────────────────────────────────────────

  async chat(userMessage: string, context: BotContext): Promise<string> {
    if (!this.enabled) return "AI analyst is not configured.";

    // Build messages with history
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...this.chatHistory,
      {
        role: "user",
        content: `Current bot state:\n${JSON.stringify(context)}\n\nUser: ${userMessage}`,
      },
    ];

    try {
      const reply = await nimRequest(messages, this.apiKey);

      // Store history for continuity (keep last 10 exchanges)
      this.chatHistory.push({ role: "user", content: userMessage });
      this.chatHistory.push({ role: "assistant", content: reply });
      if (this.chatHistory.length > 20) {
        this.chatHistory = this.chatHistory.slice(-20);
      }

      return reply || "No response from AI.";
    } catch (err: any) {
      console.error("[Analyst] Chat error:", err.message);
      this.chatHistory = [];
      return `Sorry, I ran into an error: ${err.message}`;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Private: one-shot generation
  // ──────────────────────────────────────────────────────────

  private async generate(messages: ChatMessage[]): Promise<string | null> {
    try {
      const text = await nimRequest(messages, this.apiKey);
      return text.length > 10 ? text : null;
    } catch (err: any) {
      console.error("[Analyst] Generation error:", err.message);
      return null;
    }
  }
}
