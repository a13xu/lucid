import { useState } from "react";
import type { TestRun } from "../types";

const STATUS_STYLE: Record<string, string> = {
  pass:  "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  fail:  "bg-red-500/20 text-red-400 border-red-500/30",
  error: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
};

interface TestResultPanelProps {
  run: TestRun | null;
  history?: TestRun[];
}

export function TestResultPanel({ run, history = [] }: TestResultPanelProps) {
  const [bodyCollapsed, setBodyCollapsed] = useState(false);

  if (!run) {
    return (
      <div className="flex items-center justify-center h-full text-gray-600 text-sm">
        Run a test to see results
      </div>
    );
  }

  const statusStyle = STATUS_STYLE[run.status] ?? STATUS_STYLE["error"]!;

  // Format JSON body if possible
  let formattedBody = run.response_body ?? "";
  try {
    const parsed = JSON.parse(formattedBody);
    formattedBody = JSON.stringify(parsed, null, 2);
  } catch { /* keep raw */ }

  const bodyLines = formattedBody.split("\n");
  const displayLines = bodyCollapsed ? bodyLines.slice(0, 20) : bodyLines.slice(0, 300);

  // Sparkline from history (last 10, oldest first)
  const sparkline = [...history].reverse().slice(0, 10);

  return (
    <div className="space-y-4 overflow-auto">
      {/* Status badge + duration */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`px-3 py-1 rounded-full text-sm font-semibold border ${statusStyle}`}>
          {run.status.toUpperCase()}
        </span>
        {run.status_code != null && (
          <span className="text-sm font-mono text-gray-300">
            HTTP {run.status_code}
          </span>
        )}
        {run.duration_ms != null && (
          <span className="text-sm text-gray-500">{run.duration_ms}ms</span>
        )}
        <span className="text-xs text-gray-600 ml-auto">
          {new Date(run.run_at * 1000).toLocaleTimeString()}
        </span>
      </div>

      {/* Error message */}
      {run.error_message && (
        <div className="bg-red-900/20 border border-red-500/30 rounded p-3 text-red-300 text-sm font-mono">
          {run.error_message}
        </div>
      )}

      {/* Assertions */}
      {run.assertions_result.length > 0 && (
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Assertions</p>
          <div className="space-y-1">
            {run.assertions_result.map((a, i) => (
              <div key={i} className="flex items-start gap-2 text-sm bg-gray-900 rounded p-2">
                <span className={a.pass ? "text-emerald-400" : "text-red-400"}>
                  {a.pass ? "✓" : "✗"}
                </span>
                <span className="text-gray-400 font-mono text-xs">{a.type}</span>
                <span className="text-gray-500 text-xs">expected:</span>
                <span className="text-gray-300 text-xs font-mono">
                  {JSON.stringify(a.expected)}
                </span>
                {!a.pass && (
                  <>
                    <span className="text-gray-500 text-xs">got:</span>
                    <span className="text-red-300 text-xs font-mono">
                      {JSON.stringify(a.actual)}
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Response body */}
      {formattedBody && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Response Body</p>
            {bodyLines.length > 20 && (
              <button
                onClick={() => setBodyCollapsed(c => !c)}
                className="text-xs text-indigo-400 hover:text-indigo-300"
              >
                {bodyCollapsed ? `Show all (${bodyLines.length} lines)` : "Collapse"}
              </button>
            )}
          </div>
          <pre className="bg-gray-900 rounded p-3 text-xs text-gray-300 font-mono overflow-auto max-h-64 whitespace-pre-wrap">
            {displayLines.join("\n")}
            {displayLines.length < bodyLines.length && (
              <span className="text-gray-600">
                {"\n"}… {bodyLines.length - displayLines.length} more lines
              </span>
            )}
          </pre>
        </div>
      )}

      {/* Run history sparkline */}
      {sparkline.length > 0 && (
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">
            History (last {sparkline.length})
          </p>
          <div className="flex gap-1 items-end h-8">
            {sparkline.map((r, i) => (
              <div
                key={r.id}
                title={`${r.status} • ${r.duration_ms ?? 0}ms`}
                className={`flex-1 rounded-sm transition-all ${
                  r.status === "pass" ? "bg-emerald-500" :
                  r.status === "fail" ? "bg-red-500" : "bg-yellow-500"
                }`}
                style={{ height: i === sparkline.length - 1 ? "100%" : "60%" }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
