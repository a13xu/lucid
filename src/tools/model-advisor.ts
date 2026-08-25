import { z } from "zod";

export const SuggestModelSchema = z.object({
  task_description: z.string().min(1).describe(
    "Natural language description of the task you are about to perform"
  ),
});

const HAIKU_TRIGGERS = [
  "list", "show", "find", "search", "where", "what is",
  "recall", "get recent", "status",
];

const OPUS_TRIGGERS = [
  "implement", "refactor", "architecture", "debug", "root cause",
  "security", "review", "design", "migrate", "fix bug",
];

// Sonnet only when the caller explicitly parallelizes mid-level work.
const SONNET_TRIGGERS = [
  "parallel", "parallelize", "fan out", "bulk",
];

// Always the latest generation of each tier. Update on new model releases.
const MODEL_IDS = {
  haiku:  "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
  opus:   "claude-opus-5",
};

const CONTEXT_BUDGETS: Record<string, number> = {
  haiku:  2000,
  sonnet: 8000,
  opus:   16000,
};

export function handleSuggestModel(
  args: z.infer<typeof SuggestModelSchema>
): string {
  const lower = args.task_description.toLowerCase();
  const haikuTrigger = HAIKU_TRIGGERS.find((t) => lower.includes(t));
  const opusTrigger = OPUS_TRIGGERS.find((t) => lower.includes(t));
  const sonnetTrigger = SONNET_TRIGGERS.find((t) => lower.includes(t));

  // Opus wins over everything: "review recent changes" is implementation-tier
  // work. The default is Opus too — an unclassified task is more likely real
  // work than a lookup, and a weak-model default silently degrades it.
  const model: "haiku" | "sonnet" | "opus" = opusTrigger
    ? "opus"
    : sonnetTrigger
      ? "sonnet"
      : haikuTrigger
        ? "haiku"
        : "opus";

  const reasoning = opusTrigger
    ? `Task matches implementation/analysis pattern ("${opusTrigger}") — Opus for edits, debugging, reviews, and architecture.`
    : sonnetTrigger
      ? `Task parallelizes mid-level work ("${sonnetTrigger}") — Sonnet for fan-out throughput.`
      : haikuTrigger
        ? `Task matches retrieval/lookup pattern ("${haikuTrigger}") — Haiku is faster for read-only queries.`
        : "No specific trigger detected — defaulting to Opus; unclassified tasks are treated as real work, never downgraded.";

  return JSON.stringify({
    model,
    model_id: MODEL_IDS[model],
    reasoning,
    context_budget: CONTEXT_BUDGETS[model],
  }, null, 2);
}
