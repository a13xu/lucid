// ============================================================
// Lucid Web UI — vanilla JS hash router
// ============================================================

const app = document.getElementById("app");
const overlay = document.getElementById("modal-overlay");

// ---- API helpers ----

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch("/api" + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const GET    = (p)    => api("GET",    p);
const POST   = (p, b) => api("POST",   p, b);
const PUT    = (p, b) => api("PUT",    p, b);
const PATCH  = (p, b) => api("PATCH",  p, b);
const DELETE = (p)    => api("DELETE", p);

// ---- SSE state ----

let _sseConnection          = null;
let _orchestratorInstances  = [];
let _sseReconnectAttempt    = 0;
let _workerStatus           = { running: false, busy: false, currentTaskId: null };
let _taskOutputs            = {}; // taskId → accumulated output string
let _consolePrompt          = "";  // last prompt sent to Claude
let _consoleOutput          = "";  // accumulated streaming output for console panel

const TASKS_PAGE_SIZE = 10;
let _planTaskPages    = {};        // planId → current task page number

function relTime(unixTs) {
  if (!unixTs) return "never";
  const secs = Math.floor(Date.now() / 1000) - unixTs;
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function updateSseStatusDot(state) {
  const dot = document.getElementById("sse-dot");
  if (dot) dot.className = `sse-dot sse-${state}`;
}

function connectSSE() {
  if (_sseConnection && _sseConnection.readyState !== EventSource.CLOSED) return;
  updateSseStatusDot("disconnected");
  const es = new EventSource("/api/events");
  _sseConnection = es;

  es.addEventListener("orchestrator", (e) => {
    _sseReconnectAttempt = 0;
    updateSseStatusDot("connected");
    _orchestratorInstances = JSON.parse(e.data).instances || [];
    const content = document.getElementById("orchestrator-content");
    if (content) renderOrchestratorContent(_orchestratorInstances);
  });

  es.addEventListener("worker", (e) => {
    _workerStatus = JSON.parse(e.data);
    const panel = document.getElementById("worker-status-panel");
    if (panel) renderWorkerPanelContent(panel, _workerStatus);
    _renderConsolePanel();
    // HAL eye pulses when worker is busy
    document.querySelector(".hal-eye")?.classList.toggle("hal-active", !!_workerStatus.busy);
  });

  es.addEventListener("worker_permission_request", (e) => {
    const { taskId, request } = JSON.parse(e.data);
    _showPermissionCard(taskId, request);
  });

  es.addEventListener("worker_approval", (e) => {
    const { taskId, decision } = JSON.parse(e.data);
    const card = document.getElementById(`perm-card-${taskId}`);
    if (card) {
      card.innerHTML = `<span style="color:${decision === 'approved' ? 'var(--green)' : 'var(--red)'}">${decision === 'approved' ? '✅ Approved — retrying task...' : '🚫 Denied'}</span>`;
      setTimeout(() => card.remove(), 3000);
    }
  });

  es.addEventListener("task_prompt", (e) => {
    const { prompt } = JSON.parse(e.data);
    _consolePrompt = prompt;
    _consoleOutput = "";
    _renderConsolePanel();
  });

  es.addEventListener("e2e_run_start", (e) => {
    const { testId, runId, testName } = JSON.parse(e.data);
    const el = document.getElementById(`e2e-status-${testId}`);
    if (el) { el.className = "badge badge-in_progress"; el.textContent = "running"; }
  });

  es.addEventListener("e2e_run_done", (e) => {
    const { testId, runId, status } = JSON.parse(e.data);
    const el = document.getElementById(`e2e-status-${testId}`);
    if (el) { el.className = `badge badge-${status === "pass" ? "pass" : "fail"}`; el.textContent = status; }
    // Refresh detail if open
    const m = location.hash.match(/^#\/e2e\/(\d+)$/);
    if (m && Number(m[1]) === testId) renderE2EDetail(testId);
  });

  es.addEventListener("task_output", (e) => {
    const { taskId, chunk, done } = JSON.parse(e.data);
    _taskOutputs[taskId] = (_taskOutputs[taskId] || "") + chunk;

    // Feed the global console panel
    _consoleOutput += chunk;
    _appendConsoleChunk(chunk, done);

    // Feed inline task output box (plan detail page)
    const el = document.getElementById(`task-output-${taskId}`);
    if (el) {
      el.textContent = _taskOutputs[taskId];
      el.scrollTop   = el.scrollHeight;
    }

    if (done) {
      const m = location.hash.match(/^#\/plans\/(\d+)$/);
      if (m) GET(`/plans/${m[1]}`).then(renderPlanContent).catch(() => {});
    }
  });

  es.onerror = () => {
    updateSseStatusDot("disconnected");
    es.close();
    _sseConnection = null;
    const delay = Math.min(3000 * Math.pow(2, _sseReconnectAttempt), 30000);
    _sseReconnectAttempt++;
    setTimeout(connectSSE, delay);
  };
}

// ---- Router ----

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", () => {
  connectSSE();
  route();
});

function route() {
  const hash = location.hash.slice(1) || "/";

  // Tear down terminal when navigating away from it
  if (hash !== "/terminal") {
    window.removeEventListener("resize", _onWindowResizeTerminal);
    _disposeTerminal();
  }

  let m;
  if (hash === "/" || hash === "") {
    renderOrchestratorPage();
  } else if (hash === "/plans") {
    renderPlansPage();
  } else if ((m = hash.match(/^\/plans\/(\d+)\/tasks\/(\d+)\/tests/))) {
    renderTestRunner(Number(m[1]), Number(m[2]));
  } else if ((m = hash.match(/^\/plans\/(\d+)/))) {
    renderPlanDetail(Number(m[1]));
  } else if (hash === "/e2e") {
    renderE2EPage();
  } else if ((m = hash.match(/^\/e2e\/(\d+)/))) {
    renderE2EDetail(Number(m[1]));
  } else if (hash === "/chat") {
    renderChatPage();
  } else if (hash === "/terminal") {
    renderTerminalPage();
  } else {
    renderOrchestratorPage();
  }
}

function navigate(path) {
  location.hash = path;
}

// ---- Utilities ----

function loading() {
  return `<div class="loading"><div class="spinner"></div></div>`;
}

function badge(status) {
  return `<span class="badge badge-${status}">${status.replace("_", " ")}</span>`;
}

function methodBadge(m) {
  return `<span class="method method-${m}">${m}</span>`;
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ---- Pagination ----

/**
 * Renders Prev / [1][2][3] / Next pagination buttons.
 * @param {number} currentPage  - 1-based current page
 * @param {number} totalPages   - total number of pages
 * @param {function} onPageChange - called with the new page number on click
 * @returns {HTMLElement} a <div class="pagination"> element
 */
function renderPagination(currentPage, totalPages, onPageChange) {
  const container = document.createElement("div");
  container.className = "pagination";

  if (totalPages <= 1) return container;

  function makeBtn(label, page, disabled, active) {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost pagination-btn" + (active ? " pagination-btn-active" : "");
    btn.textContent = label;
    btn.disabled = disabled;
    if (!disabled) {
      btn.addEventListener("click", () => onPageChange(page));
    }
    return btn;
  }

  container.appendChild(makeBtn("Prev", currentPage - 1, currentPage === 1, false));

  for (let p = 1; p <= totalPages; p++) {
    container.appendChild(makeBtn(String(p), p, false, p === currentPage));
  }

  container.appendChild(makeBtn("Next", currentPage + 1, currentPage === totalPages, false));

  return container;
}

function showError(msg) {
  app.innerHTML = `<div class="empty"><h3>Error</h3><p>${escHtml(msg)}</p><a href="#/plans" class="btn btn-ghost">Back to Plans</a></div>`;
}

// ---- Modal helpers ----

function openModal(html, onReady) {
  overlay.innerHTML = `<div class="modal">${html}</div>`;
  overlay.classList.remove("hidden");
  if (onReady) onReady(overlay.querySelector(".modal"));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  }, { once: true });
}

function closeModal() {
  overlay.classList.add("hidden");
  overlay.innerHTML = "";
}

// ============================================================
// Plans Page
// ============================================================

async function renderPlansPage(activeTab, page) {
  const tab = activeTab || "active";
  const currentPage = page || 1;
  const limit = 20;

  app.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Plans</div>
        <div class="page-subtitle">Track implementation plans and tasks</div>
      </div>
      <button class="btn btn-primary" id="btn-new-plan">+ New Plan</button>
    </div>
    <div class="tabs">
      <button class="tab ${tab === "active" ? "active" : ""}" data-tab="active">Active</button>
      <button class="tab ${tab === "completed" ? "active" : ""}" data-tab="completed">Completed</button>
      <button class="tab ${tab === "abandoned" ? "active" : ""}" data-tab="abandoned">Abandoned</button>
      <button class="tab ${tab === "all" ? "active" : ""}" data-tab="all">All</button>
    </div>
    <div id="plans-list">${loading()}</div>
    <div id="plans-pagination"></div>
  `;

  document.getElementById("btn-new-plan").addEventListener("click", () => showNewPlanModal(tab));

  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => renderPlansPage(btn.dataset.tab, 1));
  });

  try {
    const result = await GET(`/plans?status=${tab}&page=${currentPage}&limit=${limit}`);
    renderPlanCards(result.data);
    const paginationEl = document.getElementById("plans-pagination");
    if (result.totalPages > 1) {
      paginationEl.appendChild(
        renderPagination(currentPage, result.totalPages, (p) => renderPlansPage(tab, p))
      );
    }
  } catch (err) {
    document.getElementById("plans-list").innerHTML = `<div class="empty"><p>${escHtml(err.message)}</p></div>`;
  }
}

function renderPlanCards(plans) {
  const container = document.getElementById("plans-list");
  if (!plans.length) {
    container.innerHTML = `<div class="empty"><h3>No plans here</h3><p>Create a new plan to get started.</p></div>`;
    return;
  }
  container.innerHTML = plans.map(p => {
    const pct = p.task_count ? Math.round((p.tasks_done / p.task_count) * 100) : 0;
    const e2eIconMap = { pass: "✅", fail: "❌" };
    const e2eBadge = p.e2e_task_id && p.e2e_result
      ? `<span class="e2e-card-badge e2e-card-${p.e2e_result}" title="E2E: ${p.e2e_result} (${p.e2e_retry_count ?? 0} retries)">${e2eIconMap[p.e2e_result] ?? "⏳"} E2E</span>`
      : (p.e2e_task_id ? `<span class="e2e-card-badge e2e-card-pending" title="E2E pending">⏳ E2E</span>` : "");
    return `
      <div class="card" data-plan-id="${p.id}">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
          <div class="card-title">${escHtml(p.title)}</div>
          <div style="display:flex;gap:6px;align-items:center">${e2eBadge}${badge(p.status)}</div>
        </div>
        <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="card-meta">
          <span>${p.tasks_done}/${p.task_count} tasks done</span>
          <span>Created ${fmtDate(p.created_at)}</span>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".card").forEach(card => {
    card.addEventListener("click", () => navigate(`/plans/${card.dataset.planId}`));
  });
}

