import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import { getPlan, updatePlanStatus } from "../api";
import { ProgressBar } from "../components/ProgressBar";
import { TaskAccordion } from "../components/TaskAccordion";
import type { PlanStatus } from "../types";

const PLAN_STATUSES: PlanStatus[] = ["active", "completed", "abandoned"];

export function PlanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const planId = Number(id);

  const { data: plan, isLoading, isError } = useQuery({
    queryKey: ["plan", planId],
    queryFn: () => getPlan(planId),
    enabled: !isNaN(planId),
  });

  const statusMutation = useMutation({
    mutationFn: (status: string) => updatePlanStatus(planId, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plan", planId] });
      queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-500">
        Loading…
      </div>
    );
  }

  if (isError || !plan) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center text-red-400">
        Failed to load plan
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* Breadcrumb */}
        <button
          onClick={() => navigate("/plans")}
          className="text-sm text-gray-500 hover:text-gray-300 mb-4 flex items-center gap-1 transition-colors"
        >
          ← Plans
        </button>

        {/* Plan header */}
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 mb-6">
          <div className="flex items-start justify-between gap-4 mb-3">
            <h1 className="text-xl font-bold text-white">{plan.title}</h1>
            <select
              value={plan.status}
              onChange={e => statusMutation.mutate(e.target.value)}
              className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm text-white shrink-0 focus:outline-none focus:border-indigo-500"
            >
              {PLAN_STATUSES.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <p className="text-sm text-gray-400 mb-1 font-medium">User Story</p>
          <p className="text-sm text-gray-300 mb-4">{plan.user_story}</p>

          {plan.description && plan.description !== plan.title && (
            <p className="text-sm text-gray-400 mb-4">{plan.description}</p>
          )}

          <ProgressBar done={plan.tasks_done} total={plan.task_count} />
        </div>

        {/* Tasks */}
        <h2 className="text-sm text-gray-500 uppercase tracking-wide mb-3">
          Tasks ({plan.tasks?.length ?? 0})
        </h2>
        <div className="space-y-2">
          {(plan.tasks ?? []).map(task => (
            <TaskAccordion key={task.id} task={task} planId={planId} />
          ))}
          {(plan.tasks ?? []).length === 0 && (
            <p className="text-gray-500 text-sm">No tasks in this plan.</p>
          )}
        </div>
      </div>
    </div>
  );
}
