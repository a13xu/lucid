import { z } from "zod";
import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Package root resolution
// ---------------------------------------------------------------------------

// build/tools/updater.js → ../../ = package root
const PACKAGE_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

export function getCurrentVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// npm registry check
// ---------------------------------------------------------------------------

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(
      "https://registry.npmjs.org/@a13xu/lucid/latest",
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Install method detection
// ---------------------------------------------------------------------------

function detectInstallMethod(): "global-npm" | "local-source" | "npx" {
  // If the package root is inside node_modules, it's npm-installed
  if (PACKAGE_ROOT.includes("node_modules")) {
    return "global-npm";
  }
  // Check if there's a .git folder — local source checkout
  if (existsSync(join(PACKAGE_ROOT, ".git"))) {
    return "local-source";
  }
  return "global-npm";
}

// ---------------------------------------------------------------------------
// Startup check (non-blocking — call from index.ts without await)
// ---------------------------------------------------------------------------

export async function checkForUpdatesOnStartup(): Promise<void> {
  const current = getCurrentVersion();
  const latest = await fetchLatestVersion();
  if (latest && compareVersions(latest, current) > 0) {
    console.error(
      `[lucid] ⬆️  Update available: v${current} → v${latest}. ` +
        `Call update_lucid() to update, or: npm install -g @a13xu/lucid@latest`,
    );
  }
}

// ---------------------------------------------------------------------------
// Schema & handler
// ---------------------------------------------------------------------------

export const UpdateLucidSchema = z.object({
  force: z
    .boolean()
    .optional()
    .describe("Force reinstall even if already on latest version"),
});

// Example call:
//   handleUpdateLucid({ force: false })

export async function handleUpdateLucid(
  args: z.infer<typeof UpdateLucidSchema>,
): Promise<string> {
  const current = getCurrentVersion();
  const lines: string[] = [`🔍 Checking for updates... (current: v${current})`];

  const latest = await fetchLatestVersion();

  if (!latest) {
    return lines.concat("❌ Could not reach npm registry. Check your internet connection.").join("\n");
  }

  lines.push(`📦 Latest on npm: v${latest}`);

  const upToDate = compareVersions(latest, current) <= 0;
  if (upToDate && !args.force) {
    lines.push(`✅ Lucid is up to date.`);
    return lines.join("\n");
  }

  if (upToDate && args.force) {
    lines.push(`⚠️  Already on v${latest}, reinstalling (force=true)...`);
  } else {
    lines.push(`🔄 Updating v${current} → v${latest}...`);
  }

  const method = detectInstallMethod();

  if (method === "local-source") {
    lines.push(``);
    lines.push(`📁 Local source installation detected (${PACKAGE_ROOT}).`);
    lines.push(`Run these commands to update:`);
    lines.push(`  cd "${PACKAGE_ROOT}"`);
    lines.push(`  git pull`);
    lines.push(`  npm run build`);
    lines.push(`Then restart Claude Code.`);
    return lines.join("\n");
  }

  // Global npm install
  try {
    lines.push(`Running: npm install -g @a13xu/lucid@${latest}`);
    execSync(`npm install -g @a13xu/lucid@${latest}`, {
      timeout: 120_000,
      stdio: "pipe",
    });
    lines.push(`✅ Updated to v${latest}`);
    lines.push(``);
    lines.push(`⚠️  Restart Claude Code to load the new version:`);
    lines.push(`   • VS Code: Cmd/Ctrl+Shift+P → "Restart Claude Code"`);
    lines.push(`   • CLI: exit and re-run \`claude\``);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`❌ Auto-update failed: ${msg}`);
    lines.push(`   Run manually: npm install -g @a13xu/lucid@${latest}`);
    if (process.platform !== "win32") {
      lines.push(`   Or with sudo: sudo npm install -g @a13xu/lucid@${latest}`);
    }
  }

  return lines.join("\n");
}