function showNewPlanModal(returnTab) {
  // _generatedTasks holds full task objects (with description + test_criteria)
  // when AI generation was used; null means plain text mode.
  let _generatedTasks = null;

  openModal(`
    <div class="modal-title">New Plan</div>
    <div class="form-group">
      <label class="form-label">Title *</label>
      <input class="form-input" id="m-title" placeholder="Plan title" />
    </div>
    <div class="form-group">
      <label class="form-label">Description *</label>
      <textarea class="form-textarea" id="m-desc" placeholder="What is this plan about?"></textarea>
    </div>
    <div class="form-group">
      <label class="form-label" style="display:flex;align-items:center;justify-content:space-between">
        <span>User Story *</span>
        <button class="btn btn-ghost btn-sm" id="m-generate" type="button" style="font-size:11px">✨ Generate Tasks with AI</button>
      </label>
      <textarea class="form-textarea" id="m-story" placeholder="As a user, I want to..."></textarea>
    </div>
    <div class="form-group" id="m-tasks-group">
      <label class="form-label" style="display:flex;align-items:center;justify-content:space-between">
        <span>Tasks (one per line) *</span>
        <span id="m-tasks-hint" style="font-size:11px;color:var(--text3)"></span>
      </label>
      <textarea class="form-textarea" id="m-tasks" style="min-height:100px" placeholder="Task 1&#10;Task 2&#10;Task 3"></textarea>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-submit">Create Plan</button>
    </div>
  `, (modal) => {
    modal.querySelector("#m-cancel").addEventListener("click", closeModal);

    // AI generate button
    modal.querySelector("#m-generate").addEventListener("click", async () => {
      const user_story = modal.querySelector("#m-story").value.trim();
      const title      = modal.querySelector("#m-title").value.trim();
      if (!user_story) { alert("Enter a user story first."); return; }

      const btn = modal.querySelector("#m-generate");
      btn.disabled    = true;
      btn.textContent = "⏳ Generating…";

      try {
        const { tasks } = await POST("/generate/tasks", { user_story, title });
        _generatedTasks = tasks;

        // Populate the tasks textarea with just the titles (visual preview)
        modal.querySelector("#m-tasks").value = tasks.map(t => t.title).join("\n");
        const hint = modal.querySelector("#m-tasks-hint");
        hint.textContent   = `✨ ${tasks.length} tasks generated — titles shown, full detail saved`;
        hint.style.color   = "var(--green, #4ade80)";
      } catch (err) {
        alert("AI generation failed: " + err.message);
        _generatedTasks = null;
      } finally {
        btn.disabled    = false;
        btn.textContent = "✨ Generate Tasks with AI";
      }
    });

    modal.querySelector("#m-submit").addEventListener("click", async () => {
      const title      = modal.querySelector("#m-title").value.trim();
      const description= modal.querySelector("#m-desc").value.trim();
      const user_story = modal.querySelector("#m-story").value.trim();

      if (!title || !description || !user_story) {
        alert("Title, description and user story are required.");
        return;
      }

      let tasks;
      if (_generatedTasks && _generatedTasks.length > 0) {
        // Use rich AI-generated tasks
        tasks = _generatedTasks;
      } else {
        const taskLines = modal.querySelector("#m-tasks").value.trim().split("\n").filter(Boolean);
        if (!taskLines.length) { alert("Add at least one task."); return; }
        tasks = taskLines.map(line => ({ title: line.trim(), description: "", test_criteria: "" }));
      }

      try {
        const plan = await POST("/plans", { title, description, user_story, tasks });
        closeModal();
        navigate(`/plans/${plan.id}`);
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

// ============================================================
// Plan Detail Page
// ============================================================

async function renderPlanDetail(planId) {
  app.innerHTML = `
    <a href="#/plans" class="back-link">← Back to Plans</a>
    <div id="plan-content">${loading()}</div>
  `;

  try {
    const plan = await GET(`/plans/${planId}`);
    renderPlanContent(plan);
  } catch (err) {
    showError(err.message);
  }
}

function renderE2ePanel(plan) {
  const e2e = plan.e2e;
  if (!e2e) return "";

  const iconMap = { pass: "✅", fail: "❌", pending: "⏳" };
  const colorMap = { pass: "var(--green)", fail: "var(--red)", pending: "var(--yellow)" };
  const icon  = iconMap[e2e.status] ?? "⏳";
  const color = colorMap[e2e.status] ?? "var(--text2)";
  const canRerun = e2e.status === "fail" || e2e.status === "pending";

  return `
    <div class="e2e-panel" style="border-color:${color}">
      <div class="e2e-panel-header">
        <span style="font-weight:600;color:${color}">${icon} E2E Status</span>
        <span class="e2e-retry-badge">Iteration ${e2e.retry_count}/${e2e.max_retries}</span>
        ${canRerun ? `<button class="btn btn-ghost btn-sm" id="btn-rerun-e2e" style="margin-left:auto">Re-run E2E</button>` : ""}
      </div>
      ${e2e.last_error ? `<pre class="e2e-error">${escHtml(e2e.last_error)}</pre>` : ""}
    </div>
  `;
}

function renderPlanContent(plan) {
  const pct = plan.task_count ? Math.round((plan.tasks_done / plan.task_count) * 100) : 0;

  document.getElementById("plan-content").innerHTML = `
    <div class="page-header">
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
          <div class="page-title">${escHtml(plan.title)}</div>
          ${badge(plan.status)}
        </div>
        <div class="page-subtitle">${escHtml(plan.user_story)}</div>
      </div>
      <div style="display:flex;gap:8px">
        ${plan.status === "active" ? `<button class="btn btn-ghost btn-sm" id="btn-abandon">Abandon</button>` : ""}
        ${plan.status !== "active" ? `<button class="btn btn-ghost btn-sm" id="btn-reactivate">Reactivate</button>` : ""}
        <button class="btn btn-danger btn-sm" id="btn-delete-plan">Delete</button>
      </div>
    </div>

    <div style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:12px;color:var(--text2)">${plan.tasks_done}/${plan.task_count} tasks done</span>
        <span style="font-size:12px;color:var(--text2)">${pct}%</span>
      </div>
      <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>

    <div style="color:var(--text2);font-size:13px;margin-bottom:20px">${escHtml(plan.description)}</div>

    ${renderE2ePanel(plan)}

    <div id="tasks-list"></div>
    <div id="tasks-pagination"></div>
  `;

  loadPlanTasksPage(plan.id, _planTaskPages[plan.id] || 1);

  // Plan actions
  const btnAbandon = document.getElementById("btn-abandon");
  if (btnAbandon) {
    btnAbandon.addEventListener("click", async () => {
      if (!confirm("Abandon this plan?")) return;
      try {
        await PATCH(`/plans/${plan.id}`, { status: "abandoned" });
        const updated = await GET(`/plans/${plan.id}`);
        renderPlanContent(updated);
      } catch (err) { alert(err.message); }
    });
  }

  const btnReactivate = document.getElementById("btn-reactivate");
  if (btnReactivate) {
    btnReactivate.addEventListener("click", async () => {
      try {
        await PATCH(`/plans/${plan.id}`, { status: "active" });
        const updated = await GET(`/plans/${plan.id}`);
        renderPlanContent(updated);
      } catch (err) { alert(err.message); }
    });
  }

  document.getElementById("btn-delete-plan").addEventListener("click", async () => {
    if (!confirm(`Delete plan "${plan.title}"? This cannot be undone.`)) return;
    try {
      await DELETE(`/plans/${plan.id}`);
      navigate("/plans");
    } catch (err) { alert(err.message); }
  });

  // Re-run E2E button
  const btnRerunE2e = document.getElementById("btn-rerun-e2e");
  if (btnRerunE2e) {
    btnRerunE2e.addEventListener("click", async () => {
      btnRerunE2e.disabled = true;
      btnRerunE2e.textContent = "Resetting…";
      try {
        await POST(`/plans/${plan.id}/e2e/rerun`);
        const updated = await GET(`/plans/${plan.id}`);
        renderPlanContent(updated);
      } catch (err) {
        alert("Re-run failed: " + err.message);
        btnRerunE2e.disabled = false;
        btnRerunE2e.textContent = "Re-run E2E";
      }
    });
  }
}

async function loadPlanTasksPage(planId, page) {
  const container = document.getElementById("tasks-list");
  if (!container) return;
  container.innerHTML = loading();

  try {
    const result = await GET(`/plans/${planId}/tasks?page=${page}&limit=${TASKS_PAGE_SIZE}`);
    _planTaskPages[planId] = page;

    if (!result.data.length) {
      container.innerHTML = `<div class="empty"><p>No tasks yet.</p></div>`;
    } else {
      container.innerHTML = result.data.map(t => renderTaskHtml(planId, t)).join("");
    }

    const paginationEl = document.getElementById("tasks-pagination");
    if (paginationEl) {
      paginationEl.innerHTML = "";
      if (result.totalPages > 1) {
        paginationEl.appendChild(
          renderPagination(page, result.totalPages, (p) => loadPlanTasksPage(planId, p))
        );
      }
    }

    bindTaskEventHandlers(planId);
  } catch (err) {
    if (container) container.innerHTML = `<div class="empty"><p>${escHtml(err.message)}</p></div>`;
  }
}

function bindTaskEventHandlers(planId) {
  // Expand/collapse tasks
  document.querySelectorAll(".task-header").forEach(header => {
    header.addEventListener("click", () => {
      const body = header.nextElementSibling;
      const isOpen = body.style.display !== "none";
      body.style.display = isOpen ? "none" : "block";
    });
  });

  // Status change buttons
  document.querySelectorAll(".btn-task-status").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const taskId = Number(btn.dataset.taskId);
      const status = btn.dataset.status;
      let note = null;
      if (status === "done" || status === "blocked") {
        note = prompt(`Add a note for this status change (optional):`);
      }
      try {
        await PATCH(`/tasks/${taskId}`, { status, note: note || undefined });
        const plan = await GET(`/plans/${planId}`);
        renderPlanContent(plan);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  // Generate E2E tests for a task
  document.querySelectorAll(".btn-gen-e2e").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      btn.disabled = true; btn.textContent = "⏳ Generating…";
      try {
        const { tests } = await POST(`/e2e/generate/${btn.dataset.taskId}`);
        alert(`✅ Generated ${tests.length} E2E test${tests.length !== 1 ? "s" : ""}. View them in E2E Tests tab.`);
      } catch (err) { alert("E2E generation failed: " + err.message); }
      finally { btn.textContent = "🎭 Gen E2E"; btn.disabled = false; }
    });
  });

  // Reset task → pending
  document.querySelectorAll(".btn-task-reset").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const taskId = Number(btn.dataset.taskId);
      try {
        await POST(`/tasks/${taskId}/reset`);
        _taskOutputs[taskId] = "";
        const plan = await GET(`/plans/${planId}`);
        renderPlanContent(plan);
      } catch (err) { alert(err.message); }
    });
  });

  // Open test runner
  document.querySelectorAll(".btn-open-tests").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigate(`/plans/${btn.dataset.planId}/tasks/${btn.dataset.taskId}/tests`);
    });
  });
}

