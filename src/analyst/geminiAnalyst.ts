// ============================================================
// AI Analyst — DeepSeek via NVIDIA NIM
// Model: deepseek-ai/deepseek-v4-pro
// ============================================================

import * as https from "https";

const MODEL = "deepseek-ai/deepseek-v4-pro";
const REQUEST_TIMEOUT_MS = 30000;

export interface BotContext {
  timestamp: string;
  symbol: string;
  balance: { opening: number; current: number; changePct: number };
  session: { closedTrades: number; wins: number; losses: number; totalR: number; winRate: string };
  openTrades: { direction: string; entryPrice: number; stopLoss: number; takeProfit: number; strategy: string; openedMinsAgo: number }[];
  lastSignal: { strategy: string; direction: string; score: number; flow: string; macroBias: string; rsi: number; atr: number; vwapDevPct: number; volumeMultiplier: number; entry: number; sl: number; tp: number } | null;
  currentFlow: string;
  recentTrades: { strategy: string; direction: string; outcome: string; pnlR: number; durationMin: number }[];
}

const SYSTEM_PROMPT = `You are an expert algorithmic trading analyst monitoring a live automated trading bot that trades BTC/USDT perpetual futures on Bybit using 5 strategies: TREND_PULLBACK_EMA, SR_FLIP_INVERSION, BB_MEAN_REVERSION, LIQUIDITY_SWEEP_REVERSAL, VWAP_DEVIATION_REVERSAL. Risk: 2R target, ATR stops, 1% account risk per trade. Be direct, concise, no markdown formatting.`;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function nimRequest(messages: ChatMessage[], apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 400,
      temperature: 0.7,
      stream: false,
    });

    const req = https.request(
      {
        hostname: "integrate.api.nvidia.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            console.log("[Analyst] HTTP status:", res.statusCode);
            console.log("[Analyst] Raw response:", data.slice(0, 400));
            const parsed = JSON.parse(data);
            const text = parsed?.choices?.[0]?.message?.content ?? "";
            resolve(text.trim());
          } catch (e) {
            reject(new Error(`Failed to parse: ${data.slice(0, 200)}`));
          }
        });
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error("NIM request timed out after 30s"));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export class GeminiAnalyst {
  private apiKey: string;
  private enabled: boolean;
  private chatHistory: ChatMessage[] = [];
  private tradeHistory: BotContext["recentTrades"] = [];

  constructor() {
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

  async analyzeTradeOpen(trade: any, signal: any, context: BotContext): Promise<string | null> {
    if (!this.enabled) return null;
    return this.generate([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `New trade opened. Analyze briefly.\n\nContext: ${JSON.stringify(context)}\n\nTrade: ${trade.strategyId} ${trade.direction} @ ${trade.entryPrice} SL=${trade.stopLoss} TP=${trade.takeProfit} Flow=${signal.flow.flow} Bias=${signal.flow.macroBias} RSI=${signal.indicators.rsi14.toFixed(1)} VWAP=${signal.indicators.vwap.deviationPct.toFixed(2)}% Vol=${signal.indicators.volumeMultiplier.toFixed(2)}x` },
    ]);
  }

  async analyzeTradeClose(trade: any, context: BotContext): Promise<string | null> {
    if (!this.enabled) return null;
    this.tradeHistory.push({ strategy: trade.strategyId, direction: trade.direction, outcome: trade.outcome, pnlR: trade.pnlR ?? 0, durationMin: Math.round((trade.durationMs ?? 0) / 60000) });
    if (this.tradeHistory.length > 10) this.tradeHistory = this.tradeHistory.slice(-10);
    return this.generate([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Trade closed: ${trade.strategyId} ${trade.direction} → ${trade.outcome} ${(trade.pnlR ?? 0).toFixed(2)}R ${Math.round((trade.durationMs ?? 0) / 60000)}m\n\nRecent: ${this.tradeHistory.map((t, i) => `${i + 1}.${t.strategy} ${t.direction}→${t.outcome}(${t.pnlR.toFixed(1)}R)`).join(" ")}\n\nContext: ${JSON.stringify(context)}\n\nAny patterns?` },
    ]);
  }

  async analyzeDailySummary(context: BotContext): Promise<string | null> {
    if (!this.enabled) return null;
    return this.generate([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Daily review. Context: ${JSON.stringify(context)}\n\nCover: performance, strategy attribution, risk concerns, one recommendation. Under 150 words.` },
    ]);
  }

  async chat(userMessage: string, context: BotContext): Promise<string> {
    if (!this.enabled) return "AI analyst not configured.";
    try {
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...this.chatHistory,
        { role: "user", content: `Bot state: ${JSON.stringify(context)}\n\nUser: ${userMessage}` },
      ];
      const reply = await nimRequest(messages, this.apiKey);
      this.chatHistory.push({ role: "user", content: userMessage });
      this.chatHistory.push({ role: "assistant", content: reply });
      if (this.chatHistory.length > 20) this.chatHistory = this.chatHistory.slice(-20);
      return reply || "No response from AI.";
    } catch (err: any) {
      console.error("[Analyst] Chat error:", err.message);
      this.chatHistory = [];
      return `Error: ${err.message}`;
    }
  }

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
