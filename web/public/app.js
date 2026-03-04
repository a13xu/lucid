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

let _sseConnection = null;
let _orchestratorInstances = [];
let _sseReconnectAttempt = 0;

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

  let m;
  if (hash === "/" || hash === "") {
    renderOrchestratorPage();
  } else if (hash === "/plans") {
    renderPlansPage();
  } else if ((m = hash.match(/^\/plans\/(\d+)\/tasks\/(\d+)\/tests/))) {
    renderTestRunner(Number(m[1]), Number(m[2]));
  } else if ((m = hash.match(/^\/plans\/(\d+)/))) {
    renderPlanDetail(Number(m[1]));
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

async function renderPlansPage(activeTab) {
  const tab = activeTab || "active";
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
  `;

  document.getElementById("btn-new-plan").addEventListener("click", () => showNewPlanModal(tab));

  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => renderPlansPage(btn.dataset.tab));
  });

  try {
    const plans = await GET(`/plans?status=${tab}`);
    renderPlanCards(plans);
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
    return `
      <div class="card" data-plan-id="${p.id}">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
          <div class="card-title">${escHtml(p.title)}</div>
          ${badge(p.status)}
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
      <label class="form-label">User Story *</label>
      <textarea class="form-textarea" id="m-story" placeholder="As a user, I want to..."></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Tasks (one per line) *</label>
      <textarea class="form-textarea" id="m-tasks" style="min-height:100px" placeholder="Task 1&#10;Task 2&#10;Task 3"></textarea>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-submit">Create Plan</button>
    </div>
  `, (modal) => {
    modal.querySelector("#m-cancel").addEventListener("click", closeModal);
    modal.querySelector("#m-submit").addEventListener("click", async () => {
      const title = modal.querySelector("#m-title").value.trim();
      const description = modal.querySelector("#m-desc").value.trim();
      const user_story = modal.querySelector("#m-story").value.trim();
      const taskLines = modal.querySelector("#m-tasks").value.trim().split("\n").filter(Boolean);

      if (!title || !description || !user_story || !taskLines.length) {
        alert("All fields are required, with at least one task.");
        return;
      }

      const tasks = taskLines.map(line => ({
        title: line.trim(),
        description: "",
        test_criteria: "",
      }));

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

    <div id="tasks-list">
      ${(plan.tasks || []).map(t => renderTaskHtml(plan.id, t)).join("")}
    </div>
  `;

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
        const plan = await GET(`/plans/${btn.dataset.planId}`);
        renderPlanContent(plan);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  // Open test runner
  document.querySelectorAll(".btn-open-tests").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigate(`/plans/${btn.dataset.planId}/tasks/${btn.dataset.taskId}/tests`);
    });
  });

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

  return `
    <div class="task-item">
      <div class="task-header">
        <span class="task-seq">#${task.seq}</span>
        <span class="task-title">${escHtml(task.title)}</span>
        ${task.test_count !== undefined ? `<span class="task-test-count">${task.test_count} test${task.test_count !== 1 ? "s" : ""}</span>` : ""}
        ${badge(task.status)}
      </div>
      <div class="task-body" style="display:none">
        ${task.description ? `<div class="task-desc">${escHtml(task.description)}</div>` : ""}
        ${task.test_criteria ? `<div class="task-criteria">Criteria: ${escHtml(task.test_criteria)}</div>` : ""}

        ${notes.length ? `<div style="margin:8px 0">${notes.map(n => `<div class="note-item"><div>${escHtml(n.text)}</div><div class="note-ts">${fmtDate(n.ts)}</div></div>`).join("")}</div>` : ""}

        <div class="task-actions">
          ${actions.map(s => `<button class="btn btn-ghost btn-sm btn-task-status" data-task-id="${task.id}" data-plan-id="${planId}" data-status="${s}">Mark ${s.replace("_", " ")}</button>`).join("")}
          <button class="btn btn-ghost btn-sm btn-open-tests" data-task-id="${task.id}" data-plan-id="${planId}">Tests (${task.test_count ?? 0})</button>
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

function renderOrchestratorPage() {
  app.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Orchestrator</div>
        <div class="page-subtitle">Active Claude Code instances — updates live via SSE</div>
      </div>
    </div>
    <div id="orchestrator-content">
      <div class="loading"><div class="spinner"></div></div>
    </div>
  `;

  // Render with whatever data is already in memory
  if (_orchestratorInstances.length > 0) {
    renderOrchestratorContent(_orchestratorInstances);
  }

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
