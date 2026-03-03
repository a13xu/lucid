import type { PlanSummary } from "../types";
import { ProgressBar } from "./ProgressBar";

const STATUS_BADGE: Record<string, string> = {
  active:    "bg-blue-500/20 text-blue-400",
  completed: "bg-emerald-500/20 text-emerald-400",
  abandoned: "bg-gray-500/20 text-gray-400",
};

interface PlanCardProps {
  plan: PlanSummary;
  onClick: () => void;
}

export function PlanCard({ plan, onClick }: PlanCardProps) {
  const badgeClass = STATUS_BADGE[plan.status] ?? "bg-gray-500/20 text-gray-400";
  const truncated = plan.user_story.length > 120
    ? plan.user_story.slice(0, 120) + "…"
    : plan.user_story;

  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-gray-600 rounded-xl p-5 transition-all group"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="font-semibold text-white group-hover:text-indigo-300 transition-colors line-clamp-2">
          {plan.title}
        </h3>
        <span className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${badgeClass}`}>
          {plan.status}
        </span>
      </div>
      <p className="text-sm text-gray-400 mb-4 line-clamp-2">{truncated}</p>
      <ProgressBar done={plan.tasks_done} total={plan.task_count} />
    </button>
  );
}
