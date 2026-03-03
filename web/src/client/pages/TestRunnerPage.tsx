import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import { getTask, getTestsForTask, getTestRuns, createTest, updateTest, deleteTest, runTest, runAllTests } from "../api";
import { TestDefinitionEditor } from "../components/TestDefinitionEditor";
import { TestResultPanel } from "../components/TestResultPanel";
import type { TestDefinition, TestRun, CreateTestInput } from "../types";

const METHOD_COLORS: Record<string, string> = {
  GET:    "bg-blue-500/20 text-blue-400",
  POST:   "bg-green-500/20 text-green-400",
  PUT:    "bg-yellow-500/20 text-yellow-400",
  PATCH:  "bg-orange-500/20 text-orange-400",
  DELETE: "bg-red-500/20 text-red-400",
};

export function TestRunnerPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tid = Number(taskId);

  const [selectedTest, setSelectedTest] = useState<TestDefinition | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [currentRun, setCurrentRun] = useState<TestRun | null>(null);
  const [runningId, setRunningId] = useState<number | null>(null);
  const [runAllStatus, setRunAllStatus] = useState<"idle" | "running">("idle");

  // Data queries
  const { data: task } = useQuery({
    queryKey: ["task", tid],
    queryFn: () => getTask(tid),
    enabled: !isNaN(tid),
  });

  const { data: tests = [] } = useQuery({
    queryKey: ["tests", tid],
    queryFn: () => getTestsForTask(tid),
    enabled: !isNaN(tid),
  });

  // Runs for the selected test
  const activeTestId = selectedTest?.id;
  const { data: runs = [] } = useQuery({
    queryKey: ["runs", activeTestId],
    queryFn: () => getTestRuns(activeTestId!),
    enabled: activeTestId != null,
  });

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: CreateTestInput) => createTest(tid, data),
    onSuccess: (newDef) => {
      queryClient.invalidateQueries({ queryKey: ["tests", tid] });
      setIsCreating(false);
      setSelectedTest(newDef);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: CreateTestInput) => updateTest(selectedTest!.id, data),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["tests", tid] });
      setSelectedTest(updated);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteTest(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tests", tid] });
      setSelectedTest(null);
      setCurrentRun(null);
    },
  });

  const handleRun = async (testId: number) => {
    setRunningId(testId);
    try {
      const run = await runTest(testId);
      setCurrentRun(run);
      queryClient.invalidateQueries({ queryKey: ["runs", testId] });
      queryClient.invalidateQueries({ queryKey: ["tests", tid] });
    } finally {
      setRunningId(null);
    }
  };

  const handleRunAll = async () => {
    setRunAllStatus("running");
    try {
      await runAllTests(tid);
      queryClient.invalidateQueries({ queryKey: ["tests", tid] });
    } finally {
      setRunAllStatus("idle");
    }
  };

  const handleSave = async (data: CreateTestInput) => {
    if (isCreating) {
      await createMutation.mutateAsync(data);
    } else if (selectedTest) {
      await updateMutation.mutateAsync(data);
    }
  };

  // Breadcrumb: need plan info from task
  const planId = task?.plan_id;

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* Top bar */}
      <div className="border-b border-gray-800 px-4 py-3 flex items-center gap-2 text-sm">
        <button onClick={() => navigate("/plans")}
          className="text-gray-500 hover:text-gray-300 transition-colors">Plans</button>
        <span className="text-gray-700">›</span>
        {planId && (
          <>
            <button onClick={() => navigate(`/plans/${planId}`)}
              className="text-gray-500 hover:text-gray-300 transition-colors">
              Plan #{planId}
            </button>
            <span className="text-gray-700">›</span>
          </>
        )}
        <span className="text-gray-300">
          {task ? task.title : `Task #${tid}`}
        </span>
        <span className="text-gray-700">›</span>
        <span className="text-white">HTTP Tests</span>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: test list + editor */}
        <div className="w-[480px] shrink-0 border-r border-gray-800 flex flex-col overflow-hidden">
          {/* Test list header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <span className="text-sm font-medium text-gray-300">
              Tests ({tests.length})
            </span>
            <div className="flex gap-2">
              <button
                onClick={handleRunAll}
                disabled={runAllStatus === "running" || tests.length === 0}
                className="text-xs px-2 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 rounded text-white transition-colors"
              >
                {runAllStatus === "running" ? "Running…" : "Run All"}
              </button>
              <button
                onClick={() => { setIsCreating(true); setSelectedTest(null); }}
                className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white transition-colors"
              >
                + New
              </button>
            </div>
          </div>

          {/* Test list */}
          <div className="overflow-y-auto flex-shrink-0 max-h-52 border-b border-gray-800">
            {tests.length === 0 && !isCreating && (
              <p className="text-sm text-gray-500 p-4 italic">No tests yet. Click + New to create one.</p>
            )}
            {tests.map(t => (
              <div
                key={t.id}
                onClick={() => { setSelectedTest(t); setIsCreating(false); }}
                className={`flex items-center gap-2 px-4 py-2.5 cursor-pointer border-b border-gray-800 hover:bg-gray-800 transition-colors ${
                  selectedTest?.id === t.id ? "bg-gray-800 border-l-2 border-l-indigo-500" : ""
                }`}
              >
                <span className={`px-1.5 py-0.5 rounded text-xs font-mono ${METHOD_COLORS[t.method] ?? ""}`}>
                  {t.method}
                </span>
                <span className="flex-1 text-sm text-gray-200 truncate">{t.name}</span>
                <span className="shrink-0">
                  {t.last_run_status === "pass" && <span className="text-emerald-400 text-xs">✓</span>}
                  {t.last_run_status === "fail" && <span className="text-red-400 text-xs">✗</span>}
                  {t.last_run_status === "error" && <span className="text-yellow-400 text-xs">!</span>}
                  {!t.last_run_status && <span className="text-gray-600 text-xs">–</span>}
                </span>
                <button
                  onClick={e => { e.stopPropagation(); handleRun(t.id); }}
                  disabled={runningId === t.id}
                  className="shrink-0 text-xs px-2 py-0.5 bg-indigo-600/50 hover:bg-indigo-600 disabled:bg-gray-700 rounded text-white transition-colors"
                >
                  {runningId === t.id ? "…" : "▶"}
                </button>
              </div>
            ))}
          </div>

          {/* Editor */}
          <div className="flex-1 overflow-y-auto p-4">
            {(isCreating || selectedTest) ? (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-200">
                    {isCreating ? "New Test" : "Edit Test"}
                  </h3>
                  {!isCreating && selectedTest && (
                    <button
                      onClick={() => {
                        if (confirm(`Delete "${selectedTest.name}"?`)) {
                          deleteMutation.mutate(selectedTest.id);
                        }
                      }}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  )}
                </div>
                <TestDefinitionEditor
                  initial={isCreating ? null : selectedTest}
                  taskId={tid}
                  onSave={handleSave}
                  onCancel={() => { setIsCreating(false); }}
                  isSaving={createMutation.isPending || updateMutation.isPending}
                />
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-600 text-sm">
                Select a test to edit
              </div>
            )}
          </div>
        </div>

        {/* Right panel: result */}
        <div className="flex-1 overflow-y-auto p-6">
          <h2 className="text-sm font-semibold text-gray-400 mb-4">
            {selectedTest ? `Result — ${selectedTest.name}` : "Test Result"}
          </h2>
          <TestResultPanel
            run={currentRun}
            history={runs}
          />
        </div>
      </div>
    </div>
  );
}