function renderTaskHtml(planId, task) {
  const statusActions = {
    pending:     ["in_progress", "blocked"],
    in_progress: ["done", "blocked"],
    blocked:     ["in_progress"],
    done:        [],
  };
  const actions = statusActions[task.status] || [];

  const notes = Array.isArray(task.notes) ? task.notes : [];
  const cachedOutput = _taskOutputs[task.id] || "";
  const isWorkerActive = _workerStatus.currentTaskId === task.id;

  const isFixTask = task.title.startsWith("[FIX]");
  const isE2eTask = !!task.is_e2e;

  return `
    <div class="task-item${isFixTask ? " task-fix" : ""}${isE2eTask ? " task-e2e" : ""}">
      <div class="task-header">
        <span class="task-seq">#${task.seq}</span>
        <span class="task-title">${escHtml(task.title)}</span>
        ${task.test_count !== undefined ? `<span class="task-test-count">${task.test_count} test${task.test_count !== 1 ? "s" : ""}</span>` : ""}
        ${badge(task.status)}
        ${isWorkerActive ? `<span class="badge badge-in_progress" style="animation:pulse 1s infinite">🤖 running</span>` : ""}
      </div>
      <div class="task-body" style="display:${task.status === "in_progress" ? "block" : "none"}">
        ${task.description ? `<div class="task-desc">${escHtml(task.description)}</div>` : ""}
        ${task.test_criteria ? `<div class="task-criteria">Criteria: ${escHtml(task.test_criteria)}</div>` : ""}

        ${notes.length ? `<div style="margin:8px 0">${notes.map(n => `<div class="note-item"><div style="white-space:pre-wrap">${escHtml(n.text)}</div><div class="note-ts">${fmtDate(n.ts)}</div></div>`).join("")}</div>` : ""}

        ${cachedOutput || isWorkerActive ? `
          <div style="margin:8px 0">
            <div class="form-label" style="margin-bottom:4px">Live Output</div>
            <pre id="task-output-${task.id}" style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:8px;font-size:11px;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-all">${escHtml(cachedOutput)}</pre>
          </div>
        ` : ""}

        <div class="task-actions">
          ${actions.map(s => `<button class="btn btn-ghost btn-sm btn-task-status" data-task-id="${task.id}" data-plan-id="${planId}" data-status="${s}">Mark ${s.replace("_", " ")}</button>`).join("")}
          ${task.status !== "done" ? `<button class="btn btn-ghost btn-sm btn-task-reset" data-task-id="${task.id}" data-plan-id="${planId}" title="Reset to pending so worker picks it up">↺ Reset</button>` : ""}
          <button class="btn btn-ghost btn-sm btn-open-tests" data-task-id="${task.id}" data-plan-id="${planId}">Tests (${task.test_count ?? 0})</button>
          <button class="btn btn-ghost btn-sm btn-gen-e2e" data-task-id="${task.id}" title="Generate Playwright E2E tests for this task">🎭 Gen E2E</button>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// Test Runner Page
// ============================================================

let _selectedTestId = null;

async function renderTestRunner(planId, taskId) {
  app.innerHTML = `
    <a href="#/plans/${planId}" class="back-link">← Back to Plan</a>
    <div id="runner-content">${loading()}</div>
  `;

  try {
    const task = await GET(`/tasks/${taskId}`);
    renderRunnerContent(planId, taskId, task);
  } catch (err) {
    showError(err.message);
  }
}

function renderRunnerContent(planId, taskId, task) {
  document.getElementById("runner-content").innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${escHtml(task.title)}</div>
        <div class="page-subtitle">Test Runner &mdash; ${badge(task.status)}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" id="btn-run-all">Run All</button>
        <button class="btn btn-primary btn-sm" id="btn-new-test">+ New Test</button>
      </div>
    </div>
    <div class="runner-layout">
      <div>
        <div id="test-list" class="test-list">${renderTestListHtml(task.tests || [])}</div>
      </div>
      <div id="result-panel" class="result-panel">
        <div class="result-empty">Select a test to view details or run it.</div>
      </div>
    </div>
  `;

  attachTestListEvents(planId, taskId);

  document.getElementById("btn-new-test").addEventListener("click", () => showTestModal(planId, taskId, null));

  document.getElementById("btn-run-all").addEventListener("click", async () => {
    const btn = document.getElementById("btn-run-all");
    btn.disabled = true;
    btn.textContent = "Running…";
    try {
      await POST(`/tasks/${taskId}/tests/run-all`);
      const task = await GET(`/tasks/${taskId}`);
      renderRunnerContent(planId, taskId, task);
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
      btn.textContent = "Run All";
    }
  });
}

function renderTestListHtml(tests) {
  if (!tests.length) {
    return `<div class="empty"><p>No tests yet.</p></div>`;
  }
  return tests.map(t => `
    <div class="test-item ${_selectedTestId === t.id ? "selected" : ""}" data-test-id="${t.id}">
      <div class="test-item-name">${escHtml(t.name)}</div>
      <div class="test-item-meta">
        ${methodBadge(t.method)}
        <span style="color:var(--text3);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px">${escHtml(t.url)}</span>
        ${t.last_run_status ? badge(t.last_run_status) : ""}
      </div>
    </div>
  `).join("");
}

function attachTestListEvents(planId, taskId) {
  document.querySelectorAll(".test-item").forEach(item => {
    item.addEventListener("click", async () => {
      _selectedTestId = Number(item.dataset.testId);
      document.querySelectorAll(".test-item").forEach(i => i.classList.remove("selected"));
      item.classList.add("selected");
      await loadTestDetail(planId, taskId, _selectedTestId);
    });
  });
}

async function loadTestDetail(planId, taskId, testId) {
  const panel = document.getElementById("result-panel");
  panel.innerHTML = loading();

  try {
    const [tests, runs] = await Promise.all([
      GET(`/tasks/${taskId}/tests`),
      GET(`/tests/${testId}/runs`),
    ]);
    const test = tests.find(t => t.id === testId);
    if (!test) { panel.innerHTML = `<div class="result-empty">Test not found.</div>`; return; }

    panel.innerHTML = renderTestDetailHtml(test, runs, planId, taskId);
    attachTestDetailEvents(planId, taskId, testId, test);
  } catch (err) {
    panel.innerHTML = `<div class="result-empty">${escHtml(err.message)}</div>`;
  }
}

function renderTestDetailHtml(test, runs, planId, taskId) {
  const lastRun = runs[0];
  return `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
      <div>
        <div style="font-size:15px;font-weight:600;margin-bottom:4px">${escHtml(test.name)}</div>
        <div style="display:flex;align-items:center;gap:8px">
          ${methodBadge(test.method)}
          <span style="color:var(--text2);font-size:12px;word-break:break-all">${escHtml(test.url)}</span>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-ghost btn-sm" id="btn-edit-test">Edit</button>
        <button class="btn btn-danger btn-sm" id="btn-delete-test">Delete</button>
        <button class="btn btn-primary btn-sm" id="btn-run-test">Run</button>
      </div>
    </div>

    ${test.assertions && test.assertions.length ? `
      <div style="margin-bottom:16px">
        <div class="form-label" style="margin-bottom:8px">Assertions</div>
        ${test.assertions.map(a => `
          <div style="font-size:12px;color:var(--text2);padding:3px 0">
            ${escHtml(a.type)}: ${escHtml(JSON.stringify(a).replace(/^.*?,(.*)\}$/, "$1").replace(/[{}]/g, ""))}
          </div>
        `).join("")}
      </div>
    ` : ""}

    <div id="run-result">
      ${lastRun ? renderRunResult(lastRun) : `<div class="result-empty">No runs yet. Click Run to execute.</div>`}
    </div>

    ${runs.length > 1 ? `
      <div style="margin-top:16px">
        <div class="form-label" style="margin-bottom:8px">Recent Runs</div>
        ${runs.slice(1, 5).map(r => `
          <div style="display:flex;gap:10px;align-items:center;font-size:12px;color:var(--text2);padding:3px 0">
            ${badge(r.status)}
            <span>${r.status_code ? `HTTP ${r.status_code}` : ""}</span>
            <span>${r.duration_ms}ms</span>
            <span>${fmtDate(r.run_at)}</span>
          </div>
        `).join("")}
      </div>
    ` : ""}
  `;
}

