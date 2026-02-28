import { z } from "zod";
import type { Statements } from "../database.js";

export const RelateSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relationType: z.enum([
    "uses", "depends_on", "created_by", "part_of",
    "replaced_by", "conflicts_with", "tested_by",
  ]),
});

export type RelateInput = z.infer<typeof RelateSchema>;

export function relate(stmts: Statements, input: RelateInput): string {
  const fromEntity = stmts.getEntityByName.get(input.from);
  if (!fromEntity) {
    return `Error: Entity "${input.from}" not found. Use remember() to create it first.`;
  }

  const toEntity = stmts.getEntityByName.get(input.to);
  if (!toEntity) {
    return `Error: Entity "${input.to}" not found. Use remember() to create it first.`;
  }

  stmts.insertRelation.run(fromEntity.id, toEntity.id, input.relationType);
  return `${input.from} --[${input.relationType}]--> ${input.to}`;
}
