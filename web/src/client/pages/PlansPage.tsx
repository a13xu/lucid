import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getPlans, createPlan } from "../api";
import { PlanCard } from "../components/PlanCard";
import type { PlanStatus, CreatePlanInput } from "../types";

const TABS: Array<{ label: string; value: PlanStatus | "all" }> = [
  { label: "Active",    value: "active" },
  { label: "Completed", value: "completed" },
  { label: "Abandoned", value: "abandoned" },
  { label: "All",       value: "all" },
];

// ---------------------------------------------------------------------------
// New Plan Modal
// ---------------------------------------------------------------------------
interface NewTaskInput {
  title: string;
  description: string;
  test_criteria: string;
}

function NewPlanModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [userStory, setUserStory] = useState("");
  const [tasks, setTasks] = useState<NewTaskInput[]>([
    { title: "", description: "", test_criteria: "" },
  ]);

  const mutation = useMutation({
    mutationFn: (data: CreatePlanInput) => createPlan(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plans"] });
      onClose();
    },
  });

  const addTask = () =>
    setTasks(t => [...t, { title: "", description: "", test_criteria: "" }]);
  const removeTask = (i: number) =>
    setTasks(t => t.filter((_, idx) => idx !== i));
  const updateTask = (i: number, field: keyof NewTaskInput, val: string) =>
    setTasks(t => t.map((task, idx) => idx === i ? { ...task, [field]: val } : task));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !description || !userStory || tasks.some(t => !t.title)) return;
    mutation.mutate({ title, description, user_story: userStory, tasks });
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center pt-16 px-4 z-50 overflow-y-auto">
      <div className="bg-gray-800 border border-gray-700 rounded-xl w-full max-w-2xl p-6 mb-16">
        <h2 className="text-lg font-semibold text-white mb-4">New Plan</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Title *</label>
            <input
              required value={title} onChange={e => setTitle(e.target.value)}
              placeholder="Plan title"
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Description *</label>
            <textarea
              required value={description} onChange={e => setDescription(e.target.value)}
              rows={2} placeholder="What is this plan about?"
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500 resize-none"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">User Story *</label>
            <textarea
              required value={userStory} onChange={e => setUserStory(e.target.value)}
              rows={2} placeholder="As a [user], I want [goal], so that [benefit]"
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500 resize-none"
            />
          </div>

          {/* Tasks */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-gray-400">Tasks *</label>
              <button type="button" onClick={addTask}
                className="text-xs text-indigo-400 hover:text-indigo-300">+ Add Task</button>
            </div>
            <div className="space-y-3">
              {tasks.map((t, i) => (
                <div key={i} className="bg-gray-900 rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">Task {i + 1}</span>
                    {tasks.length > 1 && (
                      <button type="button" onClick={() => removeTask(i)}
                        className="text-xs text-red-400 hover:text-red-300">Remove</button>
                    )}
                  </div>
                  <input
                    required value={t.title}
                    onChange={e => updateTask(i, "title", e.target.value)}
                    placeholder="Task title"
                    className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-indigo-500"
                  />
                  <input
                    value={t.description}
                    onChange={e => updateTask(i, "description", e.target.value)}
                    placeholder="Description (optional)"
                    className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-indigo-500"
                  />
                  <input
                    value={t.test_criteria}
                    onChange={e => updateTask(i, "test_criteria", e.target.value)}
                    placeholder="Test criteria (how to verify it's done)"
                    className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>
              ))}
            </div>
          </div>

          {mutation.isError && (
            <p className="text-red-400 text-sm">{String(mutation.error)}</p>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="submit" disabled={mutation.isPending}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 rounded px-4 py-2 text-white text-sm font-medium transition-colors"
            >
              {mutation.isPending ? "Creating…" : "Create Plan"}
            </button>
            <button
              type="button" onClick={onClose}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plans Page
// ---------------------------------------------------------------------------
export function PlansPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<PlanStatus | "all">("active");
  const [showModal, setShowModal] = useState(false);

  const { data: plans = [], isLoading, isError } = useQuery({
    queryKey: ["plans", activeTab],
    queryFn: () => getPlans(activeTab),
  });

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-5xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Plans</h1>
          <button
            onClick={() => setShowModal(true)}
            className="bg-indigo-600 hover:bg-indigo-500 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          >
            + New Plan
          </button>
        </div>

        {/* Status tabs */}
        <div className="flex gap-1 mb-6 bg-gray-900 rounded-lg p-1 w-fit">
          {TABS.map(tab => (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                activeTab === tab.value
                  ? "bg-gray-700 text-white"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        {isLoading && (
          <div className="text-center text-gray-500 py-16">Loading…</div>
        )}
        {isError && (
          <div className="text-center text-red-400 py-16">Failed to load plans</div>
        )}
        {!isLoading && !isError && plans.length === 0 && (
          <div className="text-center text-gray-500 py-16">
            No {activeTab !== "all" ? activeTab : ""} plans yet.
          </div>
        )}
        {!isLoading && !isError && plans.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {plans.map(plan => (
              <PlanCard
                key={plan.id}
                plan={plan}
                onClick={() => navigate(`/plans/${plan.id}`)}
              />
            ))}
          </div>
        )}
      </div>

      {showModal && <NewPlanModal onClose={() => setShowModal(false)} />}
    </div>
  );
}