function renderRunResult(run) {
  const asserts = Array.isArray(run.assertions_result) ? run.assertions_result : [];
  let bodyText = run.response_body ?? "";
  try { bodyText = JSON.stringify(JSON.parse(bodyText), null, 2); } catch { /* keep as-is */ }

  return `
    <div class="response-meta">
      ${badge(run.status)}
      ${run.status_code ? `<span>HTTP <strong>${run.status_code}</strong></span>` : ""}
      ${run.duration_ms != null ? `<span><strong>${run.duration_ms}</strong>ms</span>` : ""}
      ${run.error_message ? `<span style="color:var(--red)">${escHtml(run.error_message)}</span>` : ""}
    </div>

    ${asserts.length ? `
      <div style="margin-bottom:12px">
        ${asserts.map(a => `
          <div class="assertion-result ${a.pass ? "assertion-pass" : "assertion-fail"}">
            <span class="assertion-icon">${a.pass ? "✓" : "✗"}</span>
            <span class="assertion-text">
              <strong>${escHtml(a.type)}</strong>
              — expected: ${escHtml(JSON.stringify(a.expected))}
              ${!a.pass ? `, got: ${escHtml(JSON.stringify(a.actual))}` : ""}
            </span>
          </div>
        `).join("")}
      </div>
    ` : ""}

    ${run.response_body != null ? `<pre class="response-body">${escHtml(bodyText)}</pre>` : ""}
  `;
}

function attachTestDetailEvents(planId, taskId, testId, test) {
  document.getElementById("btn-run-test").addEventListener("click", async () => {
    const btn = document.getElementById("btn-run-test");
    btn.disabled = true;
    btn.textContent = "Running…";
    try {
      const run = await POST(`/tests/${testId}/run`);
      document.getElementById("run-result").innerHTML = renderRunResult(run);
      // Refresh test list to update last_run_status badge
      const taskData = await GET(`/tasks/${taskId}`);
      document.getElementById("test-list").innerHTML = renderTestListHtml(taskData.tests || []);
      attachTestListEvents(planId, taskId);
      document.querySelectorAll(".test-item").forEach(i => {
        if (Number(i.dataset.testId) === testId) i.classList.add("selected");
      });
    } catch (err) {
      alert(err.message);
    } finally {
      const b = document.getElementById("btn-run-test");
      if (b) { b.disabled = false; b.textContent = "Run"; }
    }
  });

  document.getElementById("btn-edit-test").addEventListener("click", () => {
    showTestModal(planId, taskId, test);
  });

  document.getElementById("btn-delete-test").addEventListener("click", async () => {
    if (!confirm(`Delete test "${test.name}"?`)) return;
    try {
      await DELETE(`/tests/${testId}`);
      _selectedTestId = null;
      const taskData = await GET(`/tasks/${taskId}`);
      renderRunnerContent(planId, taskId, taskData);
    } catch (err) {
      alert(err.message);
    }
  });
}

// ---- Test editor modal ----

function assertionRowHtml(a, idx) {
  const types = ["status", "body_key_exists", "body_json_path", "body_contains"];
  const typeOpts = types.map(t => `<option value="${t}" ${a.type === t ? "selected" : ""}>${t}</option>`).join("");
  const val = a.type === "status" ? a.expected
    : a.type === "body_key_exists" ? a.key
    : a.type === "body_json_path" ? `${a.path}=${JSON.stringify(a.expected)}`
    : a.value ?? "";
  return `
    <div class="assertion-row" data-assert-idx="${idx}">
      <select class="form-select assert-type">${typeOpts}</select>
      <input class="form-input assert-value" value="${escHtml(String(val))}" placeholder="value" />
      <button class="btn btn-danger btn-sm btn-rm-assert" type="button">×</button>
    </div>
  `;
}

function parseAssertionRow(row) {
  const type = row.querySelector(".assert-type").value;
  const val = row.querySelector(".assert-value").value.trim();
  switch (type) {
    case "status": return { type, expected: Number(val) };
    case "body_key_exists": return { type, key: val };
    case "body_json_path": {
      const eqIdx = val.indexOf("=");
      const path = eqIdx > -1 ? val.slice(0, eqIdx) : val;
      let expected;
      try { expected = JSON.parse(val.slice(eqIdx + 1)); } catch { expected = val.slice(eqIdx + 1); }
      return { type, path, expected };
    }
    case "body_contains": return { type, value: val };
    default: return { type, value: val };
  }
}

function showTestModal(planId, taskId, existing) {
  const isEdit = !!existing;
  const asserts = existing?.assertions ?? [];

  openModal(`
    <div class="modal-title">${isEdit ? "Edit Test" : "New Test"}</div>
    <div class="form-row">
      <div class="form-group" style="flex:2">
        <label class="form-label">Name *</label>
        <input class="form-input" id="m-name" value="${escHtml(existing?.name ?? "")}" placeholder="Test name" />
      </div>
      <div class="form-group" style="flex:1">
        <label class="form-label">Method</label>
        <select class="form-select" id="m-method">
          ${["GET","POST","PUT","PATCH","DELETE"].map(m => `<option ${(existing?.method ?? "GET") === m ? "selected" : ""}>${m}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">URL *</label>
      <input class="form-input" id="m-url" value="${escHtml(existing?.url ?? "")}" placeholder="http://localhost:3000/api/..." />
    </div>
    <div class="form-group">
      <label class="form-label">Headers (JSON)</label>
      <textarea class="form-textarea" id="m-headers" style="min-height:50px">${escHtml(JSON.stringify(existing?.headers ?? {}, null, 2))}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Body (JSON, for POST/PUT/PATCH)</label>
      <textarea class="form-textarea" id="m-body" style="min-height:50px">${escHtml(existing?.body ?? "")}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Assertions</label>
      <div id="m-asserts">${asserts.map((a, i) => assertionRowHtml(a, i)).join("")}</div>
      <button class="btn btn-ghost btn-sm" id="m-add-assert" type="button" style="margin-top:6px">+ Add Assertion</button>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-submit">${isEdit ? "Save" : "Create"}</button>
    </div>
  `, (modal) => {
    modal.querySelector("#m-cancel").addEventListener("click", closeModal);

    modal.querySelector("#m-add-assert").addEventListener("click", () => {
      const container = modal.querySelector("#m-asserts");
      const idx = container.querySelectorAll(".assertion-row").length;
      const div = document.createElement("div");
      div.innerHTML = assertionRowHtml({ type: "status" }, idx);
      container.appendChild(div.firstElementChild);
      attachRemoveAssert(container);
    });

    attachRemoveAssert(modal.querySelector("#m-asserts"));

    modal.querySelector("#m-submit").addEventListener("click", async () => {
      const name = modal.querySelector("#m-name").value.trim();
      const method = modal.querySelector("#m-method").value;
      const url = modal.querySelector("#m-url").value.trim();
      let headers = {};
      let body = modal.querySelector("#m-body").value.trim() || null;
      try { headers = JSON.parse(modal.querySelector("#m-headers").value || "{}"); } catch { alert("Invalid headers JSON"); return; }

      if (!name || !url) { alert("Name and URL are required"); return; }

      const assertions = Array.from(modal.querySelectorAll(".assertion-row")).map(parseAssertionRow);

      try {
        if (isEdit) {
          await PUT(`/tests/${existing.id}`, { name, method, url, headers, body, assertions });
        } else {
          await POST(`/tasks/${taskId}/tests`, { name, method, url, headers, body, assertions });
        }
        closeModal();
        const taskData = await GET(`/tasks/${taskId}`);
        renderRunnerContent(planId, taskId, taskData);
        if (isEdit && _selectedTestId) {
          await loadTestDetail(planId, taskId, _selectedTestId);
        }
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

function attachRemoveAssert(container) {
  container.querySelectorAll(".btn-rm-assert").forEach(btn => {
    btn.onclick = () => btn.closest(".assertion-row").remove();
  });
}

// ============================================================
// Orchestrator Page
// ============================================================

function renderWorkerPanelContent(panel, status) {
  const stateLabel = !status.running ? "Stopped"
    : status.busy ? `Executing task #${status.currentTaskId}`
    : "Idle — polling for tasks";
  const stateClass = !status.running ? "badge-abandoned"
    : status.busy ? "badge-in_progress"
    : "badge-active";

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="font-weight:600;font-size:13px">Claude CLI Worker</span>
      <span class="badge ${stateClass}">${stateLabel}</span>
      ${status.running
        ? `<button class="btn btn-danger btn-sm" id="btn-worker-stop">Stop</button>`
        : `<button class="btn btn-primary btn-sm" id="btn-worker-start">Start</button>`}
      <button class="btn btn-ghost btn-sm" id="btn-worker-reset" title="Reset all in_progress tasks → pending">↺ Reset stuck</button>
      <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text3);cursor:pointer;margin-left:4px" title="Skip all permission requests automatically (--dangerously-skip-permissions)">
        <input type="checkbox" id="chk-auto-approve" ${status.autoApprove ? "checked" : ""} style="cursor:pointer" />
        Auto-approve
      </label>
    </div>
  `;

  const btnStart = panel.querySelector("#btn-worker-start");
  const btnStop  = panel.querySelector("#btn-worker-stop");
  const btnReset = panel.querySelector("#btn-worker-reset");

  if (btnStart) btnStart.addEventListener("click", async () => {
    btnStart.disabled = true;
    try { _workerStatus = await POST("/worker/start"); renderWorkerPanelContent(panel, _workerStatus); }
    catch (err) { alert(err.message); btnStart.disabled = false; }
  });
  if (btnStop) btnStop.addEventListener("click", async () => {
    btnStop.disabled = true;
    try { _workerStatus = await POST("/worker/stop"); renderWorkerPanelContent(panel, _workerStatus); }
    catch (err) { alert(err.message); btnStop.disabled = false; }
  });
  const chkAuto = panel.querySelector("#chk-auto-approve");
  if (chkAuto) chkAuto.addEventListener("change", async () => {
    try {
      _workerStatus = await POST("/worker/auto-approve", { enabled: chkAuto.checked });
    } catch (err) { alert(err.message); chkAuto.checked = !chkAuto.checked; }
  });

  if (btnReset) btnReset.addEventListener("click", async () => {
    btnReset.disabled = true;
    try {
      const { reset } = await POST("/worker/reset-stuck");
      btnReset.textContent = `↺ Reset (${reset} tasks)`;
      setTimeout(() => { btnReset.textContent = "↺ Reset stuck"; btnReset.disabled = false; }, 2000);
    } catch (err) { alert(err.message); btnReset.disabled = false; }
  });
}

// ── Permission request card ───────────────────────────────────────────────────

function _showPermissionCard(taskId, request) {
  // Make console visible first
  const consoleEl = document.getElementById("worker-console");
  if (consoleEl) consoleEl.style.display = "block";

  // Insert (or replace) a permission card inside the console body
  const bodyEl = document.getElementById("console-body");
  const existing = document.getElementById(`perm-card-${taskId}`);
  if (existing) existing.remove();

  const card = document.createElement("div");
  card.id = `perm-card-${taskId}`;
  card.className = "console-perm-card";
  card.innerHTML = `
    <div class="console-perm-icon">🔐</div>
    <div style="flex:1;min-width:0">
      <div class="console-perm-title">Permission Request — Task #${taskId}</div>
      <pre class="console-perm-body">${escHtml(request.slice(-600))}</pre>
    </div>
    <div class="console-perm-actions">
      <button class="btn btn-primary btn-sm perm-approve" data-task-id="${taskId}">✅ Approve & Retry</button>
      <button class="btn btn-danger btn-sm perm-deny" data-task-id="${taskId}">🚫 Deny</button>
    </div>
  `;

  (bodyEl || consoleEl)?.appendChild(card);
  if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;

  card.querySelector(".perm-approve").addEventListener("click", async () => {
    card.querySelector(".perm-approve").disabled = true;
    card.querySelector(".perm-deny").disabled    = true;
    await POST(`/worker/approve/${taskId}`).catch(err => alert(err.message));
  });
  card.querySelector(".perm-deny").addEventListener("click", async () => {
    card.querySelector(".perm-approve").disabled = true;
    card.querySelector(".perm-deny").disabled    = true;
    await POST(`/worker/deny/${taskId}`).catch(err => alert(err.message));
  });
}

// ── Worker Console (terminal chat) ───────────────────────────────────────────

function _renderConsolePanel() {
  const panel = document.getElementById("worker-console");
  if (!panel) return;

  if (!_consolePrompt) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "block";

  // Render prompt bubble if not already present
  if (!document.getElementById("console-prompt-bubble")) {
    panel.innerHTML = `
      <div class="console-header">
        <span class="console-dot"></span>
        <span class="console-dot"></span>
        <span class="console-dot"></span>
        <span style="margin-left:8px;font-size:11px;color:var(--text3)">Worker Console — Task #${_workerStatus.currentTaskId ?? "?"}</span>
        <button class="console-clear-btn" id="console-clear">✕</button>
      </div>
      <div class="console-body" id="console-body">
        <div class="console-msg console-user">
          <span class="console-label">▶ prompt</span>
          <pre class="console-pre">${escHtml(_consolePrompt)}</pre>
        </div>
        <div class="console-msg console-assistant">
          <span class="console-label">🤖 claude</span>
          <pre class="console-pre console-stream" id="console-prompt-bubble">${escHtml(_consoleOutput)}</pre>
        </div>
      </div>
    `;
    document.getElementById("console-clear")?.addEventListener("click", () => {
      _consolePrompt = ""; _consoleOutput = "";
      panel.style.display = "none";
    });
  }
}

function _appendConsoleChunk(chunk, done) {
  const el = document.getElementById("console-prompt-bubble");
  if (el) {
    el.textContent += chunk;
    el.parentElement.parentElement.scrollTop = el.parentElement.parentElement.scrollHeight;
    if (done) el.classList.remove("console-stream"); // remove cursor blink
  } else {
    _renderConsolePanel(); // panel not yet rendered — build it
  }
}

function renderOrchestratorPage() {
  app.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Orchestrator</div>
        <div class="page-subtitle">Active Claude Code instances — updates live via SSE</div>
      </div>
    </div>
    <div id="worker-status-panel" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:12px">
      <div class="loading"><div class="spinner"></div></div>
    </div>
    <div id="worker-console" class="worker-console" style="display:none;margin-bottom:20px"></div>
    <div id="orchestrator-content">
      <div class="loading"><div class="spinner"></div></div>
    </div>
  `;

  // Load initial worker status
  GET("/worker/status").then(s => {
    _workerStatus = s;
    const panel = document.getElementById("worker-status-panel");
    if (panel) renderWorkerPanelContent(panel, _workerStatus);
  }).catch(() => {
    const panel = document.getElementById("worker-status-panel");
    if (panel) panel.innerHTML = `<span style="color:var(--red);font-size:12px">Worker status unavailable</span>`;
  });

  // Render with whatever data is already in memory
  if (_orchestratorInstances.length > 0) {
    renderOrchestratorContent(_orchestratorInstances);
  }

  // Restore console panel if there's an active/previous session
  _renderConsolePanel();

  // Event delegation for expand/collapse action panels
  document.getElementById("orchestrator-content").addEventListener("click", async (e) => {
    const btn = e.target.closest(".btn-toggle-actions");
    if (!btn) return;
    const instanceId = btn.dataset.instanceId;
    const panel = document.getElementById(`actions-panel-${instanceId}`);
    if (!panel) return;
    const isOpen = panel.classList.contains("open");
    if (!isOpen) {
      panel.classList.add("open");
      btn.textContent = "Hide Actions ▲";
      await loadAndRenderActions(instanceId);
    } else {
      panel.classList.remove("open");
      btn.textContent = "Show Actions ▼";
    }
  });
}

