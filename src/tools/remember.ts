import { z } from "zod";
import type { Statements } from "../database.js";

export const RememberSchema = z.object({
  entity: z.string().min(1),
  entityType: z.enum([
    "person", "project", "decision", "pattern",
    "tool", "config", "bug", "convention",
  ]),
  observation: z.string().min(1),
});

export type RememberInput = z.infer<typeof RememberSchema>;

export function remember(stmts: Statements, input: RememberInput): string {
  const { entity, entityType, observation } = input;

  const existing = stmts.getEntityByName.get(entity);

  if (existing) {
    const observations: string[] = JSON.parse(existing.observations);

    // Nu adăuga duplicate
    if (!observations.includes(observation)) {
      observations.push(observation);
      stmts.updateEntity.run(JSON.stringify(observations), existing.id as number);
    }

    return `Updated "${entity}" [${existing.type}] — ${observations.length} observation(s) total.`;
  } else {
    stmts.insertEntity.run(entity, entityType, JSON.stringify([observation]));
    return `Created "${entity}" [${entityType}].`;
  }
}
