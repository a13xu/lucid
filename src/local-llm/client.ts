/**
 * HTTP client wrapping Ollama and OpenAI-compatible /v1/chat/completions
 * endpoints behind a single normalized interface.
 *
 * Inputs are validated; the configured endpoint is registered with the SSRF
 * allowlist by the caller (see src/index.ts) so remote endpoints work after
 * explicit user opt-in via `lucid local init`.
 */

import type { GenerateRequest, GenerateResponse, LocalLlmConfig } from "./types.js";

export class LocalLlmError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "LocalLlmError";
  }
}

export async function generate(
  cfg: LocalLlmConfig,
  req: GenerateRequest,
): Promise<GenerateResponse> {
  if (!cfg.enabled) {
    throw new LocalLlmError("Local LLM is disabled. Run `lucid local init` to set it up.");
  }
  return cfg.runtime === "ollama"
    ? generateOllama(cfg, req)
    : generateOpenAi(cfg, req);
}

// ---------------------------------------------------------------------------
// Ollama  POST /api/chat   (preferred — gives system role)
// ---------------------------------------------------------------------------

async function generateOllama(cfg: LocalLlmConfig, req: GenerateRequest): Promise<GenerateResponse> {
  const url = `${cfg.endpoint.replace(/\/+$/, "")}/api/chat`;
  const messages: Array<{ role: string; content: string }> = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: req.prompt });

  const body = {
    model:    cfg.model,
    messages,
    stream:   false,
    options: {
      temperature: req.temperature ?? 0.2,
      num_predict: req.max_tokens   ?? 2048,
      ...(req.stop ? { stop: req.stop } : {}),
    },
  };

  const start = Date.now();
  const res = await postJson(url, body, cfg);
  const latency = Date.now() - start;

  const content = (res as { message?: { content?: string } }).message?.content ?? "";
  return {
    text: content,
    model: cfg.model,
    latency_ms: latency,
    prompt_tokens:     (res as { prompt_eval_count?:  number }).prompt_eval_count,
    completion_tokens: (res as { eval_count?:         number }).eval_count,
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible  POST /v1/chat/completions
// ---------------------------------------------------------------------------

async function generateOpenAi(cfg: LocalLlmConfig, req: GenerateRequest): Promise<GenerateResponse> {
  const url = `${cfg.endpoint.replace(/\/+$/, "")}/v1/chat/completions`;
  const messages: Array<{ role: string; content: string }> = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: req.prompt });

  const body: Record<string, unknown> = {
    model:       cfg.model,
    messages,
    temperature: req.temperature ?? 0.2,
    max_tokens:  req.max_tokens   ?? 2048,
    stream:      false,
  };
  if (req.stop) body["stop"] = req.stop;

  const start = Date.now();
  const res = await postJson(url, body, cfg);
  const latency = Date.now() - start;

  const choice = (res as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0];
  const usage  = (res as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;

  return {
    text:              choice?.message?.content ?? "",
    model:             cfg.model,
    latency_ms:        latency,
    prompt_tokens:     usage?.prompt_tokens,
    completion_tokens: usage?.completion_tokens,
  };
}

// ---------------------------------------------------------------------------
// Shared transport
// ---------------------------------------------------------------------------

async function postJson(url: string, body: unknown, cfg: LocalLlmConfig): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeout_ms);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.api_key) headers["Authorization"] = `Bearer ${cfg.api_key}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LocalLlmError(`Local LLM request failed: ${res.status} ${res.statusText}${text ? " — " + text.slice(0, 200) : ""}`, res.status);
    }
    return await res.json();
  } catch (e) {
    if (e instanceof LocalLlmError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("aborted")) {
      throw new LocalLlmError(`Local LLM request timed out after ${cfg.timeout_ms}ms`);
    }
    throw new LocalLlmError(`Local LLM request failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Lightweight reachability check — just probes /api/tags or /v1/models. */
export async function ping(cfg: LocalLlmConfig): Promise<{ ok: boolean; latency_ms: number; detail?: string }> {
  const url = cfg.runtime === "ollama"
    ? `${cfg.endpoint.replace(/\/+$/, "")}/api/tags`
    : `${cfg.endpoint.replace(/\/+$/, "")}/v1/models`;
  const start = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3_000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return { ok: res.ok, latency_ms: Date.now() - start, detail: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - start, detail: e instanceof Error ? e.message : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
