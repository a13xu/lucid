// ---------------------------------------------------------------------------
// Shared client-side types (mirror server DB shapes with parsed JSON fields)
// ---------------------------------------------------------------------------

export interface Note {
  text: string;
  ts: number; // unix epoch seconds
}

export type PlanStatus = "active" | "completed" | "abandoned";
export type TaskStatus = "pending" | "in_progress" | "done" | "blocked";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type RunStatus = "pass" | "fail" | "error";

// From /api/plans list endpoint (includes task stats)
export interface PlanSummary {
  id: number;
  title: string;
  description: string;
  user_story: string;
  status: PlanStatus;
  created_at: number;
  updated_at: number;
  task_count: number;
  tasks_done: number;
}

// From /api/plans/:id detail endpoint
export interface PlanDetail extends PlanSummary {
  tasks: Task[];
}

export interface Task {
  id: number;
  plan_id: number;
  seq: number;
  title: string;
  description: string;
  test_criteria: string;
  status: TaskStatus;
  notes: Note[]; // parsed from JSON
  created_at: number;
  updated_at: number;
  test_count?: number;
}

// Assertion types
export type AssertionType =
  | "status"
  | "body_key_exists"
  | "body_json_path"
  | "body_contains";

export type Assertion =
  | { type: "status"; expected: number }
  | { type: "body_key_exists"; key: string }
  | { type: "body_json_path"; path: string; expected: unknown }
  | { type: "body_contains"; value: string };

export interface AssertionResult {
  type: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
}

export interface TestDefinition {
  id: number;
  task_id: number;
  name: string;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>; // parsed from JSON
  body?: string | null;
  assertions: Assertion[]; // parsed from JSON
  created_at: number;
  updated_at: number;
  last_run_status?: RunStatus | null;
  last_run_at?: number | null;
}

export interface TestRun {
  id: number;
  test_def_id: number;
  status: RunStatus;
  status_code?: number | null;
  response_body?: string | null;
  response_headers: Record<string, string>;
  duration_ms?: number | null;
  error_message?: string | null;
  assertions_result: AssertionResult[];
  run_at: number;
}

// Form inputs
export interface CreatePlanInput {
  title: string;
  description: string;
  user_story: string;
  tasks: Array<{
    title: string;
    description: string;
    test_criteria: string;
  }>;
}

export interface CreateTestInput {
  name: string;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string | null;
  assertions: Assertion[];
}

export type UpdateTestInput = CreateTestInput;

// Local form state for assertion builder
export interface AssertionFormItem {
  _id: string; // React key only
  type: AssertionType;
  statusExpected: string;
  key: string;
  path: string;
  pathExpected: string;
  containsValue: string;
}

// Local form state for headers KV editor
export interface HeaderItem {
  _id: string;
  key: string;
  value: string;
}
