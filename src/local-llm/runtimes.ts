/**
 * Probe known local-LLM runtimes on localhost (and any user-supplied endpoint).
 *
 * Detection rules:
 *   GET /api/tags    → Ollama       (lists pulled models)
 *   GET /v1/models   → OpenAI-compat (LM Studio, llama.cpp server, vLLM, …)
 *
 * Probes are short-timeout (1.5s) so they don't block setup.
 */

import type { DetectedRuntime, RuntimeKind } from "./types.js";

const KNOWN_LOCAL_PORTS: Array<{ port: number; hint: string }> = [
  { port: 11434, hint: "Ollama default" },
  { port: 1234,  hint: "LM Studio default" },
  { port: 8080,  hint: "llama.cpp server default" },
  { port: 8000,  hint: "vLLM / generic" },
];

const PROBE_TIMEOUT_MS = 1_500;

async function probeUrl(url: string, headers?: Record<string, string>): Promise<{ ok: boolean; latency: number; body?: unknown }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: ac.signal, headers });
    if (!res.ok) return { ok: false, latency: Date.now() - start };
    const body = await res.json().catch(() => null);
    return { ok: true, latency: Date.now() - start, body: body ?? undefined };
  } catch {
    return { ok: false, latency: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe one specific endpoint. Returns null if nothing answers. */
export async function probeEndpoint(
  endpoint: string,
  headers?: Record<string, string>,
): Promise<DetectedRuntime | null> {
  const base = endpoint.replace(/\/+$/, "");

  // Try Ollama first (cheap & specific) — body MUST have `.models` array,
  // otherwise it's just a random service that happens to 200 on /api/tags.
  const ollama = await probeUrl(`${base}/api/tags`, headers);
  if (ollama.ok && hasOllamaShape(ollama.body)) {
    return { kind: "ollama", endpoint: base, models: extractOllamaModels(ollama.body), latency_ms: ollama.latency };
  }

  // Then try OpenAI-compatible — body MUST have `.data` array of model entries.
  const oai = await probeUrl(`${base}/v1/models`, headers);
  if (oai.ok && hasOpenAiShape(oai.body)) {
    return { kind: "openai-compat", endpoint: base, models: extractOpenAiModels(oai.body), latency_ms: oai.latency };
  }

  return null;
}

function hasOllamaShape(body: unknown): boolean {
  return !!body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models);
}

function hasOpenAiShape(body: unknown): boolean {
  return !!body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data);
}

/** Probe all known local ports — used for first-run auto-detect. */
export async function autoDetectLocal(): Promise<DetectedRuntime[]> {
  const probes = KNOWN_LOCAL_PORTS.map((p) =>
    probeEndpoint(`http://localhost:${p.port}`),
  );
  const results = await Promise.all(probes);
  return results.filter((r): r is DetectedRuntime => r !== null);
}

function extractOllamaModels(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const list = (body as { models?: Array<{ name?: string }> }).models;
  return Array.isArray(list) ? list.map((m) => m.name ?? "").filter(Boolean) : [];
}

function extractOpenAiModels(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: Array<{ id?: string }> }).data;
  return Array.isArray(data) ? data.map((m) => m.id ?? "").filter(Boolean) : [];
}

/** Human-readable runtime label, never throws. */
export function describeRuntime(kind: RuntimeKind): string {
  switch (kind) {
    case "ollama":         return "Ollama";
    case "openai-compat":  return "OpenAI-compatible (LM Studio / llama.cpp / vLLM)";
    default:               return "unknown";
  }
}
