// ============================================================
// Unified AI Key Pool Management Service
//
// Combines 19 NVIDIA NIM keys and 19 OpenRouter keys into a
// single, unified, high-availability rotation pool.
//
// Key Features:
//   1. Interleaved Round-Robin: Alternates between providers
//      (NVIDIA, OpenRouter) to evenly distribute workload.
//   2. Instant Rollover on Rate-Limits (HTTP 429) or Downtime (5xx/timeouts).
//   3. Dynamic Cooldown: Sidelined keys auto-recover after cooldown.
//   4. Health & Usage Telemetry for every key.
// ============================================================

import * as https from "https";

export type AiProvider = "nvidia" | "openrouter";

export interface KeySlot {
  id: string;             // e.g. "NVIDIA-1", "OPENROUTER-1"
  provider: AiProvider;
  apiKey: string;
  model: string;
  hostname: string;
  path: string;
  cooldownUntil: number; // Unix ms
  failureCount: number;
  totalSuccess: number;
  lastUsed: number;
}

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface PoolStatusSummary {
  totalKeys: number;
  nvidiaKeys: number;
  openrouterKeys: number;
  healthyKeys: number;
  coolingDownKeys: number;
  slots: {
    id: string;
    provider: AiProvider;
    model: string;
    isHealthy: boolean;
    cooldownRemainingSec: number;
    successCount: number;
    failureCount: number;
  }[];
}

export class AiKeyPoolManager {
  private pool: KeySlot[] = [];
  private rotationIndex: number = 0;

  constructor() {
    this.initPool();
  }

  // ──────────────────────────────────────────────────────────
  // Initialize and load all 19+19 keys from environment
  // ──────────────────────────────────────────────────────────
  private initPool(): void {
    const nvidiaSlots: KeySlot[] = [];
    const openrouterSlots: KeySlot[] = [];

    // ── 1. Load NVIDIA keys (NVIDIA_API_KEY_1 .. NVIDIA_API_KEY_30) ──
    for (let i = 1; i <= 30; i++) {
      const key = process.env[`NVIDIA_API_KEY_${i}`];
      if (key && key.trim()) {
        const defaultModel = i % 2 === 0 ? "deepseek-ai/deepseek-v4-pro-0813" : "moonshotai/kimi-k3";
        const model = process.env[`NVIDIA_MODEL_${i}`] ?? process.env.NVIDIA_MODEL ?? defaultModel;
        nvidiaSlots.push({
          id: `NVIDIA-${i}`,
          provider: "nvidia",
          apiKey: key.trim(),
          model,
          hostname: "integrate.api.nvidia.com",
          path: "/v1/chat/completions",
          cooldownUntil: 0,
          failureCount: 0,
          totalSuccess: 0,
          lastUsed: 0,
        });
      }
    }

    // Fallback: comma-separated or single legacy NVIDIA_API_KEY
    if (nvidiaSlots.length === 0 && process.env.NVIDIA_API_KEY) {
      const raw = process.env.NVIDIA_API_KEY;
      const keys = raw.includes(",") ? raw.split(",").map((k) => k.trim()).filter(Boolean) : [raw.trim()];
      keys.forEach((k, idx) => {
        nvidiaSlots.push({
          id: `NVIDIA-${idx + 1}`,
          provider: "nvidia",
          apiKey: k,
          model: process.env.NVIDIA_MODEL ?? "moonshotai/kimi-k3",
          hostname: "integrate.api.nvidia.com",
          path: "/v1/chat/completions",
          cooldownUntil: 0,
          failureCount: 0,
          totalSuccess: 0,
          lastUsed: 0,
        });
      });
    }

    // ── 2. Load OpenRouter keys (OPENROUTER_API_KEY_1 .. OPENROUTER_API_KEY_30) ──
    for (let i = 1; i <= 30; i++) {
      const key = process.env[`OPENROUTER_API_KEY_${i}`];
      if (key && key.trim()) {
        const defaultModel = i % 2 === 0 ? "deepseek/deepseek-chat" : "deepseek/deepseek-r1";
        const model = process.env[`OPENROUTER_MODEL_${i}`] ?? process.env.OPENROUTER_MODEL ?? defaultModel;
        openrouterSlots.push({
          id: `OPENROUTER-${i}`,
          provider: "openrouter",
          apiKey: key.trim(),
          model,
          hostname: "openrouter.ai",
          path: "/api/v1/chat/completions",
          cooldownUntil: 0,
          failureCount: 0,
          totalSuccess: 0,
          lastUsed: 0,
        });
      }
    }

    // Fallback: comma-separated or single legacy OPENROUTER_API_KEY
    if (openrouterSlots.length === 0 && process.env.OPENROUTER_API_KEY) {
      const raw = process.env.OPENROUTER_API_KEY;
      const keys = raw.includes(",") ? raw.split(",").map((k) => k.trim()).filter(Boolean) : [raw.trim()];
      keys.forEach((k, idx) => {
        openrouterSlots.push({
          id: `OPENROUTER-${idx + 1}`,
          provider: "openrouter",
          apiKey: k,
          model: process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-chat",
          hostname: "openrouter.ai",
          path: "/api/v1/chat/completions",
          cooldownUntil: 0,
          failureCount: 0,
          totalSuccess: 0,
          lastUsed: 0,
        });
      });
    }

    // ── 3. Interleave NVIDIA and OpenRouter for perfect 50/50 balance ──
    const combined: KeySlot[] = [];
    const maxLen = Math.max(nvidiaSlots.length, openrouterSlots.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < nvidiaSlots.length) combined.push(nvidiaSlots[i]);
      if (i < openrouterSlots.length) combined.push(openrouterSlots[i]);
    }

