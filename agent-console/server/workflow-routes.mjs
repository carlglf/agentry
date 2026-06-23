// 流程运行 REST 路由：把引擎（纯逻辑）、模板、store、PTY、git 粘起来。
// handleWorkflowApi(req, res, ctx) → 命中返回 true，未命中返回 false（交回 server.mjs 的下一处理器/404）。

import process from "node:process";
import path from "node:path";
import {
  validatePlan,
  pickNextTask,
  dependentsOf,
  nextStage,
  isStagePass,
  validateStageSubmission,
  applyReviewRound,
  computeTaskContext,
  evaluateIntegrationGuard,
  canTransitionRun,
  stageKindFromStatus,
  statusFromStageKind,
  SUBMIT_TYPE_TO_KIND,
} from "./workflow-engine.mjs";
import {
  builtinTemplates,
  loadProjectTemplates,
  resolveTemplates,
  snapshotTemplates,
  validateResolvedWorkflow,
} from "./workflow-templates.mjs";
import {
  buildPlanningPrompt,
  buildDevelopmentPrompt,
  buildFixPrompt,
  buildReviewPrompt,
  buildTestingPrompt,
  buildIntegrationPrompt,
  buildRolePreamble,
} from "./workflow-prompt-builder.mjs";
import { isReadOnlyRole } from "./workflow-pty.mjs";

// ---- 小工具 ----

function workflowEnv(ctx, run, { roleId, taskId, stageId, execSessionId, readonly }) {
  return {
    AGENT_CONSOLE: "1",
    AGENT_CONSOLE_YOLO: readonly ? "0" : "1",
    AGENT_CONSOLE_READONLY: readonly ? "1" : "0",
    AGENT_CONSOLE_API: `http://${ctx.host}:${ctx.port}`,
    AGENT_CONSOLE_RUN_ID: run.id,
    AGENT_CONSOLE_TASK_ID: taskId || "",
    AGENT_CONSOLE_STAGE_ID: stageId || "",
    AGENT_CONSOLE_ROLE_ID: roleId || "",
    AGENT_CONSOLE_EXEC_SESSION_ID: execSessionId || "",
  };
}

/** 角色权限（来自模板快照），用于决定 PTY 是否以只读沙箱启动。 */
function rolePermissions(snapshot, roleId) {
  return (snapshot.roles && snapshot.roles[roleId] && snapshot.roles[roleId].permissions) || null;
}

function roleRuntime(snapshot, run, roleId) {
  const binding = (run.settings && run.settings.roleBindings && run.settings.roleBindings[roleId]) || {};
  const role = (snapshot.roles && snapshot.roles[roleId]) || {};
  return {
    runtime: binding.runtime || role.defaultRuntime || "codex",
    model: binding.model || role.defaultModel || "",
    memberId: binding.memberId || "",
    // 复用讨论组成员的人格/职责（若已绑定），注入到角色提示词前言。
    persona: binding.persona || "",
    duty: binding.duty || "",
  };
}

function roleForKind(snapshot, kind) {
  const stage = (snapshot.workflow.taskStages || []).find((s) => s.kind === kind);
  return stage ? stage.roleId : null;
}

function taskCwd(run, task) {
  return task && task.worktreePath ? task.worktreePath : run.repositoryPath || process.cwd();
}

async function loadResolved(ctx, repoPath, overrides) {
  const builtin = builtinTemplates();
  const loader = ctx.loadProjectTemplates || loadProjectTemplates;
  const project = repoPath ? await loader(repoPath) : { roles: {}, workflows: {}, prompts: {}, sources: {}, errors: [] };
  const resolved = resolveTemplates({ builtin, project, overrides });
  return { resolved, projectErrors: project.errors || [] };
}

// ---- 阶段进入：拉起对应角色会话并注入提示词 ----

/**
 * 让任务进入某状态（developing/reviewing/testing/documenting）：解析角色 → 复用/新建执行会话
 * → 等待 TUI 就绪 → 注入裁剪后的阶段提示词。返回 { session, delivered }。
 */
async function enterStage(ctx, run, task, statusName, opts = {}) {
  const { wfStore, ptyMgr, gitRunner } = ctx;
  const snapshot = run.workflowSnapshot;
  const kind = stageKindFromStatus(statusName);
  const roleId = roleForKind(snapshot, kind) || kind;
  const rt = roleRuntime(snapshot, run, roleId);
  const allTasks = wfStore.listTasks(run.id);
  const handoffs = wfStore.listHandoffs(run.id);

  // 开发（含修复循环）复用任务现有开发会话；review/test/doc 每阶段新建。
  let session;
  if (kind === "development") {
    session = wfStore.findActiveTaskSession(run.id, task.id);
  }
  if (!session) {
    session = await wfStore.createRoleSession({
      runId: run.id,
      memberId: rt.memberId,
      roleId,
      taskId: task.id,
      stageId: kind,
    });
  } else {
    await wfStore.updateRoleSession(session.id, { stageId: kind, status: "running" });
  }

  const cwd = taskCwd(run, task);
  const permissions = rolePermissions(snapshot, roleId);
  const readonly = isReadOnlyRole(permissions);
  ptyMgr.ensureSession({
    runId: run.id,
    execSessionId: session.id,
    runtime: rt.runtime,
    model: rt.model,
    label: `${roleId}:${task.id}`,
    cwd,
    permissions,
    env: workflowEnv(ctx, run, { roleId, taskId: task.id, stageId: kind, execSessionId: session.id, readonly }),
  });

  const context = computeTaskContext({ run, task, allTasks, handoffs });
  const stagePrompt = snapshot.prompts && snapshot.prompts[kind];
  const preamble = buildRolePreamble({ persona: rt.persona, duty: rt.duty });
  let prompt;
  if (kind === "development") {
    if (opts.fix) {
      prompt = buildFixPrompt({
        context,
        findings: opts.findings || [],
        round: task.reviewRounds,
        repeatedFindingIds: opts.repeatedFindingIds || [],
        stagePrompt,
      });
    } else {
      prompt = buildDevelopmentPrompt({ context, stagePrompt });
    }
  } else if (kind === "review") {
    const diffBase = task.baselineRef || run.baseBranch;
    const changedFiles = gitRunner ? await safe(() => gitRunner.getChangedFiles(cwd, { base: diffBase })) : [];
    prompt = buildReviewPrompt({ context, changedFiles, diffSummary: opts.diffSummary, devResult: opts.devResult, stagePrompt });
  } else if (kind === "testing") {
    const diffBase = task.baselineRef || run.baseBranch;
    const changedFiles = gitRunner ? await safe(() => gitRunner.getChangedFiles(cwd, { base: diffBase })) : [];
    prompt = buildTestingPrompt({
      context,
      allowedTestCommands: (run.settings && run.settings.testCommands) || (task.suggestedTests || []),
      changedFiles,
      stagePrompt,
    });
  } else {
    prompt = buildDevelopmentPrompt({ context, stagePrompt });
  }

  const key = ptyMgr.execKey(run.id, session.id);
  if (ptyMgr.waitForReady) await ptyMgr.waitForReady(key, rt.runtime);
  const delivered = await ptyMgr.typeInto(key, preamble + prompt, rt.runtime);

  await wfStore.updateTask(task.id, { status: statusName, stage: statusName });
  await wfStore.updateRun(run.id, { currentStageId: kind, currentTaskId: task.id });
  return { session, delivered };
}

