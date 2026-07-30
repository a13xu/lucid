/**
 * Shared types for the local-LLM subsystem (Ollama / LM Studio / llama.cpp /
 * any OpenAI-compatible self-hosted endpoint).
 */

export type RuntimeKind = "ollama" | "openai-compat" | "unknown";

export interface LocalLlmConfig {
  enabled: boolean;
  runtime: RuntimeKind;
  endpoint: string;          // e.g. http://localhost:11434  or  https://gpu.lan:11434
  model: string;             // e.g. qwen2.5-coder:1.5b
  api_key?: string;          // optional bearer for remote/secured endpoints
  timeout_ms: number;        // per-request timeout
  configured_at: string;     // ISO timestamp
}

export interface DetectedRuntime {
  kind: RuntimeKind;
  endpoint: string;
  models?: string[];         // populated when probing /api/tags or /v1/models
  latency_ms?: number;
}

export interface GenerateRequest {
  prompt: string;
  system?: string;
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
}

export interface GenerateResponse {
  text: string;
  model: string;
  latency_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}