function renderOrchestratorContent(instances) {
  const content = document.getElementById("orchestrator-content");
  if (!content) return;

  if (!instances || instances.length === 0) {
    content.innerHTML = `<div class="empty"><h3>No instances detected</h3><p>Start Claude Code with the Lucid MCP server to see active instances here.</p></div>`;
    return;
  }

  const active = instances.filter(i => i.status === "active").length;
  const stale  = instances.filter(i => i.status === "stale").length;
  const dead   = instances.filter(i => i.status === "dead").length;

  content.innerHTML = `
    <div class="orchestrator-summary">
      <span class="summary-stat"><span class="status-dot status-active"></span>${active} active</span>
      <span class="summary-stat"><span class="status-dot status-stale"></span>${stale} stale</span>
      <span class="summary-stat"><span class="status-dot status-dead"></span>${dead} dead</span>
    </div>
    ${instances.map(renderInstanceCard).join("")}
  `;
}

function renderInstanceCard(inst) {
  const shortId = inst.instance_id ? inst.instance_id.slice(0, 8) : "unknown";
  const pct = inst.task_count ? Math.round((inst.tasks_done / inst.task_count) * 100) : 0;
  const safeId = escHtml(inst.instance_id);

  return `
    <div class="instance-card status-${escHtml(inst.status)}">
      <div class="instance-header">
        <span class="instance-status-dot status-${escHtml(inst.status)}"></span>
        <span class="instance-label">Instance ${escHtml(shortId)}</span>
        <span class="instance-pid">PID ${escHtml(String(inst.pid))}</span>
        <span class="badge badge-${escHtml(inst.status)}">${escHtml(inst.status)}</span>
      </div>
      <div class="instance-meta">
        <span>Started ${relTime(inst.started_at)}</span>
        <span>·</span>
        <span>HB ${relTime(inst.last_heartbeat)}</span>
        ${inst.label ? `<span>·</span><span>${escHtml(inst.label)}</span>` : ""}
      </div>

      ${inst.plan_id ? `
        <div class="instance-plan">
          <div class="instance-plan-title">Active Plan: ${escHtml(inst.plan_title)}</div>
          <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
          <div class="instance-plan-meta">${inst.tasks_done}/${inst.task_count} tasks &nbsp; ${pct}%</div>
        </div>
      ` : `<div class="instance-no-plan">No active plan</div>`}

      ${inst.last_tool ? `
        <div class="action-row" style="margin:8px 0">
          <span style="color:var(--text3);font-size:11px">Last:</span>
          <span class="action-tool">${escHtml(inst.last_tool)}</span>
          <span class="action-time">${relTime(inst.last_action_at)}</span>
          <span class="${inst.last_result_ok ? "action-ok" : "action-fail"}">${inst.last_result_ok ? "✓" : "✗"}</span>
        </div>
      ` : ""}

      <button class="btn btn-ghost btn-sm btn-toggle-actions" data-instance-id="${safeId}">Show Actions ▼</button>
      <div id="actions-panel-${safeId}" class="instance-actions-panel"></div>
    </div>
  `;
}

async function loadAndRenderActions(instanceId) {
  const panel = document.getElementById(`actions-panel-${instanceId}`);
  if (!panel) return;
  panel.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const actions = await GET(`/instances/${encodeURIComponent(instanceId)}/actions`);
    if (!actions.length) {
      panel.innerHTML = `<div style="color:var(--text3);font-size:12px;padding:8px 0">No actions recorded yet.</div>`;
      return;
    }
    panel.innerHTML = actions.map(a => `
      <div class="action-row">
        <span class="action-tool">${escHtml(a.tool_name)}</span>
        <span class="action-time">${relTime(a.created_at)}</span>
        <span class="${a.result_ok ? "action-ok" : "action-fail"}">${a.result_ok ? "✓" : "✗"}</span>
        <span style="color:var(--text3);font-size:11px">${a.duration_ms}ms</span>
      </div>
    `).join("");
  } catch (err) {
    panel.innerHTML = `<div style="color:var(--red);font-size:12px;padding:8px 0">${escHtml(err.message)}</div>`;
  }
}

// ============================================================
// E2E Tests Page
// ============================================================