async function safe(fn) {
  try {
    return await fn();
  } catch {
    return [];
  }
}

/**
 * 任务正式提交：commit → 交接产物 → 更新集成基线 → 关闭开发会话 → 推进下一任务（PRD §7.6）。
 * 提交失败（无改动 / git 配置缺失 / 冲突等）不静默推进：任务转 blocked、运行转 needs_attention，
 * 返回 { ok:false }，由上层据此回应人工处理（PRD §7.6/§11）。
 * @returns {Promise<{ ok: boolean, commitSha?: string, error?: string }>}
 */
async function commitTask(ctx, run, task) {
  const { wfStore, ptyMgr, gitRunner } = ctx;
  const cwd = taskCwd(run, task);
  const message = `feat(${task.id}): ${task.title}`;
  let commitSha = "";
  let changedFiles = [];
  if (gitRunner) {
    try {
      commitSha = await gitRunner.commit(cwd, { message });
    } catch (err) {
      return failCommit(ctx, run, task, err.message || String(err));
    }
    if (!String(commitSha || "").trim()) {
      return failCommit(ctx, run, task, "提交未产生任何 commit（可能没有改动）");
    }
    // 以本任务分支创建时的基线 diff，避免把前置任务的文件计入当前任务的增量（交接范围误判）。
    const diffBase = task.baselineRef || run.baseBranch;
    changedFiles = await safe(() => gitRunner.getChangedFiles(cwd, { base: diffBase }));
  }

  // 从已验证的 stageResults 抽取确定性字段；Agent 补充的设计决策/接口变化累计自全部开发结果
  // （含修复轮次），changeSummary 取最近一次。
  const results = wfStore.listStageResults(run.id, { taskId: task.id });
  const devResults = results.filter((r) => r.type === "dev");
  const lastDev = devResults[devResults.length - 1];
  const testRes = results.filter((r) => r.type === "test").map((r) => r.payload);
  const reviews = results.filter((r) => r.type === "review");
  const closedFindings = reviews.flatMap((r) => (r.payload.findings || []).map((f) => f.id));
  const uniq = (arr) => [...new Set(arr)];

  await wfStore.createHandoff({
    runId: run.id,
    taskId: task.id,
    commitSha,
    integrationBaseline: commitSha || run.integrationBaseline,
    changeSummary: (lastDev && lastDev.payload.changeSummary) || task.title,
    changedFiles,
    decisions: uniq(devResults.flatMap((r) => r.payload.decisions || [])),
    changedInterfaces: uniq(devResults.flatMap((r) => r.payload.changedInterfaces || [])),
    testResults: testRes,
    closedFindings,
    unresolvedIssues: uniq(devResults.flatMap((r) => r.payload.unresolvedIssues || [])),
  });

  await wfStore.updateTask(task.id, { status: "committed", commitSha });
  await wfStore.updateRun(run.id, { integrationBaseline: commitSha || run.integrationBaseline });
  await wfStore.appendAudit({ runId: run.id, kind: "task_committed", detail: { taskId: task.id, commitSha } });

  // 关闭当前任务开发会话（PRD §7.6.3）。
  const devSession = wfStore.findActiveTaskSession(run.id, task.id);
  if (devSession) {
    await wfStore.closeRoleSession(devSession.id);
    if (ptyMgr) ptyMgr.closeSession(run.id, devSession.id);
  }

  // 推进下一任务（PRD §7.6.4）。
  await advanceRun(ctx, wfStore.getRun(run.id));
  return { ok: true, commitSha };
}

/** 提交失败：任务转 blocked、运行转 needs_attention、审计，不推进。 */
async function failCommit(ctx, run, task, error) {
  const { wfStore } = ctx;
  await wfStore.updateTask(task.id, { status: "blocked" });
  if (canTransitionRun(run.status, "needs_attention")) {
    await wfStore.updateRun(run.id, { status: "needs_attention" });
  }
  await wfStore.appendAudit({ runId: run.id, kind: "commit_failed", detail: { taskId: task.id, error } });
  return { ok: false, error };
}

