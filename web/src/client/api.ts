import type {
  PlanSummary,
  PlanDetail,
  Task,
  TestDefinition,
  TestRun,
  CreatePlanInput,
  CreateTestInput,
  UpdateTestInput,
} from "./types";

// ---------------------------------------------------------------------------
// Base fetch helper
// ---------------------------------------------------------------------------
async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const body = await res.json(); msg = body.error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------
export function getPlans(status?: string): Promise<PlanSummary[]> {
  const qs = status && status !== "all" ? `?status=${status}` : "";
  return apiFetch<PlanSummary[]>(`/api/plans${qs}`);
}

export function getPlan(id: number): Promise<PlanDetail> {
  return apiFetch<PlanDetail>(`/api/plans/${id}`);
}

export function createPlan(data: CreatePlanInput): Promise<PlanDetail> {
  return apiFetch<PlanDetail>("/api/plans", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updatePlanStatus(id: number, status: string): Promise<PlanSummary> {
  return apiFetch<PlanSummary>(`/api/plans/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export function deletePlan(id: number): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/api/plans/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
export function getTask(id: number): Promise<Task & { tests: TestDefinition[] }> {
  return apiFetch<Task & { tests: TestDefinition[] }>(`/api/tasks/${id}`);
}

export function updateTaskStatus(
  id: number,
  status: string,
  note?: string
): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status, note }),
  });
}

// ---------------------------------------------------------------------------
// Test Definitions
// ---------------------------------------------------------------------------
export function getTestsForTask(taskId: number): Promise<TestDefinition[]> {
  return apiFetch<TestDefinition[]>(`/api/tasks/${taskId}/tests`);
}

export function createTest(taskId: number, data: CreateTestInput): Promise<TestDefinition> {
  return apiFetch<TestDefinition>(`/api/tasks/${taskId}/tests`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateTest(id: number, data: UpdateTestInput): Promise<TestDefinition> {
  return apiFetch<TestDefinition>(`/api/tests/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteTest(id: number): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/api/tests/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Test Runs
// ---------------------------------------------------------------------------
export function runTest(id: number): Promise<TestRun> {
  return apiFetch<TestRun>(`/api/tests/${id}/run`, { method: "POST" });
}

export function getTestRuns(id: number): Promise<TestRun[]> {
  return apiFetch<TestRun[]>(`/api/tests/${id}/runs`);
}

export function runAllTests(taskId: number): Promise<TestRun[]> {
  return apiFetch<TestRun[]>(`/api/tasks/${taskId}/tests/run-all`, { method: "POST" });
}