async function renderE2EPage() {
  app.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">E2E Tests</div>
        <div class="page-subtitle">Playwright tests — auto-generated from tasks, auto-run on file changes</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" id="btn-run-all-e2e">▶ Run All</button>
        <button class="btn btn-primary btn-sm" id="btn-new-e2e">+ New Test</button>
      </div>
    </div>
    <div id="e2e-list">${loading()}</div>
  `;

  document.getElementById("btn-new-e2e").addEventListener("click", () => showE2EModal(null));
  document.getElementById("btn-run-all-e2e").addEventListener("click", async () => {
    const btn = document.getElementById("btn-run-all-e2e");
    btn.disabled = true; btn.textContent = "Running…";
    try {
      const { queued } = await POST("/e2e/run-all");
      btn.textContent = `▶ Running ${queued}…`;
      setTimeout(() => { btn.textContent = "▶ Run All"; btn.disabled = false; }, 3000);
    } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = "▶ Run All"; }
  });

  try {
    const tests = await GET("/e2e/tests");
    renderE2EList(tests);
  } catch (err) {
    document.getElementById("e2e-list").innerHTML = `<div class="empty"><p>${escHtml(err.message)}</p></div>`;
  }
}

function renderE2EList(tests) {
  const container = document.getElementById("e2e-list");
  if (!tests.length) {
    container.innerHTML = `<div class="empty"><h3>No E2E tests yet</h3><p>Generate tests from a task or create one manually.</p></div>`;
    return;
  }
  container.innerHTML = tests.map(t => {
    const statusClass = !t.last_status ? "badge-pending"
      : t.last_status === "pass" ? "badge-pass"
      : "badge-fail";
    const tags = (() => { try { return JSON.parse(t.tags || "[]"); } catch { return []; } })();
    return `
      <div class="e2e-test-row" data-id="${t.id}">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
          <span id="e2e-status-${t.id}" class="badge ${statusClass}">${t.last_status || "never"}</span>
          <span class="e2e-test-name">${escHtml(t.name)}</span>
          ${tags.length ? `<span style="color:var(--text3);font-size:11px">${tags.map(g => `#${escHtml(g)}`).join(" ")}</span>` : ""}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          ${t.last_duration_ms ? `<span style="color:var(--text3);font-size:11px">${t.last_duration_ms}ms</span>` : ""}
          ${t.last_run_at ? `<span style="color:var(--text3);font-size:11px">${relTime(t.last_run_at)}</span>` : ""}
          <span style="color:var(--text3);font-size:11px">${t.run_count} runs</span>
          <button class="btn btn-ghost btn-sm btn-e2e-run" data-id="${t.id}">▶ Run</button>
          <button class="btn btn-ghost btn-sm btn-e2e-detail" data-id="${t.id}">Detail</button>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".btn-e2e-run").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      btn.disabled = true; btn.textContent = "…";
      try { await POST(`/e2e/tests/${btn.dataset.id}/run`); }
      catch (err) { alert(err.message); }
      finally { btn.textContent = "▶ Run"; btn.disabled = false; }
    });
  });

  container.querySelectorAll(".btn-e2e-detail, .e2e-test-row").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const id = el.dataset.id || el.closest(".e2e-test-row").dataset.id;
      navigate(`/e2e/${id}`);
    });
  });
}

// ── E2E Test Detail ───────────────────────────────────────────────────────────

async function renderE2EDetail(testId) {
  app.innerHTML = `
    <a href="#/e2e" class="back-link">← Back to E2E Tests</a>
    <div id="e2e-detail-content">${loading()}</div>
  `;
  try {
    const test = await GET(`/e2e/tests/${testId}`);
    _renderE2EDetailContent(test);
  } catch (err) { showError(err.message); }
}

function _renderE2EDetailContent(test) {
  const runs = test.runs || [];
  const lastRun = runs[0];
  const tags = Array.isArray(test.tags) ? test.tags : [];

  document.getElementById("e2e-detail-content").innerHTML = `
    <div class="page-header">
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
          <div class="page-title">${escHtml(test.name)}</div>
          <span id="e2e-status-${test.id}" class="badge ${lastRun?.status === 'pass' ? 'badge-pass' : lastRun?.status ? 'badge-fail' : 'badge-pending'}">${lastRun?.status || 'never'}</span>
        </div>
        <div class="page-subtitle">${escHtml(test.description || "No description")}</div>
        ${tags.length ? `<div style="margin-top:4px">${tags.map(t => `<span style="font-size:11px;color:var(--text3);margin-right:6px">#${escHtml(t)}</span>`).join("")}</div>` : ""}
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" id="btn-e2e-edit">Edit</button>
        <button class="btn btn-danger btn-sm" id="btn-e2e-delete">Delete</button>
        <button class="btn btn-primary btn-sm" id="btn-e2e-run">▶ Run Now</button>
      </div>
    </div>

    <div class="e2e-layout">
      <div>
        <div style="font-size:12px;color:var(--text3);margin-bottom:6px">Test Code</div>
        <pre class="e2e-code">${escHtml(test.test_code)}</pre>
      </div>
      <div>
        <div style="font-size:12px;color:var(--text3);margin-bottom:6px">Run History (${runs.length})</div>
        ${runs.length ? runs.map(r => renderRunCard(test.id, r)).join("") : `<div class="empty" style="padding:20px"><p>No runs yet</p></div>`}
      </div>
    </div>
  `;

  document.getElementById("btn-e2e-run").addEventListener("click", async () => {
    const btn = document.getElementById("btn-e2e-run");
    btn.disabled = true; btn.textContent = "Running…";
    try {
      await POST(`/e2e/tests/${test.id}/run`);
      const updated = await GET(`/e2e/tests/${test.id}`);
      _renderE2EDetailContent(updated);
    } catch (err) { alert(err.message); }
    finally { const b = document.getElementById("btn-e2e-run"); if (b) { b.disabled = false; b.textContent = "▶ Run Now"; } }
  });

  document.getElementById("btn-e2e-edit").addEventListener("click", () => showE2EModal(test));
  document.getElementById("btn-e2e-delete").addEventListener("click", async () => {
    if (!confirm(`Delete test "${test.name}"?`)) return;
    try { await DELETE(`/e2e/tests/${test.id}`); navigate("/e2e"); }
    catch (err) { alert(err.message); }
  });

  // Create bug buttons
  document.querySelectorAll(".btn-create-bug").forEach(btn => {
    btn.addEventListener("click", () => showCreateBugModal(Number(btn.dataset.runId), test.name));
  });
}

function renderRunCard(testId, run) {
  const dataOut = (() => { try { return JSON.parse(run.data_out || "{}"); } catch { return {}; } })();
  const steps = dataOut.steps || [];
  const statusClass = run.status === "pass" ? "badge-pass" : run.status === "running" ? "badge-in_progress" : "badge-fail";
  const dataIn = (() => { try { return JSON.parse(run.data_in || "{}"); } catch { return {}; } })();

  return `
    <div class="e2e-run-card">
      <div class="e2e-run-header">
        <span class="badge ${statusClass}">${run.status}</span>
        <span style="color:var(--text3);font-size:11px">${run.duration_ms ?? 0}ms</span>
        <span style="color:var(--text3);font-size:11px">${relTime(run.run_at)}</span>
        <span style="color:var(--text3);font-size:11px">by ${run.triggered_by}</span>
        ${run.status === "fail" || run.status === "error" ? `<button class="btn btn-danger btn-sm btn-create-bug" data-run-id="${run.id}">🐛 Create Bug Task</button>` : ""}
      </div>

      <div class="e2e-data-row">
        <div class="e2e-data-box">
          <div class="e2e-data-label">Data In</div>
          <pre class="e2e-data-pre">${escHtml(JSON.stringify(dataIn, null, 2))}</pre>
        </div>
        <div class="e2e-data-box">
          <div class="e2e-data-label">Data Out — ${dataOut.pass_count ?? 0} pass / ${dataOut.fail_count ?? 0} fail</div>
          <div>
            ${steps.filter(s => s.pass !== undefined).map(s => `
              <div class="e2e-step ${s.pass ? 'e2e-step-pass' : 'e2e-step-fail'}">
                <span class="e2e-step-icon">${s.pass ? "✓" : "✗"}</span>
                <span>${escHtml(s.name)}</span>
                ${s.data && Object.keys(s.data).length ? `<code style="font-size:10px;color:var(--text3)">${escHtml(JSON.stringify(s.data))}</code>` : ""}
              </div>
            `).join("")}
            ${steps.filter(s => s.screenshot).map(s => `
              <div style="margin:6px 0">
                <div style="font-size:10px;color:var(--text3);margin-bottom:2px">${escHtml(s.name || "screenshot")}</div>
                <img src="${s.screenshot}" alt="screenshot" class="e2e-screenshot" />
              </div>
            `).join("")}
          </div>
        </div>
      </div>

      ${run.error_msg ? `<div class="e2e-error">Error: ${escHtml(run.error_msg)}</div>` : ""}
    </div>
  `;
}

// ── E2E test editor modal ─────────────────────────────────────────────────────

function showE2EModal(existing) {
  const isEdit = !!existing;
  openModal(`
    <div class="modal-title">${isEdit ? "Edit E2E Test" : "New E2E Test"}</div>
    <div class="form-group">
      <label class="form-label">Name *</label>
      <input class="form-input" id="em-name" value="${escHtml(existing?.name ?? "")}" placeholder="Test name" />
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <input class="form-input" id="em-desc" value="${escHtml(existing?.description ?? "")}" placeholder="What this test verifies" />
    </div>
    <div class="form-group">
      <label class="form-label">Tags (comma-separated, used for auto-trigger)</label>
      <input class="form-input" id="em-tags" value="${escHtml((Array.isArray(existing?.tags) ? existing.tags : []).join(", "))}" placeholder="plans, navigation, worker" />
    </div>
    <div class="form-group">
      <label class="form-label">Base URL</label>
      <input class="form-input" id="em-url" value="${escHtml(existing?.base_url ?? "http://localhost:3069")}" />
    </div>
    <div class="form-group">
      <label class="form-label">Test Code * (uses: page, baseURL, step(name,pass,data), shot(name))</label>
      <textarea class="form-textarea" id="em-code" style="min-height:160px;font-family:monospace;font-size:12px">${escHtml(existing?.test_code ?? "")}</textarea>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="em-cancel">Cancel</button>
      <button class="btn btn-primary" id="em-submit">${isEdit ? "Save" : "Create"}</button>
    </div>
  `, (modal) => {
    modal.querySelector("#em-cancel").addEventListener("click", closeModal);
    modal.querySelector("#em-submit").addEventListener("click", async () => {
      const name = modal.querySelector("#em-name").value.trim();
      const desc = modal.querySelector("#em-desc").value.trim();
      const code = modal.querySelector("#em-code").value.trim();
      const url  = modal.querySelector("#em-url").value.trim() || "http://localhost:3069";
      const tags = modal.querySelector("#em-tags").value.split(",").map(t => t.trim()).filter(Boolean);
      if (!name || !code) { alert("Name and test code required"); return; }
      try {
        if (isEdit) {
          await PUT(`/e2e/tests/${existing.id}`, { name, description: desc, test_code: code, base_url: url, tags });
          closeModal();
          renderE2EDetail(existing.id);
        } else {
          const test = await POST("/e2e/tests", { name, description: desc, test_code: code, base_url: url, tags });
          closeModal();
          navigate(`/e2e/${test.id}`);
        }
      } catch (err) { alert(err.message); }
    });
  });
}

