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

const MODEL_IDS = {
  haiku:  "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
};

const CONTEXT_BUDGETS: Record<string, number> = {
  haiku:  2000,
  sonnet: 8000,
};

export function handleSuggestModel(
  args: z.infer<typeof SuggestModelSchema>
): string {
  const lower = args.task_description.toLowerCase();
  const haikuTrigger = HAIKU_TRIGGERS.find((t) => lower.includes(t));

  const model: "haiku" | "sonnet" = haikuTrigger ? "haiku" : "sonnet";
  const reasoning = haikuTrigger
    ? `Task matches retrieval/lookup pattern ("${haikuTrigger}") — Haiku is faster for read-only queries.`
    : "No simple retrieval trigger detected — defaulting to Sonnet for reasoning, code generation, and analysis.";

  return JSON.stringify({
    model,
    model_id: MODEL_IDS[model],
    reasoning,
    context_budget: CONTEXT_BUDGETS[model],
  }, null, 2);
}