    this.pool = combined;

    if (this.pool.length > 0) {
      console.log(
        `[AiPool] Initialized unified rotation pool with ${this.pool.length} total keys ` +
        `(${nvidiaSlots.length} NVIDIA, ${openrouterSlots.length} OpenRouter).`
      );
    } else {
      console.warn("[AiPool] Warning: No NVIDIA or OpenRouter API keys found in environment.");
    }
  }

  // ──────────────────────────────────────────────────────────
  // Check if any keys are configured
  // ──────────────────────────────────────────────────────────
  public isEnabled(): boolean {
    return this.pool.length > 0;
  }

  public getKeyCount(): number {
    return this.pool.length;
  }

  // ──────────────────────────────────────────────────────────
  // Core: Request AI completion with automatic rotation & rollover
  // ──────────────────────────────────────────────────────────
  public async generateCompletion(
    messages: AiChatMessage[],
    options?: AiCompletionOptions
  ): Promise<{ text: string; slotId: string; model: string; provider: AiProvider }> {
    if (this.pool.length === 0) {
      throw new Error("No AI API keys configured in pool. Add NVIDIA_API_KEY_* or OPENROUTER_API_KEY_* to environment.");
    }

    const now = Date.now();
    const maxAttempts = Math.min(this.pool.length, 12);
    let lastError: Error = new Error("All AI keys exhausted or in cooldown.");

    // Loop through keys starting from current rotation index
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const slotIndex = (this.rotationIndex + attempt) % this.pool.length;
      const slot = this.pool[slotIndex];

      // If key is in cooldown, skip unless expired
      if (slot.cooldownUntil > now) {
        continue;
      }

      slot.lastUsed = Date.now();

      try {
        const text = await this.executeHttpRequest(slot, messages, options);
        if (!text || text.trim().length === 0) {
          throw new Error(`Empty response from ${slot.id}`);
        }

        // Success: reset failures and advance pointer
        slot.failureCount = 0;
        slot.totalSuccess++;
        this.rotationIndex = (slotIndex + 1) % this.pool.length;

        return {
          text: text.trim(),
          slotId: slot.id,
          model: slot.model,
          provider: slot.provider,
        };
      } catch (err: any) {
        lastError = err;
        const errMsg = String(err?.message ?? "").toLowerCase();

        // Determine cooldown duration based on error type
        let cooldownMs = 30_000; // default 30s for generic network / server error

        if (errMsg.includes("429") || errMsg.includes("rate limit") || errMsg.includes("too many requests")) {
          cooldownMs = 60_000; // 60s for rate limits
        } else if (errMsg.includes("401") || errMsg.includes("403") || errMsg.includes("unauthorized") || errMsg.includes("credit")) {
          cooldownMs = 300_000; // 5 mins for auth/quota issues
        } else if (errMsg.includes("timeout") || errMsg.includes("timed out")) {
          cooldownMs = 20_000; // 20s for timeouts
        }

        slot.failureCount++;
        slot.cooldownUntil = Date.now() + cooldownMs;

        console.warn(
          `[AiPool] Key ${slot.id} (${slot.provider} - ${slot.model}) failed: ${err.message}. ` +
          `Cooldown ${cooldownMs / 1000}s. Instantly rolling over to next key...`
        );
      }
    }

    // If all healthy keys were skipped or failed, attempt the key whose cooldown expires earliest
    console.warn("[AiPool] All active keys currently in cooldown. Attempting earliest-expiring key as fallback...");
    const sortedByCooldown = [...this.pool].sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    const fallbackSlot = sortedByCooldown[0];

    try {
      const text = await this.executeHttpRequest(fallbackSlot, messages, options);
      fallbackSlot.cooldownUntil = 0;
      fallbackSlot.totalSuccess++;
      return {
        text: text.trim(),
        slotId: fallbackSlot.id,
        model: fallbackSlot.model,
        provider: fallbackSlot.provider,
      };
    } catch (finalErr: any) {
      throw new Error(`Unified AI Pool exhausted: ${finalErr.message} (last error: ${lastError.message})`);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Private: Execute HTTP request against specific provider
  // ──────────────────────────────────────────────────────────
  private executeHttpRequest(
    slot: KeySlot,
    messages: AiChatMessage[],
    options?: AiCompletionOptions
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? 25_000;
      const temperature = options?.temperature ?? 0.7;
      const maxTokens = options?.maxTokens ?? 2048;

      const body = JSON.stringify({
        model: slot.model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: true,
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${slot.apiKey}`,
        "Accept": "text/event-stream",
        "Content-Length": String(Buffer.byteLength(body)),
      };

      if (slot.provider === "openrouter") {
        headers["HTTP-Referer"] = "https://github.com/EmmanuelCodes-ai/BOT";
        headers["X-Title"] = "TradingBot Analyst";
      }

      const reqOptions: https.RequestOptions = {
        hostname: slot.hostname,
        path: slot.path,
        method: "POST",
        headers,
      };

      const req = https.request(reqOptions, (res) => {
        const statusCode = res.statusCode ?? 0;

        if (statusCode !== 200) {
          let errBody = "";
          res.on("data", (chunk: Buffer) => {
            errBody += chunk.toString("utf8");
          });
          res.on("end", () => {
            reject(new Error(`HTTP_${statusCode}: ${errBody.slice(0, 300)}`));
          });
          return;
        }

        let fullText = "";
        let rawBuffer = "";

        res.on("data", (chunk: Buffer) => {
          rawBuffer += chunk.toString("utf8");
          const lines = rawBuffer.split("\n");
          rawBuffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]") continue;
            if (!trimmed.startsWith("data: ")) continue;

            try {
              const json = JSON.parse(trimmed.slice(6));
              const delta = json?.choices?.[0]?.delta?.content ?? "";
              fullText += delta;
            } catch {
              // Ignore malformed chunks
            }
          }
        });

        res.on("end", () => {
          resolve(fullText);
        });

        res.on("error", reject);
      });

      req.on("error", reject);

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error(`Request timed out after ${timeoutMs / 1000}s (${slot.id})`));
      });

      req.write(body);
      req.end();
    });
  }

  // ──────────────────────────────────────────────────────────
  // Health & Monitoring
  // ──────────────────────────────────────────────────────────
  public getPoolStatus(): PoolStatusSummary {
    const now = Date.now();
    const nvidiaCount = this.pool.filter((s) => s.provider === "nvidia").length;
    const openrouterCount = this.pool.filter((s) => s.provider === "openrouter").length;
    const healthyCount = this.pool.filter((s) => s.cooldownUntil <= now).length;

    return {
      totalKeys: this.pool.length,
      nvidiaKeys: nvidiaCount,
      openrouterKeys: openrouterCount,
      healthyKeys: healthyCount,
      coolingDownKeys: this.pool.length - healthyCount,
      slots: this.pool.map((s) => ({
        id: s.id,
        provider: s.provider,
        model: s.model,
        isHealthy: s.cooldownUntil <= now,
        cooldownRemainingSec: Math.max(0, Math.round((s.cooldownUntil - now) / 1000)),
        successCount: s.totalSuccess,
        failureCount: s.failureCount,
      })),
    };
  }
}
