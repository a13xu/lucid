/**
 * Claude CLI service for conversational chat.
 * Uses the local `claude --print` CLI instead of the Anthropic SDK.
 */
import { execSync } from "child_process";
import { claudeStream, claudePrint } from "./claude-env.js";

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are a helpful project planning assistant integrated into a development dashboard.
Your job is to help users create development plans with user stories and tasks.

When the user describes a feature or project, generate a structured plan with:
- A clear plan title and description
- A user story in the format "As a [user], I want [goal], so that [benefit]."
- An ordered list of implementation tasks, each with:
  - title (short, imperative verb phrase, e.g. "Add login endpoint")
  - description (what specifically needs to be done)
  - test_criteria (concrete, verifiable condition proving it's done)

Respond conversationally. When the user confirms or asks you to finalize, output EXACTLY one JSON block:
\`\`\`json
{
  "type": "plan",
  "title": "...",
  "description": "...",
  "user_story": "As a [user], I want [goal], so that [benefit].",
  "tasks": [
    { "title": "...", "description": "...", "test_criteria": "..." }
  ]
}
\`\`\`

Rules:
- Tasks must be ordered from first to last (dependencies respected)
- 3–10 tasks is the ideal range; split large tasks, merge trivial ones
- test_criteria must be a single verifiable sentence starting with a verb
- You can ask clarifying questions before generating
- The user can correct titles, tasks, or the user story — apply changes and re-output the JSON block`;

const PLAN_GENERATION_SYSTEM =
  "You are a software project planning assistant. Always respond with valid JSON only — no markdown, no explanation.";

const PLAN_GENERATION_PROMPT = `Analyze the following project description and generate a complete development plan.

Description:
{description}

Output ONLY a JSON object (no markdown, no explanation) with this exact structure:
{
  "type": "plan",
  "title": "Short descriptive title (5–10 words)",
  "description": "One or two sentences summarising the scope and goal.",
  "user_story": "As a [user], I want [goal], so that [benefit].",
  "tasks": [
    {
      "title": "Imperative verb phrase (3–7 words)",
      "description": "What needs to be implemented or done.",
      "test_criteria": "Single verifiable sentence starting with a verb."
    }
  ]
}

Requirements:
- 3 to 10 tasks, ordered by dependency (earlier tasks unblock later ones)
- Every task title starts with an imperative verb (Add, Create, Implement, Fix, etc.)
- test_criteria must be concrete and directly testable
- Return ONLY the JSON — no markdown fences, no commentary`;

/**
 * Check if the Claude CLI is available.
 */
export function checkConfig() {
  try {
    execSync("claude --version", { stdio: "ignore" });
    return { configured: true, mode: "cli", model: MODEL };
  } catch {
    return {
      configured: false,
      message: "Claude CLI not found. Make sure Claude Code is installed and 'claude' is in your PATH.",
    };
  }
}

/**
 * Send a message in a conversation and get a streaming response.
 * @param {Array<{role: string, content: string}>} messages - Full conversation history
 * @param {function(string): void} onChunk - Called for each text chunk as it streams
 * @returns {Promise<string>} - Full response text
 */
export async function chat(messages, onChunk = () => {}) {
  const history = messages.slice(0, -1);
  const lastMsg = messages[messages.length - 1];

  let prompt = "";
  if (history.length > 0) {
    prompt += "<conversation_history>\n";
    for (const msg of history) {
      const role = msg.role === "user" ? "Human" : "Assistant";
      prompt += `${role}: ${msg.content}\n\n`;
    }
    prompt += "</conversation_history>\n\n";
    prompt += `Current message: ${lastMsg.content}`;
  } else {
    prompt = lastMsg.content;
  }

  return claudeStream(prompt, onChunk, { model: MODEL, systemPrompt: SYSTEM_PROMPT });
}

/**
 * Generate a structured development plan from a plain-text description.
 * @param {string} description - Free-form description of the project/feature
 * @returns {Promise<{title, description, user_story, tasks}>} Parsed plan object
 */
export async function generatePlan(description) {
  if (!description || typeof description !== "string" || !description.trim()) {
    throw new Error("description is required");
  }

  const prompt = PLAN_GENERATION_PROMPT.replace("{description}", description.trim());
  const rawText = await claudePrint(prompt, { model: MODEL, systemPrompt: PLAN_GENERATION_SYSTEM });

  // Strip accidental markdown fences if present
  const jsonText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  let plan;
  try {
    plan = JSON.parse(jsonText);
  } catch {
    throw new Error(`Claude returned non-JSON response: ${rawText.slice(0, 200)}`);
  }

  const missing = ["title", "description", "user_story", "tasks"].filter((f) => !plan[f]);
  if (missing.length > 0) {
    throw new Error(`Plan JSON missing required fields: ${missing.join(", ")}`);
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error("Plan JSON must include a non-empty tasks array");
  }

  return {
    type: "plan",
    title: plan.title,
    description: plan.description,
    user_story: plan.user_story,
    tasks: plan.tasks.map((t) => ({
      title: t.title ?? "",
      description: t.description ?? "",
      test_criteria: t.test_criteria ?? "",
    })),
  };
}
