/**
 * Global config for the local-LLM endpoint, persisted at ~/.lucid/local.json.
 * Project lucid.config.json may override (read by loadConfig in src/config.ts —
 * here we only handle the global file so all projects share one setup by default).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { LocalLlmConfig } from "./types.js";

const CONFIG_DIR  = join(homedir(), ".lucid");
const CONFIG_PATH = join(CONFIG_DIR, "local.json");

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function loadLocalConfig(): LocalLlmConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LocalLlmConfig>;
    if (typeof parsed.endpoint !== "string" || typeof parsed.model !== "string") return null;
    return {
      enabled:       parsed.enabled !== false,
      runtime:       parsed.runtime ?? "ollama",
      endpoint:      parsed.endpoint,
      model:         parsed.model,
      api_key:       parsed.api_key,
      timeout_ms:    parsed.timeout_ms ?? 60_000,
      configured_at: parsed.configured_at ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveLocalConfig(cfg: LocalLlmConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

export function disableLocalConfig(): boolean {
  const cfg = loadLocalConfig();
  if (!cfg) return false;
  saveLocalConfig({ ...cfg, enabled: false });
  return true;
}

export function isConfigured(): boolean {
  const cfg = loadLocalConfig();
  return cfg !== null && cfg.enabled;
}
