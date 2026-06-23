// 流程运行数据持久化（PRD §13）。单文件 .data/workflows.json；原子写（tmp + rename）+ 单写入队列。
// 与 discussion-store.mjs 同构。所有跨任务记忆走结构化产物，不依赖 PTY 记忆。

import fs from "node:fs/promises";
import path from "node:path";
import { nextSeq } from "./workflow-engine.mjs";

const STORE_VERSION = 1;

function uid(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

function nowIso() {
  return new Date().toISOString();
}

function emptyState() {
  return {
    version: STORE_VERSION,
    runs: [],
    tasks: [],
    roleSessions: [],
    stageResults: [],
    handoffs: [],
    auditLog: [],
  };
}

export function createWorkflowStore({ dataDir }) {
  const dir = dataDir;
  const file = path.join(dir, "workflows.json");
  let state = emptyState();
  let loaded = false;
  let writeChain = Promise.resolve();

  async function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    writeChain = writeChain.then(async () => {
      await fs.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.workflows.${process.pid}.${Date.now()}.tmp`);
      await fs.writeFile(tmp, snapshot, "utf8");
      await fs.rename(tmp, file);
    });
    return writeChain;
  }

  async function load() {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      state = { ...emptyState(), ...parsed };
      for (const k of ["runs", "tasks", "roleSessions", "stageResults", "handoffs", "auditLog"]) {
        if (!Array.isArray(state[k])) state[k] = [];
      }
    } catch {
      state = emptyState();
    }
    loaded = true;
    return state;
  }

  function ensureLoaded() {
    if (!loaded) throw new Error("workflow store not loaded; call load() first");
  }

  // ---- Runs ----

  async function createRun(opts) {
    ensureLoaded();
    const ts = nowIso();
    const run = {
      id: uid("wfrun"),
      groupId: opts.groupId || "",
      projectId: opts.projectId || "",
      workflowTemplateId: opts.workflowTemplateId || "",
      workflowSnapshot: opts.workflowSnapshot || {},
      goal: String(opts.goal || "").trim(),
      repositoryPath: opts.repositoryPath || "",
      baseBranch: opts.baseBranch || "",
      integrationMode: opts.integrationMode === "direct_merge" ? "direct_merge" : "pull_request",
      status: opts.status || "draft",
      currentStageId: opts.currentStageId || "planning",
      currentTaskId: opts.currentTaskId || null,
      integrationBaseline: opts.integrationBaseline || opts.baseSha || "",
      baseSha: opts.baseSha || "",
      settings: opts.settings || {},
      templateSources: opts.templateSources || [],
      autoMode: !!opts.autoMode,
      createdAt: ts,
      updatedAt: ts,
    };
    state.runs.push(run);
    await persist();
    return { ...run };
  }

  function getRun(runId) {
    ensureLoaded();
    const r = state.runs.find((x) => x.id === runId);
    return r ? { ...r } : null;
  }

  function listRuns(filter = {}) {
    ensureLoaded();
    return state.runs
      .filter((r) => (!filter.projectId || r.projectId === filter.projectId))
      .map((r) => ({ ...r }));
  }

  async function updateRun(runId, patch) {
    ensureLoaded();
    const r = state.runs.find((x) => x.id === runId);
    if (!r) {
      const err = new Error("运行不存在");
      err.code = "not_found";
      throw err;
    }
    Object.assign(r, patch, { updatedAt: nowIso() });
    await persist();
    return { ...r };
  }

  // ---- Tasks ----

  /** 用规划产出替换运行的任务列表（计划确认/重新规划时调用）。 */
  async function replacePlan(runId, tasks) {
    ensureLoaded();
    state.tasks = state.tasks.filter((t) => t.runId !== runId);
    const created = (Array.isArray(tasks) ? tasks : []).map((t, idx) => ({
      id: t.id || uid("wftask"),
      runId,
      order: idx,
      title: String(t.title || "").trim(),
      objective: t.objective || "",
      scope: Array.isArray(t.scope) ? t.scope : [],
      forbiddenChanges: Array.isArray(t.forbiddenChanges) ? t.forbiddenChanges : [],
      dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
      acceptanceCriteria: Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria : [],
      suggestedTests: Array.isArray(t.suggestedTests) ? t.suggestedTests : [],
      expectedFiles: Array.isArray(t.expectedFiles) ? t.expectedFiles : [],
      status: "pending",
      stage: null,
      reviewRounds: 0,
      lastFindingIds: [],
      branch: "",
      worktreePath: "",
      commitSha: "",
    }));
    state.tasks.push(...created);
    await persist();
    return created.map((t) => ({ ...t }));
  }

  function getTask(taskId) {
    ensureLoaded();
    const t = state.tasks.find((x) => x.id === taskId);
    return t ? { ...t } : null;
  }

  function listTasks(runId) {
    ensureLoaded();
    return state.tasks
      .filter((t) => t.runId === runId)
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((t) => ({ ...t }));
  }

  async function updateTask(taskId, patch) {
    ensureLoaded();
    const t = state.tasks.find((x) => x.id === taskId);
    if (!t) {
      const err = new Error("任务不存在");
      err.code = "not_found";
      throw err;
    }
    Object.assign(t, patch);
    await persist();
    return { ...t };
  }

  // ---- Role execution sessions (PRD §5.7) ----

  async function createRoleSession({ runId, memberId, roleId, taskId, stageId }) {
    ensureLoaded();
    const ts = nowIso();
    const session = {
      id: uid("wfsess"),
      runId,
      memberId: memberId || "",
      roleId: roleId || "",
      taskId: taskId || null,
      stageId: stageId || "",
      status: "starting",
      startedAt: ts,
      endedAt: null,
      transcriptRef: null,
    };
    state.roleSessions.push(session);
    await persist();
    return { ...session };
  }

  function getRoleSession(sessionId) {
    ensureLoaded();
    const s = state.roleSessions.find((x) => x.id === sessionId);
    return s ? { ...s } : null;
  }

  function listRoleSessions(runId) {
    ensureLoaded();
    return state.roleSessions.filter((s) => s.runId === runId).map((s) => ({ ...s }));
  }

  /** 找某任务当前活动（未关闭）的开发会话。 */
  function findActiveTaskSession(runId, taskId) {
    ensureLoaded();
    const s = state.roleSessions.find(
      (x) => x.runId === runId && x.taskId === taskId && x.status !== "completed" && x.status !== "terminated",
    );
    return s ? { ...s } : null;
  }

  async function updateRoleSession(sessionId, patch) {
    ensureLoaded();
    const s = state.roleSessions.find((x) => x.id === sessionId);
    if (!s) {
      const err = new Error("角色执行会话不存在");
      err.code = "not_found";
      throw err;
    }
    Object.assign(s, patch);
    await persist();
    return { ...s };
  }

  async function closeRoleSession(sessionId, status = "completed") {
    ensureLoaded();
    const s = state.roleSessions.find((x) => x.id === sessionId);
    if (!s) return null;
    s.status = status;
    s.endedAt = nowIso();
    await persist();
    return { ...s };
  }

  // ---- Stage results (append-only) ----

  async function appendStageResult({ runId, taskId, stageId, roleId, type, payload }) {
    ensureLoaded();
    const seq = nextSeq(state.stageResults.filter((r) => r.runId === runId));
    const record = {
      id: uid("wfres"),
      runId,
      taskId: taskId || null,
      stageId: stageId || "",
      roleId: roleId || "",
      type: type || "",
      seq,
      payload: payload || {},
      createdAt: nowIso(),
    };
    state.stageResults.push(record);
    await persist();
    return { ...record };
  }

  function listStageResults(runId, { taskId } = {}) {
    ensureLoaded();
    return state.stageResults
      .filter((r) => r.runId === runId && (taskId === undefined || r.taskId === taskId))
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({ ...r }));
  }

  // ---- Handoff artifacts (PRD §5.8) ----

  async function createHandoff(opts) {
    ensureLoaded();
    const handoff = {
      id: uid("wfho"),
      runId: opts.runId,
      taskId: opts.taskId,
      commitSha: opts.commitSha || "",
      integrationBaseline: opts.integrationBaseline || "",
      changeSummary: opts.changeSummary || "",
      changedFiles: opts.changedFiles || [],
      decisions: opts.decisions || [],
      changedInterfaces: opts.changedInterfaces || [],
      testResults: opts.testResults || [],
      closedFindings: opts.closedFindings || [],
      unresolvedIssues: opts.unresolvedIssues || [],
      createdAt: nowIso(),
    };
    state.handoffs.push(handoff);
    await persist();
    return { ...handoff };
  }

  function listHandoffs(runId) {
    ensureLoaded();
    return state.handoffs.filter((h) => h.runId === runId).map((h) => ({ ...h }));
  }

  function getHandoff(runId, taskId) {
    ensureLoaded();
    const h = state.handoffs.find((x) => x.runId === runId && x.taskId === taskId);
    return h ? { ...h } : null;
  }

  // ---- Audit log (append-only, PRD §13) ----

  async function appendAudit({ runId, kind, detail }) {
    ensureLoaded();
    const record = {
      id: uid("wfaud"),
      runId,
      kind,
      detail: detail || {},
      createdAt: nowIso(),
    };
    state.auditLog.push(record);
    await persist();
    return { ...record };
  }

  function listAudit(runId) {
    ensureLoaded();
    return state.auditLog.filter((a) => a.runId === runId).map((a) => ({ ...a }));
  }

  return {
    load,
    // runs
    createRun,
    getRun,
    listRuns,
    updateRun,
    // tasks
    replacePlan,
    getTask,
    listTasks,
    updateTask,
    // role sessions
    createRoleSession,
    getRoleSession,
    listRoleSessions,
    findActiveTaskSession,
    updateRoleSession,
    closeRoleSession,
    // stage results
    appendStageResult,
    listStageResults,
    // handoffs
    createHandoff,
    listHandoffs,
    getHandoff,
    // audit
    appendAudit,
    listAudit,
    _raw: () => state,
  };
}