/** 选择下一个可执行任务并进入开发；无任务则进入集成阶段。 */
async function advanceRun(ctx, run) {
  const { wfStore } = ctx;
  if (!run || ["paused", "terminated", "needs_attention", "failed", "completed"].includes(run.status)) return;
  const tasks = wfStore.listTasks(run.id);
  const next = pickNextTask(tasks);
  if (next) {
    // 首次进入：建分支（+可选 worktree）。失败则任务转人工、不进入阶段。
    const branched = await ensureTaskBranch(ctx, run, next);
    if (!branched.ok) return;
    const fresh = wfStore.getTask(next.id);
    const firstStatus = statusFromStageKind((run.workflowSnapshot.workflow.taskStages[0] || {}).kind) || "developing";
    await enterStage(ctx, run, fresh, firstStatus);
    await wfStore.updateRun(run.id, { status: "running" });
    return;
  }
  // 无可执行任务：若全部 committed/skipped → 进入集成并自动拉起集成角色（跑全量测试并上报）。
  const allDone = tasks.every((t) => ["committed", "skipped"].includes(t.status));
  if (allDone && tasks.length > 0) {
    if (canTransitionRun(run.status, "integrating")) {
      await wfStore.updateRun(run.id, { status: "integrating", currentStageId: "integration", currentTaskId: null });
      await wfStore.appendAudit({ runId: run.id, kind: "ready_for_integration", detail: {} });
      await enterIntegration(ctx, wfStore.getRun(run.id));
    }
  }
}

async function ensureTaskBranch(ctx, run, task) {
  const { wfStore, gitRunner } = ctx;
  if (task.branch || !gitRunner) return { ok: true };
  const useWorktree = !(run.settings && run.settings.useWorktree === false);
  const branch = gitRunner.taskBranchName(run.id, task.id);
  // 以「当前集成基线」为 base，使依赖任务能看到已通过任务的提交，并形成连续提交链（PRD §7.3/§7.6）。
  // 首个任务时 integrationBaseline 即目标分支的 HEAD SHA。
  const base = run.integrationBaseline || run.baseBranch;
  let worktreePath = "";
  try {
    if (useWorktree) {
      worktreePath = path.join(run.repositoryPath || ".", ".acg-worktrees", task.id);
      await gitRunner.createWorktree(run.repositoryPath, { branch, worktreePath, baseBranch: base });
    } else {
      await gitRunner.createTaskBranch(run.repositoryPath, { runId: run.id, taskId: task.id, baseBranch: base });
    }
  } catch (err) {
    // worktree/分支创建失败（路径已存在、分支已存在、base 无效等）：不写入路径、不进入阶段，
    // 否则 PTY 会在不存在或遗留的 cwd 中启动，可能改到错误目录。转人工处理（PRD §7.6/§11）。
    const error = err.message || String(err);
    await wfStore.updateTask(task.id, { status: "blocked" });
    if (canTransitionRun(run.status, "needs_attention")) {
      await wfStore.updateRun(run.id, { status: "needs_attention" });
    }
    await wfStore.appendAudit({ runId: run.id, kind: "branch_failed", detail: { taskId: task.id, error } });
    return { ok: false, error };
  }
  // 记录该任务分支创建时的基线，供后续增量 diff（Review/交接产物）使用。
  await wfStore.updateTask(task.id, { branch, worktreePath, baselineRef: base });
  return { ok: true };
}

/** 进入规划阶段：拉起规划角色会话并注入规划提示词。 */
async function enterPlanning(ctx, run) {
  const { wfStore, ptyMgr } = ctx;
  const snapshot = run.workflowSnapshot;
  const roleId = snapshot.workflow.planningRoleId || "planner";
  const rt = roleRuntime(snapshot, run, roleId);
  // 复用进行中的规划会话（恢复场景幂等），否则新建。
  let session = wfStore.listRoleSessions(run.id).find((s) => s.stageId === "planning" && s.status !== "completed");
  if (!session) {
    session = await wfStore.createRoleSession({ runId: run.id, memberId: rt.memberId, roleId, taskId: null, stageId: "planning" });
  }
  const permissions = rolePermissions(snapshot, roleId);
  const readonly = isReadOnlyRole(permissions);
  ptyMgr.ensureSession({
    runId: run.id,
    execSessionId: session.id,
    runtime: rt.runtime,
    model: rt.model,
    label: `${roleId}:planning`,
    cwd: run.repositoryPath || process.cwd(),
    permissions,
    env: workflowEnv(ctx, run, { roleId, stageId: "planning", execSessionId: session.id, readonly }),
  });
  const preamble = buildRolePreamble({ persona: rt.persona, duty: rt.duty });
  const prompt = buildPlanningPrompt({
    goal: run.goal,
    repositoryPath: run.repositoryPath,
    baseBranch: run.baseBranch,
    stagePrompt: snapshot.prompts && snapshot.prompts.planning,
    detectedTestCommand: (run.settings && run.settings.testCommands && run.settings.testCommands[0]) || "",
  });
  const key = ptyMgr.execKey(run.id, session.id);
  if (ptyMgr.waitForReady) await ptyMgr.waitForReady(key, rt.runtime);
  await ptyMgr.typeInto(key, preamble + prompt, rt.runtime);
  return session;
}

/**
 * 进入最终集成阶段：拉起集成角色会话，注入集成提示词（含运行全量测试并通过 acg stage submit
 * --type integration 上报 {fullTest} 的要求）。集成放行/PR/合并仍走 /integrate（PRD §7.7）。
 */
