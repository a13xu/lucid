import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { Task } from "../types";
import { getTestsForTask, updateTaskStatus, runAllTests } from "../api";

const STATUS_COLORS: Record<string, string> = {
  pending:     "bg-gray-500/20 text-gray-400",
  in_progress: "bg-blue-500/20 text-blue-400",
  done:        "bg-emerald-500/20 text-emerald-400",
  blocked:     "bg-red-500/20 text-red-400",
};

const STATUSES = ["pending", "in_progress", "done", "blocked"] as const;

const METHOD_COLORS: Record<string, string> = {
  GET:    "bg-blue-500/20 text-blue-400",
  POST:   "bg-green-500/20 text-green-400",
  PUT:    "bg-yellow-500/20 text-yellow-400",
  PATCH:  "bg-orange-500/20 text-orange-400",
  DELETE: "bg-red-500/20 text-red-400",
};

interface TaskAccordionProps {
  task: Task;
  planId: number;
}

export function TaskAccordion({ task, planId }: TaskAccordionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [runAllStatus, setRunAllStatus] = useState<"idle" | "running" | "done">("idle");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: tests = [] } = useQuery({
    queryKey: ["tests", task.id],
    queryFn: () => getTestsForTask(task.id),
    enabled: isOpen,
  });

  const statusMutation = useMutation({
    mutationFn: ({ status, note }: { status: string; note?: string }) =>
      updateTaskStatus(task.id, status, note),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plan", planId] });
    },
  });

  const handleRunAll = async () => {
    setRunAllStatus("running");
    try {
      await runAllTests(task.id);
      queryClient.invalidateQueries({ queryKey: ["tests", task.id] });
    } finally {
      setRunAllStatus("done");
      setTimeout(() => setRunAllStatus("idle"), 2000);
    }
  };

  const badgeClass = STATUS_COLORS[task.status] ?? "bg-gray-500/20 text-gray-400";

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        className="w-full flex items-center gap-3 px-4 py-3 bg-gray-800 hover:bg-gray-750 transition-colors text-left"
        onClick={() => setIsOpen(o => !o)}
      >
        <span className="text-xs font-mono text-gray-500 w-6 shrink-0">
          {task.seq}
        </span>
        <span className="flex-1 font-medium text-white">{task.title}</span>
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badgeClass}`}>
          {task.status}
        </span>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Body */}
      {isOpen && (
        <div className="bg-gray-850 border-t border-gray-700 p-4 space-y-4">
          {/* Description */}
          <p className="text-sm text-gray-300">{task.description}</p>

          {/* Test criteria */}
          <div className="bg-gray-900 rounded-lg p-3">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Test Criteria</p>
            <p className="text-sm text-gray-300">{task.test_criteria}</p>
          </div>

          {/* Status control */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Status:</span>
            <select
              value={task.status}
              onChange={e => statusMutation.mutate({ status: e.target.value })}
              className="text-xs bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white"
            >
              {STATUSES.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          {/* Notes timeline */}
          {task.notes.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-gray-500 uppercase tracking-wide">Notes</p>
              {task.notes.map((n, i) => (
                <div key={i} className="flex gap-2 text-sm">
                  <span className="text-gray-600 shrink-0">
                    {new Date(n.ts * 1000).toISOString().slice(0, 10)}
                  </span>
                  <span className="text-gray-300">{n.text}</span>
                </div>
              ))}
            </div>
          )}

          {/* HTTP Tests section */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-500 uppercase tracking-wide">HTTP Tests</p>
              <div className="flex gap-2">
                <button
                  onClick={handleRunAll}
                  disabled={runAllStatus === "running" || tests.length === 0}
                  className="text-xs px-2 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 rounded text-white transition-colors"
                >
                  {runAllStatus === "running" ? "Running…" : runAllStatus === "done" ? "Done!" : "Run All"}
                </button>
                <button
                  onClick={() => navigate(`/tests/${task.id}`)}
                  className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-white transition-colors"
                >
                  + Add Test
                </button>
              </div>
            </div>

            {tests.length === 0 ? (
              <p className="text-sm text-gray-500 italic">No tests yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 border-b border-gray-700">
                    <th className="text-left py-1 pr-2">Name</th>
                    <th className="text-left py-1 pr-2">Method</th>
                    <th className="text-left py-1 pr-2">URL</th>
                    <th className="text-left py-1">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {tests.map(t => (
                    <tr
                      key={t.id}
                      className="border-b border-gray-800 hover:bg-gray-800/50 cursor-pointer"
                      onClick={() => navigate(`/tests/${task.id}`)}
                    >
                      <td className="py-1.5 pr-2 text-gray-200">{t.name}</td>
                      <td className="py-1.5 pr-2">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-mono ${METHOD_COLORS[t.method] ?? ""}`}>
                          {t.method}
                        </span>
                      </td>
                      <td className="py-1.5 pr-2 text-gray-400 max-w-[200px] truncate">{t.url}</td>
                      <td className="py-1.5">
                        {t.last_run_status === "pass" && <span className="text-emerald-400">✓</span>}
                        {t.last_run_status === "fail" && <span className="text-red-400">✗</span>}
                        {t.last_run_status === "error" && <span className="text-yellow-400">!</span>}
                        {!t.last_run_status && <span className="text-gray-600">–</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
