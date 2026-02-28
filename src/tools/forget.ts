import { z } from "zod";
import type { Statements } from "../database.js";

export const ForgetSchema = z.object({
  entity: z.string().min(1),
});

export type ForgetInput = z.infer<typeof ForgetSchema>;

export function forget(stmts: Statements, input: ForgetInput): string {
  const existing = stmts.getEntityByName.get(input.entity);
  if (!existing) {
    return `Entity "${input.entity}" not found in memory.`;
  }

  // ON DELETE CASCADE șterge relațiile automat
  stmts.deleteEntity.run(input.entity);
  return `Removed "${input.entity}" and all its relations from memory.`;
}