async function enterIntegration(ctx, run) {
  const { wfStore, ptyMgr } = ctx;
  const snapshot = run.workflowSnapshot;
  const roleId = snapshot.workflow.integrationRoleId || "integrator";
  const rt = roleRuntime(snapshot, run, roleId);
  // 复用进行中的集成会话（恢复场景幂等），否则新建。
  let session = wfStore.listRoleSessions(run.id).find((s) => s.stageId === "integration" && s.status !== "completed");
  if (!session) {
    session = await wfStore.createRoleSession({ runId: run.id, memberId: rt.memberId, roleId, taskId: null, stageId: "integration" });
  }
  const permissions = rolePermissions(snapshot, roleId);
  const readonly = isReadOnlyRole(permissions);
  ptyMgr.ensureSession({
    runId: run.id,
    execSessionId: session.id,
    runtime: rt.runtime,
    model: rt.model,
    label: `${roleId}:integration`,
    cwd: run.repositoryPath || process.cwd(),
    permissions,
    env: workflowEnv(ctx, run, { roleId, stageId: "integration", execSessionId: session.id, readonly }),
  });
  const preamble = buildRolePreamble({ persona: rt.persona, duty: rt.duty });
  const tasks = wfStore.listTasks(run.id).filter((t) => t.status === "committed");
  const prompt = buildIntegrationPrompt({
    goal: run.goal,
    tasks,
    integrationMode: run.integrationMode,
    baseBranch: run.baseBranch,
    fullTestCommand: (run.settings && run.settings.testCommands && run.settings.testCommands[0]) || "",
    stagePrompt: snapshot.prompts && snapshot.prompts.integration,
  });
  const key = ptyMgr.execKey(run.id, session.id);
  if (ptyMgr.waitForReady) await ptyMgr.waitForReady(key, rt.runtime);
  await ptyMgr.typeInto(key, preamble + prompt, rt.runtime);
  return session;
}

/**
 * 依运行当前态恢复执行会话（恢复/重试共用，幂等）：
 * - integrating → 重拉集成角色；
 * - 有当前任务 + 阶段状态 → 重入该阶段（ensureSession 存活复用、已死重建）；
 * - 否则 → 继续调度。
 */
async function reenterCurrent(ctx, run) {
  const { wfStore } = ctx;
  if (!run) return;
  if (run.status === "integrating") {
    await enterIntegration(ctx, run);
    return;
  }
  const task = run.currentTaskId ? wfStore.getTask(run.currentTaskId) : null;
  const stageStatus = task && task.status;
  if (task && stageKindFromStatus(stageStatus)) {
    await enterStage(ctx, run, task, stageStatus);
    return;
  }
  await advanceRun(ctx, run);
}

/**
 * 服务重启恢复：对进行中（running/integrating）的运行从持久化状态 + 交接产物重建当前阶段
 * 执行会话并重注入提示词（PRD §7.6/§10.2）。单个运行恢复失败转 needs_attention，不影响其它。
 */
export async function recoverRuns(ctx) {
  const { wfStore } = ctx;
  const runs = wfStore.listRuns({}).filter((r) => ["running", "integrating"].includes(r.status));
  for (const run of runs) {
    try {
      await wfStore.appendAudit({ runId: run.id, kind: "recovered", detail: { status: run.status, taskId: run.currentTaskId } });
      await reenterCurrent(ctx, wfStore.getRun(run.id));
    } catch (err) {
      if (canTransitionRun(run.status, "needs_attention")) {
        await wfStore.updateRun(run.id, { status: "needs_attention" });
      }
      await wfStore.appendAudit({ runId: run.id, kind: "recover_failed", detail: { error: err.message || String(err) } });
    }
  }
}