// ── Create Bug Task modal ────────────────────────────────────────────────────

async function showCreateBugModal(runId, testName) {
  let plans = [];
  try { plans = await GET("/plans?status=active"); } catch {}

  if (!plans.length) { alert("No active plans. Create or activate a plan first."); return; }

  openModal(`
    <div class="modal-title">🐛 Create Bug Task</div>
    <div style="color:var(--text2);font-size:13px;margin-bottom:16px">
      Creates a new task in the selected plan describing the failure of:<br>
      <strong>${escHtml(testName)}</strong>
    </div>
    <div class="form-group">
      <label class="form-label">Target Plan *</label>
      <select class="form-select" id="bug-plan">
        ${plans.map(p => `<option value="${p.id}">${escHtml(p.title)}</option>`).join("")}
      </select>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="bug-cancel">Cancel</button>
      <button class="btn btn-danger" id="bug-submit">Create Bug Task</button>
    </div>
  `, (modal) => {
    modal.querySelector("#bug-cancel").addEventListener("click", closeModal);
    modal.querySelector("#bug-submit").addEventListener("click", async () => {
      const plan_id = Number(modal.querySelector("#bug-plan").value);
      try {
        const { task_id, plan_id: pid } = await POST(`/e2e/runs/${runId}/create-bug`, { plan_id });
        closeModal();
        navigate(`/plans/${pid}`);
      } catch (err) { alert(err.message); }
    });
  });
}

// ============================================================
// Chat Page
// ============================================================

let _chatMessages = []; // { role: "user"|"assistant", content: string }
let _chatStreaming = false;
let _currentEditedPlan = null; // { msgIdx, title, description, user_story, tasks: [...] }

function renderChatPage() {
  app.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Chat</div>
        <div class="page-subtitle">Conversational planning — generate plans, user stories, and tasks</div>
      </div>
      <button class="btn btn-ghost btn-sm" id="btn-chat-clear">Clear</button>
    </div>
    <div id="chat-config-banner" class="chat-config-banner hidden"></div>
    <div class="chat-container">
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-row">
        <textarea class="chat-input" id="chat-input" rows="3" placeholder="Describe what you want to build…"></textarea>
        <button class="btn btn-primary chat-send-btn" id="chat-send">Send</button>
      </div>
    </div>
  `;

  _renderChatMessages();

  // Check API config
  GET("/chat/config").then(cfg => {
    if (!cfg.configured) {
      const banner = document.getElementById("chat-config-banner");
      banner.textContent = cfg.message || "Claude CLI not found. Make sure Claude Code is installed and 'claude' is in your PATH.";
      banner.classList.remove("hidden");
    }
  }).catch(() => {});

  document.getElementById("btn-chat-clear").addEventListener("click", () => {
    _chatMessages = [];
    _renderChatMessages();
  });

  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");

  sendBtn.addEventListener("click", _chatSend);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      _chatSend();
    }
  });
}

function _renderChatMessages() {
  const container = document.getElementById("chat-messages");
  if (!container) return;
  if (_chatMessages.length === 0) {
    container.innerHTML = `<div class="chat-empty">Start a conversation to generate plans, user stories, and tasks.</div>`;
    return;
  }
  container.innerHTML = _chatMessages.map((msg, i) => `
    <div class="chat-msg chat-msg-${msg.role}" id="chat-msg-${i}">
      <div class="chat-msg-role">${msg.role === "user" ? "You" : "Claude"}</div>
      <div class="chat-msg-content">${_renderMsgContent(msg.content, i)}</div>
    </div>
  `).join("");
  container.scrollTop = container.scrollHeight;
}

function _extractPlan(text) {
  // Try every code block in order until one parses as a valid plan
  const re = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj.type === "plan" && obj.title && Array.isArray(obj.tasks)) return obj;
    } catch (_) {}
  }
  return null;
}

function _renderMsgContent(text, msgIdx) {
  const plan = _extractPlan(text);
  if (plan) {
    return _renderPlanCard(plan, text, msgIdx);
  }
  // Minimal markdown: code blocks and line breaks
  return escHtml(text)
    .replace(/```[\s\S]*?```/g, m => `<pre class="chat-code">${m.slice(3, -3)}</pre>`)
    .replace(/\n/g, "<br>");
}

function _editableField(id, value, tag = "input", rows = 2, placeholder = "") {
  const inputEl = tag === "textarea"
    ? `<textarea class="plan-field-input" id="pf-input-${id}" rows="${rows}" placeholder="${escAttr(placeholder)}">${escHtml(value)}</textarea>`
    : `<input type="text" class="plan-field-input" id="pf-input-${id}" value="${escAttr(value)}" placeholder="${escAttr(placeholder)}">`;
  return `
    <div class="plan-field-wrapper" id="pf-${id}">
      <div class="plan-field-display">
        <span class="plan-field-value" id="pf-val-${id}">${escHtml(value)}</span>
        <button class="btn btn-ghost btn-xs plan-edit-btn" onclick="_editPlanField('${id}')">Edit</button>
      </div>
      <div class="plan-field-edit hidden">
        ${inputEl}
        <div class="plan-field-actions">
          <button class="btn btn-primary btn-xs" onclick="_savePlanField('${id}')">Save</button>
          <button class="btn btn-ghost btn-xs" onclick="_cancelPlanFieldEdit('${id}')">Cancel</button>
        </div>
      </div>
    </div>`;
}

function _renderTasksHtml(tasks) {
  return tasks.map((t, idx) => `
    <div class="plan-task" id="plan-task-${idx}">
      <div class="plan-task-header">
        <span class="plan-task-num">${idx + 1}</span>
        <div class="plan-task-title-wrap">
          ${_editableField(`task-${idx}-title`, t.title, "input", 1, "Task title")}
        </div>
        <button class="btn btn-ghost btn-xs plan-remove-task-btn" onclick="_removePlanTask(${idx})" title="Remove task">×</button>
      </div>
      <div class="plan-task-body">
        <div class="plan-task-field-row">
          <span class="plan-task-field-label">Description</span>
          ${_editableField(`task-${idx}-desc`, t.description || "", "textarea", 2, "Task description")}
        </div>
        <div class="plan-task-field-row">
          <span class="plan-task-field-label plan-task-field-label-green">Test Criteria</span>
          ${_editableField(`task-${idx}-criteria`, t.test_criteria || "", "textarea", 2, "How to verify this task is done")}
        </div>
      </div>
    </div>
  `).join("");
}

function _renderPlanCard(plan, rawText, msgIdx) {
  // Initialize or re-use edited plan (preserve edits across re-renders of same message)
  if (!_currentEditedPlan || _currentEditedPlan.msgIdx !== msgIdx) {
    _currentEditedPlan = {
      msgIdx,
      title: plan.title || "",
      description: plan.description || "",
      user_story: plan.user_story || "",
      tasks: (plan.tasks || []).map(t => ({
        title: t.title || "",
        description: t.description || "",
        test_criteria: t.test_criteria || "",
      })),
    };
  }
  const p = _currentEditedPlan;

  // Remove the code block that contained the plan JSON, keep everything else
  const prefix = rawText.replace(/```(?:json)?\s*\{[\s\S]*?"type"\s*:\s*"plan"[\s\S]*?\}\s*```/, "").trim();
  const prefixHtml = prefix
    ? `<div class="plan-prefix">${escHtml(prefix).replace(/\n/g, "<br>")}</div>`
    : "";

  return `
    ${prefixHtml}
    <div class="plan-card">
      <div class="plan-card-header">
        <div class="plan-card-title-row">
          <span class="plan-card-label">Plan</span>
          ${_editableField("title", p.title, "input", 1, "Plan title")}
        </div>
        ${p.description ? `
        <div class="plan-card-desc-row">
          <span class="plan-card-label plan-card-label-sm">Description</span>
          ${_editableField("desc", p.description, "textarea", 2, "Plan description")}
        </div>` : ""}
      </div>
      <div class="plan-card-story">
        <div class="plan-story-row">
          <span class="plan-card-label">User Story</span>
        </div>
        ${_editableField("story", p.user_story, "textarea", 3, "As a [user], I want [goal] so that [benefit]")}
      </div>
      <div class="plan-card-tasks" id="plan-card-tasks-container">
        <div class="plan-tasks-header">
          <span class="plan-card-label">Tasks (${p.tasks.length})</span>
          <button class="btn btn-ghost btn-xs" onclick="_addPlanTask()">+ Add Task</button>
        </div>
        ${_renderTasksHtml(p.tasks)}
      </div>
      <div class="plan-card-footer">
        <button class="btn btn-primary btn-sm" onclick="_saveChatPlan()">Save Plan</button>
        <button class="btn btn-ghost btn-sm" onclick="_showRefineInput('all','the entire plan')">Refine with AI</button>
      </div>
      <div class="refine-input-area hidden" id="refine-area-all">
        <textarea class="refine-textarea" id="refine-input-all" rows="2" placeholder="What should be changed across the entire plan?"></textarea>
        <div class="refine-actions">
          <button class="btn btn-primary btn-xs" onclick="_submitRefine('all','the entire plan')">Apply</button>
          <button class="btn btn-ghost btn-xs" onclick="_hideRefineInput('all')">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function escAttr(str) {
  return String(str).replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

// ---- Inline plan field editing ----

function _editPlanField(fieldId) {
  const wrapper = document.getElementById(`pf-${fieldId}`);
  if (!wrapper) return;
  wrapper.querySelector(".plan-field-display").classList.add("hidden");
  wrapper.querySelector(".plan-field-edit").classList.remove("hidden");
  const input = document.getElementById(`pf-input-${fieldId}`);
  if (input) { input.focus(); if (input.select) input.select(); }
}

function _savePlanField(fieldId) {
  const input = document.getElementById(`pf-input-${fieldId}`);
  if (!input || !_currentEditedPlan) return;
  const value = input.value; // preserve whitespace as-is

  if (fieldId === "title") {
    _currentEditedPlan.title = value;
  } else if (fieldId === "desc") {
    _currentEditedPlan.description = value;
  } else if (fieldId === "story") {
    _currentEditedPlan.user_story = value;
  } else {
    const m = fieldId.match(/^task-(\d+)-(\w+)$/);
    if (m) {
      const idx = parseInt(m[1]);
      const prop = m[2] === "title" ? "title" : m[2] === "desc" ? "description" : "test_criteria";
      if (_currentEditedPlan.tasks[idx]) _currentEditedPlan.tasks[idx][prop] = value;
    }
  }

  // Update the display value in-place
  const valEl = document.getElementById(`pf-val-${fieldId}`);
  if (valEl) valEl.textContent = value;

  const wrapper = document.getElementById(`pf-${fieldId}`);
  if (wrapper) {
    wrapper.querySelector(".plan-field-display").classList.remove("hidden");
    wrapper.querySelector(".plan-field-edit").classList.add("hidden");
  }
}

function _cancelPlanFieldEdit(fieldId) {
  const wrapper = document.getElementById(`pf-${fieldId}`);
  if (!wrapper) return;
  // Restore input to current saved value
  if (_currentEditedPlan) {
    const input = document.getElementById(`pf-input-${fieldId}`);
    if (input) {
      let val = "";
      if (fieldId === "title") val = _currentEditedPlan.title;
      else if (fieldId === "desc") val = _currentEditedPlan.description;
      else if (fieldId === "story") val = _currentEditedPlan.user_story;
      else {
        const m = fieldId.match(/^task-(\d+)-(\w+)$/);
        if (m) {
          const idx = parseInt(m[1]);
          const prop = m[2] === "title" ? "title" : m[2] === "desc" ? "description" : "test_criteria";
          if (_currentEditedPlan.tasks[idx]) val = _currentEditedPlan.tasks[idx][prop];
        }
      }
      input.value = val;
    }
  }
  wrapper.querySelector(".plan-field-display").classList.remove("hidden");
  wrapper.querySelector(".plan-field-edit").classList.add("hidden");
}

function _addPlanTask() {
  if (!_currentEditedPlan) return;
  _currentEditedPlan.tasks.push({ title: "New task", description: "", test_criteria: "" });
  _refreshTasksContainer();
}

function _removePlanTask(idx) {
  if (!_currentEditedPlan) return;
  _currentEditedPlan.tasks.splice(idx, 1);
  _refreshTasksContainer();
}

function _refreshTasksContainer() {
  const container = document.getElementById("plan-card-tasks-container");
  if (!container || !_currentEditedPlan) return;
  const header = container.querySelector(".plan-tasks-header");
  // Update task count in header label
  const label = header?.querySelector(".plan-card-label");
  if (label) label.textContent = `Tasks (${_currentEditedPlan.tasks.length})`;
  // Remove old task rows
  container.querySelectorAll(".plan-task").forEach(el => el.remove());
  // Insert new tasks after header
  if (header) header.insertAdjacentHTML("afterend", _renderTasksHtml(_currentEditedPlan.tasks));
}

function _showRefineInput(id, label) {
  const area = document.getElementById(`refine-area-${id}`);
  if (!area) return;
  area.classList.remove("hidden");
  const input = document.getElementById(`refine-input-${id}`);
  if (input) { input.focus(); input.value = ""; }
}

function _hideRefineInput(id) {
  const area = document.getElementById(`refine-area-${id}`);
  if (area) area.classList.add("hidden");
}

function _submitRefine(id, label) {
  const input = document.getElementById(`refine-input-${id}`);
  const feedback = (input?.value || "").trim();
  if (!feedback) return;
  _hideRefineInput(id);

  // Build a natural refinement message and inject it into the conversation
  let msg;
  if (id === "all") {
    msg = `Please refine the entire plan based on this feedback: ${feedback}`;
  } else if (id === "title") {
    msg = `Please refine the plan title based on this feedback: ${feedback}`;
  } else if (id === "story") {
    msg = `Please refine the user story based on this feedback: ${feedback}`;
  } else {
    msg = `Please refine task "${label}" based on this feedback: ${feedback}`;
  }

  // Pre-fill the chat input and trigger send
  const chatInput = document.getElementById("chat-input");
  if (chatInput) {
    chatInput.value = msg;
    _chatSend();
  }
}

async function _saveChatPlan() {
  // Use the currently edited plan (with any inline edits applied)
  const plan = _currentEditedPlan;
  if (!plan) return;

  const btn = document.querySelector(".plan-card-footer .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    await POST("/plans", {
      title: plan.title,
      description: plan.description,
      user_story: plan.user_story,
      tasks: plan.tasks,
    });
    if (btn) { btn.textContent = "Saved!"; btn.className = "btn btn-ghost btn-sm"; }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "Save Plan"; }
    alert("Failed to save plan: " + err.message);
  }
}

