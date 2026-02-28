export type EntityType =
  | "person"
  | "project"
  | "decision"
  | "pattern"
  | "tool"
  | "config"
  | "bug"
  | "convention";

export type RelationType =
  | "uses"
  | "depends_on"
  | "created_by"
  | "part_of"
  | "replaced_by"
  | "conflicts_with"
  | "tested_by";

export interface Entity {
  id: number;
  name: string;
  type: EntityType;
  observations: string[];
  created_at: number;
  updated_at: number;
}

export interface EntityRow {
  id: number;
  name: string;
  type: string;
  observations: string; // JSON string
  created_at: number;
  updated_at: number;
}

export interface Relation {
  id: number;
  from_entity: number;
  to_entity: number;
  relation_type: RelationType;
  created_at: number;
}

export interface RelationRow {
  id: number;
  from_entity: number;
  to_entity: number;
  relation_type: string;
  created_at: number;
}

export interface EntityWithRelations extends Entity {
  relations: RelationDisplay[];
}

export interface RelationDisplay {
  from: string;
  to: string;
  type: string;
}

export interface MemoryStats {
  entity_count: number;
  relation_count: number;
  observation_count: number;
  db_size_bytes: number;
  db_size_kb: number;
  wal_mode: boolean;
  fts5_enabled: boolean;
}

export interface KnowledgeGraph {
  stats: MemoryStats;
  entities: EntityWithRelations[];
}