async function safeVal(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

// ---- 路由分发 ----

export async function handleWorkflowApi(req, res, ctx) {
  const { wfStore, sendJson, readJson } = ctx;
  const url = new URL(req.url || "/", `http://${req.headers?.host || "local"}`);
  const p = url.pathname;
  const method = req.method;

  if (!p.startsWith("/api/workflow/")) return false;

  // ---- 模板 ----
  if (p === "/api/workflow/templates" && method === "GET") {
    const repoPath = url.searchParams.get("repoPath") || "";
    const { resolved, projectErrors } = await loadResolved(ctx, repoPath);
    const workflows = Object.values(resolved.workflows).map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      version: w.version,
      settings: w.settings,
      taskStages: w.taskStages,
      planningRoleId: w.planningRoleId,
      integrationRoleId: w.integrationRoleId,
      source: (resolved.sources[`workflow:${w.id}`] || {}).source || "内置",
      relativePath: (resolved.sources[`workflow:${w.id}`] || {}).relativePath || null,
    }));
    sendJson(res, 200, { workflows, roles: resolved.roles, errors: projectErrors });
    return true;
  }

  // ---- 创建运行（含启动前预检 PRD §7.1）----
  if (p === "/api/workflow/runs" && method === "POST") {
    const body = await readJson(req);
    const repoPath = body.repositoryPath || "";
    const checks = [];
    const { gitRunner } = ctx;

    if (gitRunner) {
      const isRepo = await safeVal(() => gitRunner.isGitRepo(repoPath), false);
      if (!isRepo) {
        sendJson(res, 400, { error: "仓库路径不是有效的 Git 仓库", code: "not_a_repo" });
        return true;
      }
      const baseExists = body.baseBranch ? await safeVal(() => gitRunner.branchExists(repoPath, body.baseBranch), false) : true;
      if (body.baseBranch && !baseExists) {
        sendJson(res, 400, { error: `目标分支不存在：${body.baseBranch}`, code: "no_base_branch" });
        return true;
      }
      const dirty = await safeVal(() => gitRunner.hasUncommittedChanges(repoPath), false);
      if (dirty) {
        sendJson(res, 409, {
          error: "工作区存在未提交改动。系统不会接管你的改动，请先提交或暂存后再启动运行。",
          code: "dirty_worktree",
        });
        return true;
      }
    }

    // 角色绑定预检（PRD §7.1）：若指定了讨论组成员绑定，校验成员存在且 runtime 可用。
    const roleBindings = (body.settings && body.settings.roleBindings) || {};
    if (Object.keys(roleBindings).length) {
      const group = body.groupId && ctx.discStore ? ctx.discStore.getGroup(body.groupId) : null;
      const memberIds = new Set((group && group.members ? group.members : []).map((mb) => mb.id));
      for (const [roleId, binding] of Object.entries(roleBindings)) {
        if (binding.memberId && body.groupId && ctx.discStore && !memberIds.has(binding.memberId)) {
          sendJson(res, 400, { error: `角色「${roleId}」绑定的成员不存在于讨论组中`, code: "bad_member_binding" });
          return true;
        }
        if (binding.runtime && !ctx.runtimeMeta[binding.runtime]) {
          sendJson(res, 400, { error: `角色「${roleId}」绑定的 runtime 不可用：${binding.runtime}`, code: "bad_runtime_binding" });
          return true;
        }
      }
    }

    // 合成 + 校验所选流程模板。
    const { resolved } = await loadResolved(ctx, repoPath, body.overrides);
    const workflowId = body.workflowTemplateId;
    const valid = validateResolvedWorkflow(resolved, workflowId);
    if (!valid.ok) {
      sendJson(res, 400, { error: valid.errors.join("；"), errors: valid.errors, code: "invalid_workflow" });
      return true;
    }
    let snapshot;
    try {
      snapshot = snapshotTemplates({ resolved, workflowId, overrides: body.overrides });
    } catch (err) {
      sendJson(res, 400, { error: err.message, code: err.code || "snapshot_failed" });
      return true;
    }

    const baseSha = gitRunner ? await safeVal(() => gitRunner.getHeadSha(repoPath, body.baseBranch || "HEAD"), "") : "";
    const run = await wfStore.createRun({
      projectId: body.projectId,
      groupId: body.groupId,
      goal: body.goal,
      repositoryPath: repoPath,
      baseBranch: body.baseBranch,
      integrationMode: snapshot.workflow.settings.integrationMode,
      workflowTemplateId: workflowId,
      workflowSnapshot: snapshot,
      settings: { ...(body.settings || {}), ...(body.overrides ? { overrides: body.overrides } : {}) },
      templateSources: snapshot.sources,
      autoMode: !!body.autoMode,
      status: "planning",
      baseSha,
      integrationBaseline: baseSha,
    });
    await wfStore.appendAudit({ runId: run.id, kind: "created", detail: { workflowId } });
    await enterPlanning(ctx, run);
    sendJson(res, 201, { run });
    return true;
  }

  if (p === "/api/workflow/runs" && method === "GET") {
    const projectId = url.searchParams.get("projectId") || "";
    sendJson(res, 200, { runs: wfStore.listRuns(projectId ? { projectId } : {}) });
    return true;
  }

  // ---- 单运行读取 ----
  let m = p.match(/^\/api\/workflow\/runs\/([^/]+)$/);
  if (m && method === "GET") {
    const runId = decodeURIComponent(m[1]);
    const run = wfStore.getRun(runId);
    if (!run) {
      sendJson(res, 404, { error: "运行不存在" });
      return true;
    }
    sendJson(res, 200, {
      run,
      tasks: wfStore.listTasks(runId),
      roleSessions: wfStore.listRoleSessions(runId),
      handoffs: wfStore.listHandoffs(runId),
      stageResults: wfStore.listStageResults(runId),
      audit: wfStore.listAudit(runId),
    });
    return true;
  }

  // ---- 计划提交（规划角色 acg stage submit --type plan，或 UI）----
  m = p.match(/^\/api\/workflow\/runs\/([^/]+)\/plan$/);
  if (m && method === "POST") {
    const runId = decodeURIComponent(m[1]);
    const body = await readJson(req);
    const run = wfStore.getRun(runId);
    if (!run) {
      sendJson(res, 404, { error: "运行不存在" });
      return true;
    }
    const check = validatePlan(body.tasks);
    if (!check.ok) {
      sendJson(res, 400, { error: check.errors.join("；"), errors: check.errors });
      return true;
    }
    const tasks = await wfStore.replacePlan(runId, body.tasks);
    const updated = await wfStore.updateRun(runId, { status: "awaiting_plan_approval" });
    await wfStore.appendAudit({ runId, kind: "plan_submitted", detail: { count: tasks.length } });
    // 关闭规划会话。
    const planSession = wfStore.listRoleSessions(runId).find((s) => s.stageId === "planning" && s.status !== "completed");
    if (planSession) {
      await wfStore.closeRoleSession(planSession.id);
      ctx.ptyMgr && ctx.ptyMgr.closeSession(runId, planSession.id);
    }
    sendJson(res, 200, { run: updated, tasks });
    return true;
  }

  // ---- 计划确认（用户，可编辑）----
  m = p.match(/^\/api\/workflow\/runs\/([^/]+)\/plan\/approve$/);
  if (m && method === "POST") {
    const runId = decodeURIComponent(m[1]);
    const body = await readJson(req);
    const run = wfStore.getRun(runId);
    if (!run) {
      sendJson(res, 404, { error: "运行不存在" });
      return true;
    }
    if (Array.isArray(body.tasks)) {
      const check = validatePlan(body.tasks);
      if (!check.ok) {
        sendJson(res, 400, { error: check.errors.join("；"), errors: check.errors });
        return true;
      }
      await wfStore.replacePlan(runId, body.tasks);
    }
    await wfStore.updateRun(runId, { status: "running" });
    await wfStore.appendAudit({ runId, kind: "plan_approved", detail: {} });
    await advanceRun(ctx, wfStore.getRun(runId));
    sendJson(res, 200, {
      run: wfStore.getRun(runId),
      tasks: wfStore.listTasks(runId),
    });
    return true;
  }

  // ---- 阶段结果提交（核心交接端点）----
  m = p.match(/^\/api\/workflow\/runs\/([^/]+)\/stage$/);
  if (m && method === "POST") {
    const runId = decodeURIComponent(m[1]);
    const body = await readJson(req);
    const run = wfStore.getRun(runId);
    if (!run) {
      sendJson(res, 404, { error: "运行不存在" });
      return true;
    }
    return handleStageSubmit(ctx, res, run, body);
  }

  // ---- 暂停 / 恢复 / 终止 ----
  m = p.match(/^\/api\/workflow\/runs\/([^/]+)\/(pause|resume|terminate)$/);
  if (m && method === "POST") {
    const runId = decodeURIComponent(m[1]);
    const action = m[2];
    const run = wfStore.getRun(runId);
    if (!run) {
      sendJson(res, 404, { error: "运行不存在" });
      return true;
    }
    if (action === "pause") {
      if (!canTransitionRun(run.status, "paused")) {
        sendJson(res, 409, { error: `当前状态 ${run.status} 无法暂停` });
        return true;
      }
      // 记录暂停前状态，恢复时回到原阶段（如 integrating），避免卡在无当前任务的 running。
      const updated = await wfStore.updateRun(runId, { status: "paused", pausedFrom: run.status });
      await wfStore.appendAudit({ runId, kind: "paused", detail: { from: run.status } });
      sendJson(res, 200, { run: updated, resumePoint: { taskId: run.currentTaskId, stageId: run.currentStageId } });
      return true;
    }
    if (action === "resume") {
      // 允许从安全暂停（paused）与人工处理（needs_attention）恢复（PRD §10.2）。
      if (!["paused", "needs_attention"].includes(run.status)) {
        sendJson(res, 409, { error: `当前状态 ${run.status} 无法恢复` });
        return true;
      }
      // paused：回到暂停前合法状态（默认 running）；needs_attention：恢复为 running。
      const target =
        run.status === "paused" && run.pausedFrom && canTransitionRun("paused", run.pausedFrom)
          ? run.pausedFrom
          : "running";
      if (!canTransitionRun(run.status, target)) {
        sendJson(res, 409, { error: `当前状态 ${run.status} 无法恢复为 ${target}` });
        return true;
      }
      const updated = await wfStore.updateRun(runId, { status: target, pausedFrom: null });
      await wfStore.appendAudit({ runId, kind: "resumed", detail: { taskId: run.currentTaskId, stageId: run.currentStageId, from: run.status, to: target } });
      // 重建当前阶段执行会话并重注入提示词（暂停/中断期间 PTY 可能已结束）。
      await reenterCurrent(ctx, wfStore.getRun(runId));
      sendJson(res, 200, { run: wfStore.getRun(runId), resumeNote: `将从任务 ${run.currentTaskId || "(规划)"} / 阶段 ${run.currentStageId} 继续` });
      return true;
    }
    // terminate：保留分支/提交/记录；kill 全部执行会话（PRD §10.2）。
    if (ctx.ptyMgr) ctx.ptyMgr.closeRun(runId);
    const updated = await wfStore.updateRun(runId, { status: "terminated" });
    await wfStore.appendAudit({ runId, kind: "terminated", detail: { keepBranches: true } });
    sendJson(res, 200, { run: updated });
    return true;
  }

  // ---- 跳过任务 ----
  m = p.match(/^\/api\/workflow\/runs\/([^/]+)\/tasks\/([^/]+)\/skip$/);
  if (m && method === "POST") {
    const runId = decodeURIComponent(m[1]);
    const taskId = decodeURIComponent(m[2]);
    const run = wfStore.getRun(runId);
    const task = wfStore.getTask(taskId);
    if (!run || !task) {
      sendJson(res, 404, { error: "运行或任务不存在" });
      return true;
    }
    const affected = dependentsOf(wfStore.listTasks(runId), taskId);
    await wfStore.updateTask(taskId, { status: "skipped" });
    await wfStore.appendAudit({ runId, kind: "task_skipped", detail: { taskId, affected } });

    // 跳过的是当前任务：清空当前任务并关闭其执行会话，再继续调度（避免卡在指向已跳过任务的 running）。
    const cur = wfStore.getRun(runId);
    if (cur.currentTaskId === taskId) {
      const sess = wfStore.findActiveTaskSession(runId, taskId);
      if (sess) {
        await wfStore.closeRoleSession(sess.id);
        if (ctx.ptyMgr) ctx.ptyMgr.closeSession(runId, sess.id);
      }
      await wfStore.updateRun(runId, { currentTaskId: null, currentStageId: null });
    }
    await advanceRun(ctx, wfStore.getRun(runId));
    sendJson(res, 200, { ok: true, affected, run: wfStore.getRun(runId) });
    return true;
  }

  // ---- 人工接管：重试当前阶段（PRD §10.2）----
  m = p.match(/^\/api\/workflow\/runs\/([^/]+)\/retry$/);
  if (m && method === "POST") {
    const runId = decodeURIComponent(m[1]);
    const run = wfStore.getRun(runId);
    if (!run) {
      sendJson(res, 404, { error: "运行不存在" });
      return true;
    }
    if (!["needs_attention", "running", "integrating"].includes(run.status)) {
      sendJson(res, 409, { error: `当前状态 ${run.status} 无法重试`, code: "not_retryable" });
      return true;
    }
    if (run.status === "needs_attention") {
      await wfStore.updateRun(runId, { status: "running" });
    }
    await wfStore.appendAudit({ runId, kind: "stage_retried", detail: { taskId: run.currentTaskId, stageId: run.currentStageId } });
    await reenterCurrent(ctx, wfStore.getRun(runId));
    sendJson(res, 200, { ok: true, run: wfStore.getRun(runId) });
    return true;
  }

  // ---- 人工接管：退回开发（携可选结构化问题，仿 Review 打回路径）----
  m = p.match(/^\/api\/workflow\/runs\/([^/]+)\/tasks\/([^/]+)\/rewind-dev$/);
  if (m && method === "POST") {
    const runId = decodeURIComponent(m[1]);
    const taskId = decodeURIComponent(m[2]);
    const body = await readJson(req);
    const run = wfStore.getRun(runId);
    const task = wfStore.getTask(taskId);
    if (!run || !task) {
      sendJson(res, 404, { error: "运行或任务不存在" });
      return true;
    }
    if (run.status === "needs_attention") {
      await wfStore.updateRun(runId, { status: "running" });
    }
    await wfStore.appendAudit({ runId, kind: "rewind_dev", detail: { taskId, findings: (body.findings || []).length } });
    await enterStage(ctx, wfStore.getRun(runId), wfStore.getTask(taskId), "developing", {
      fix: true,
      findings: body.findings || [],
    });
    sendJson(res, 200, { ok: true, run: wfStore.getRun(runId), task: wfStore.getTask(taskId) });
    return true;
  }

  // ---- 人工接管：提升 Review 重试上限，让达上限任务可继续 ----
  m = p.match(/^\/api\/workflow\/runs\/([^/]+)\/raise-retry-limit$/);
  if (m && method === "POST") {
    const runId = decodeURIComponent(m[1]);
    const body = await readJson(req);
    const run = wfStore.getRun(runId);
    if (!run) {
      sendJson(res, 404, { error: "运行不存在" });
      return true;
    }
    const snapshotMax = (run.workflowSnapshot.workflow.settings && run.workflowSnapshot.workflow.settings.maxReviewRounds) || 3;
    const currentMax = (run.settings && run.settings.overrides && run.settings.overrides.maxReviewRounds) || snapshotMax;
    const nextMax = Number(body.maxReviewRounds) > 0 ? Number(body.maxReviewRounds) : currentMax + 1;
    const overrides = { ...((run.settings && run.settings.overrides) || {}), maxReviewRounds: nextMax };
    await wfStore.updateRun(runId, { settings: { ...(run.settings || {}), overrides } });
    await wfStore.appendAudit({ runId, kind: "retry_limit_raised", detail: { from: currentMax, to: nextMax } });
    sendJson(res, 200, { ok: true, run: wfStore.getRun(runId), maxReviewRounds: nextMax });
    return true;
  }

  // ---- 最终集成（PRD §7.7）----
  m = p.match(/^\/api\/workflow\/runs\/([^/]+)\/integrate$/);
  if (m && method === "POST") {
    const runId = decodeURIComponent(m[1]);
    const body = await readJson(req);
    const run = wfStore.getRun(runId);
    if (!run) {
      sendJson(res, 404, { error: "运行不存在" });
      return true;
    }
    return handleIntegrate(ctx, res, run, body);
  }

  return false;
}