async function _chatSend() {
  if (_chatStreaming) return;
  const input = document.getElementById("chat-input");
  const text = (input.value || "").trim();
  if (!text) return;

  input.value = "";
  _chatMessages.push({ role: "user", content: text });

  // Add placeholder for assistant
  const assistantIdx = _chatMessages.length;
  _chatMessages.push({ role: "assistant", content: "" });
  _renderChatMessages();

  const sendBtn = document.getElementById("chat-send");
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = "…"; }
  _chatStreaming = true;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: _chatMessages.slice(0, assistantIdx) })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      _chatMessages[assistantIdx] = { role: "assistant", content: `Error: ${err.error}` };
      _renderChatMessages();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === "delta") {
            _chatMessages[assistantIdx].content += evt.text;
            _renderChatMessages();
          } else if (evt.type === "done") {
            _chatMessages[assistantIdx].content = evt.text;
            _renderChatMessages();
          } else if (evt.type === "error") {
            _chatMessages[assistantIdx].content = `Error: ${evt.error}`;
            _renderChatMessages();
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    _chatMessages[assistantIdx] = { role: "assistant", content: `Error: ${err.message}` };
    _renderChatMessages();
  } finally {
    _chatStreaming = false;
    const btn = document.getElementById("chat-send");
    if (btn) { btn.disabled = false; btn.textContent = "Send"; }
    const inp = document.getElementById("chat-input");
    if (inp) inp.focus();
  }
}

// ============================================================
// Terminal Page (xterm.js)
// ============================================================

let _xtermInstance   = null;
let _xtermFitAddon   = null;
let _xtermResizeObs  = null;
let _termWs          = null;

function _disposeTerminal() {
  if (_xtermResizeObs) { _xtermResizeObs.disconnect(); _xtermResizeObs = null; }
  if (_xtermInstance)  { _xtermInstance.dispose(); _xtermInstance = null; }
  if (_termWs && _termWs.readyState < 2) { _termWs.close(); }
  _xtermFitAddon = null;
  _termWs = null;
}

function renderTerminalPage() {
  _disposeTerminal();

  app.innerHTML = `
    <div class="terminal-page">
      <div class="page-header">
        <div>
          <div class="page-title">Terminal</div>
          <div class="page-subtitle">Interactive terminal — run commands in the web interface</div>
        </div>
      </div>
      <div id="terminal-container"></div>
    </div>
  `;

  const container = document.getElementById("terminal-container");
  if (!container) return;

  // Guard: xterm must be loaded via script tag
  if (typeof Terminal === "undefined") {
    container.innerHTML = `<div class="empty"><p style="color:var(--red)">xterm.js not loaded.</p></div>`;
    return;
  }

  const term = new Terminal({
    theme: {
      background:   "#000000",
      foreground:   "#e2e8f0",
      cursor:       "#22c55e",
      cursorAccent: "#000000",
      black:        "#1e293b",
      brightBlack:  "#374151",
      red:          "#ef4444",
      brightRed:    "#f87171",
      green:        "#22c55e",
      brightGreen:  "#4ade80",
      yellow:       "#eab308",
      brightYellow: "#facc15",
      blue:         "#3b82f6",
      brightBlue:   "#60a5fa",
      magenta:      "#a855f7",
      brightMagenta:"#c084fc",
      cyan:         "#06b6d4",
      brightCyan:   "#22d3ee",
      white:        "#f1f5f9",
      brightWhite:  "#f8fafc",
    },
    fontFamily: '"Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
    fontSize: 14,
    lineHeight: 1.4,
    cursorBlink: true,
    cursorStyle: "block",
    scrollback: 1000,
    allowTransparency: false,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  if (typeof WebLinksAddon !== "undefined") {
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
  }

  term.open(container);

  // Defer fit until the container has its CSS dimensions applied
  requestAnimationFrame(() => {
    try { fitAddon.fit(); } catch (_) {}
  });

  term.writeln("\x1b[1;32mLucid Terminal\x1b[0m — connecting...");

  _xtermInstance = term;
  _xtermFitAddon = fitAddon;

  // Connect WebSocket to /ws/terminal on the same host
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${wsProto}//${location.host}/ws/terminal`);
  ws.binaryType = "arraybuffer";
  _termWs = ws;

  ws.onopen = () => {
    term.writeln("\x1b[32m[connected]\x1b[0m");
    // Send initial terminal dimensions
    if (term.cols && term.rows) {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(event.data));
    } else {
      term.write(event.data);
    }
  };

  ws.onclose = () => {
    term.writeln("\r\n\x1b[33m[disconnected]\x1b[0m");
  };

  ws.onerror = () => {
    term.writeln("\r\n\x1b[31m[WebSocket error — check server]\x1b[0m");
  };

  // Forward terminal keystrokes/paste to server via WebSocket
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });

  // Refit on container resize and notify server of new dimensions
  _xtermResizeObs = new ResizeObserver(() => {
    try {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    } catch (_) {}
  });
  _xtermResizeObs.observe(container);

  // Also refit on window resize
  window.addEventListener("resize", _onWindowResizeTerminal);
}

function _onWindowResizeTerminal() {
  if (_xtermFitAddon) {
    try { _xtermFitAddon.fit(); } catch (_) {}
  }
}