// ---- 阶段提交处理 ----

async function handleStageSubmit(ctx, res, run, body) {
  const { wfStore, sendJson } = ctx;
  const snapshot = run.workflowSnapshot;
  const type = body.type;
  const kind = SUBMIT_TYPE_TO_KIND[type];
  const roleId = body.roleId || "";
  const payload = body.payload || {};

  // 安全暂停 / 人工处理 / 终止等状态下，拒绝任何阶段提交：否则暂停时仍在工作的角色 PTY
  // 之后调用 acg stage submit 仍会被接受并继续推进，使「安全暂停」失效（PRD §10.2）。
  const HALTED_RUN_STATUSES = ["paused", "needs_attention", "terminated", "completed", "failed", "draft"];
  if (HALTED_RUN_STATUSES.includes(run.status)) {
    await wfStore.appendAudit({ runId: run.id, kind: "rejected_transition", detail: { type, reason: `运行状态 ${run.status} 不接受提交` } });
    sendJson(res, 409, { error: `当前运行状态为「${run.status}」，自动流程已暂停，不接受阶段提交`, code: "run_not_active" });
    return true;
  }

  // plan → 走计划提交。
  if (kind === "planning") {
    const check = validatePlan(payload.tasks || body.tasks);
    if (!check.ok) {
      sendJson(res, 400, { error: check.errors.join("；"), errors: check.errors });
      return true;
    }
    const tasks = await wfStore.replacePlan(run.id, payload.tasks || body.tasks);
    await wfStore.updateRun(run.id, { status: "awaiting_plan_approval" });
    await wfStore.appendAudit({ runId: run.id, kind: "plan_submitted", detail: { count: tasks.length } });
    sendJson(res, 200, { ok: true, run: wfStore.getRun(run.id), tasks });
    return true;
  }

  const integrationRoleId = snapshot.workflow.integrationRoleId || "integrator";

  // integration → 仅集成角色，记录集成报告（实际 PR/合并走 /integrate）。
  if (kind === "integration") {
    const check = validateStageSubmission({ snapshot, task: null, type, roleId, payload, integrationRoleId });
    if (!check.ok) {
      await wfStore.appendAudit({ runId: run.id, kind: "rejected_transition", detail: { type, reason: check.error } });
      sendJson(res, 409, { error: check.error, code: check.code });
      return true;
    }
    await wfStore.appendStageResult({ runId: run.id, taskId: null, stageId: "integration", roleId, type, payload });
    sendJson(res, 200, { ok: true, recorded: true });
    return true;
  }

  // 任务阶段提交。
  const taskId = body.taskId || run.currentTaskId;
  const task = taskId ? wfStore.getTask(taskId) : null;
  // 优先用人工接管提升后的重试上限（run.settings.overrides），否则用模板快照默认值。
  const maxReviewRounds =
    (run.settings && run.settings.overrides && run.settings.overrides.maxReviewRounds) ||
    snapshot.workflow.settings.maxReviewRounds;

  const check = validateStageSubmission({ snapshot, task, type, roleId, payload, integrationRoleId, maxReviewRounds });
  if (!check.ok) {
    await wfStore.appendAudit({ runId: run.id, kind: "rejected_transition", detail: { taskId, type, reason: check.error } });
    sendJson(res, 409, { error: check.error, code: check.code });
    return true;
  }

  await wfStore.appendStageResult({ runId: run.id, taskId, stageId: stageKindFromStatus(task.stage), roleId, type, payload });

  const nextStatus = nextStage(snapshot, task, payload);
  const curKind = stageKindFromStatus(task.stage);

  // 门槛失败：回退开发（fixing）。
  if (nextStatus === "developing" && (curKind === "review" || curKind === "testing")) {
    const round = applyReviewRound(task, payload, maxReviewRounds);
    await wfStore.updateTask(task.id, { reviewRounds: round.reviewRounds, lastFindingIds: round.prevFindingIds });
    if (round.atLimit) {
      await wfStore.updateTask(task.id, { status: "blocked" });
      await wfStore.updateRun(run.id, { status: "needs_attention" });
      await wfStore.appendAudit({ runId: run.id, kind: "retry_exhausted", detail: { taskId, rounds: round.reviewRounds } });
      sendJson(res, 200, {
        ok: true,
        needsAttention: true,
        message: `任务已达最大重试轮次（${maxReviewRounds}），转人工处理。`,
        run: wfStore.getRun(run.id),
        task: wfStore.getTask(task.id),
      });
      return true;
    }
    const freshTask = wfStore.getTask(task.id);
    const r = await enterStage(ctx, run, freshTask, "developing", {
      fix: true,
      findings: payload.findings || [],
      repeatedFindingIds: round.repeatedFindingIds,
    });
    sendJson(res, 200, {
      ok: true,
      bounced: true,
      lastRoundWarning: round.lastRoundWarning,
      delivered: r.delivered,
      run: wfStore.getRun(run.id),
      task: wfStore.getTask(task.id),
    });
    return true;
  }

  // 走完全部阶段 → approved → 提交。
  if (nextStatus === "approved") {
    await wfStore.updateTask(task.id, { status: "approved", stage: "approved" });
    const committed = await commitTask(ctx, run, wfStore.getTask(task.id));
    if (!committed.ok) {
      sendJson(res, 200, {
        ok: true,
        needsAttention: true,
        message: `任务提交失败，已转人工处理：${committed.error}`,
        run: wfStore.getRun(run.id),
        task: wfStore.getTask(task.id),
      });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      committed: true,
      run: wfStore.getRun(run.id),
      task: wfStore.getTask(task.id),
      tasks: wfStore.listTasks(run.id),
    });
    return true;
  }

  // 进入下一阶段（review/testing）。
  const freshTask = wfStore.getTask(task.id);
  const r = await enterStage(ctx, run, freshTask, nextStatus, { devResult: payload, diffSummary: payload.changeSummary });
  sendJson(res, 200, {
    ok: true,
    advanced: true,
    nextStage: nextStatus,
    delivered: r.delivered,
    run: wfStore.getRun(run.id),
    task: wfStore.getTask(task.id),
  });
  return true;
}

// ---- 集成处理 ----

async function handleIntegrate(ctx, res, run, body) {
  const { wfStore, gitRunner, sendJson } = ctx;
  const tasks = wfStore.listTasks(run.id);
  const handoffs = wfStore.listHandoffs(run.id);

  // 漂移检测。
  let driftState = { drifted: false };
  if (gitRunner) {
    driftState = await safeVal(
      () => gitRunner.detectBaseBranchDrift(run.repositoryPath, { baseBranch: run.baseBranch, recordedSha: run.baseSha }),
      { drifted: false },
    );
  }

  // 全量测试结果：优先 body.fullTestResult；否则取集成角色上报的最近一次。
  let fullTestResult = body.fullTestResult;
  if (!fullTestResult) {
    const integ = [...wfStore.listStageResults(run.id)].reverse().find((r) => r.type === "integration");
    fullTestResult = integ && integ.payload && integ.payload.fullTest;
  }

  const guard = evaluateIntegrationGuard({
    run,
    tasks,
    handoffs,
    fullTestResult,
    driftState,
    confirmations: { directMergeConfirmed: !!body.confirm },
  });
  if (!guard.ok) {
    await wfStore.appendAudit({ runId: run.id, kind: "integration_blocked", detail: { blockers: guard.blockers } });
    sendJson(res, 409, { error: "集成被阻止", blockers: guard.blockers });
    return true;
  }

  // 受保护分支不得直接合并。
  if (run.integrationMode === "direct_merge" && gitRunner && gitRunner.isProtectedBranch(run.baseBranch)) {
    sendJson(res, 409, { error: `目标分支 ${run.baseBranch} 受保护，禁止直接合并`, code: "protected" });
    return true;
  }

  // 集成头分支：最后一个已提交任务的分支（因依赖任务基于集成基线串联，它含完整提交链）。
  const lastCommitted = [...tasks].reverse().find((t) => t.status === "committed");
  const headBranch = lastCommitted ? gitRunner && gitRunner.taskBranchName(run.id, lastCommitted.id) : null;

  let result;
  if (run.integrationMode === "direct_merge") {
    if (!headBranch) {
      sendJson(res, 409, { error: "没有可集成的已提交任务分支", code: "nothing_to_merge" });
      return true;
    }
    result = gitRunner
      ? await gitRunner.merge(run.repositoryPath, { branch: headBranch, into: run.baseBranch, confirm: true })
      : { ok: true };
  } else {
    result = gitRunner
      ? await gitRunner.createPullRequest(run.repositoryPath, {
          title: `自动开发：${run.goal}`,
          body: body.prBody || `运行 ${run.id} 的自动开发结果`,
          base: run.baseBranch,
          head: headBranch || run.baseBranch,
        })
      : { ok: true };
  }

  if (result && result.ok === false && !result.degraded) {
    sendJson(res, 409, { error: result.message || "集成失败", result });
    return true;
  }

  const updated = await wfStore.updateRun(run.id, { status: "completed" });
  await wfStore.appendAudit({ runId: run.id, kind: "integrated", detail: { mode: run.integrationMode, result } });
  sendJson(res, 200, { ok: true, run: updated, result });
  return true;
}
