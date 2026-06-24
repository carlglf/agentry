// 自动开发编排（流程运行）纯逻辑引擎：任务调度 + 阶段状态机 + 非法迁移拒绝
// + 重试上限 + 上下文裁剪 + 集成放行校验 + 运行状态机。
// 零 I/O 纯函数（不接触 PTY / HTTP / fs / git），可被 Vitest 直接单测。
// 与讨论组 discussion-engine.mjs 风格一致：校验类函数返回 { ok, error?, code? }。

// ---- 状态常量 ----

// 运行级状态（PRD §8.1）。
export const RUN_STATUSES = [
  "draft",
  "planning",
  "awaiting_plan_approval",
  "running",
  "paused",
  "needs_attention",
  "integrating",
  "completed",
  "failed",
  "terminated",
];

// 任务级状态（PRD §8.1）。blocked = needs_attention（达上限/失败转人工）。
export const TASK_STATUSES = [
  "pending",
  "developing",
  "reviewing",
  "testing",
  "documenting",
  "approved",
  "committed",
  "blocked",
  "skipped",
  "failed",
];

// 阶段「种类」→ 任务状态名 的映射。
const KIND_TO_STATUS = {
  development: "developing",
  review: "reviewing",
  testing: "testing",
  doc: "documenting",
};
const STATUS_TO_KIND = Object.fromEntries(
  Object.entries(KIND_TO_STATUS).map(([k, v]) => [v, k]),
);

// 阶段种类语义：produce = 产出型（提交即推进，如开发/文档）；gate = 门槛型（通过推进、失败回退）。
const GATE_KINDS = new Set(["review", "testing"]);

// 提交类型（acg stage submit --type）→ 阶段种类。plan / integration 为运行级，非任务阶段。
export const SUBMIT_TYPE_TO_KIND = {
  plan: "planning",
  dev: "development",
  review: "review",
  test: "testing",
  doc: "doc",
  integration: "integration",
};

/** 任务阶段种类是否为门槛型。 */
export function isGateKind(kind) {
  return GATE_KINDS.has(kind);
}

/** 由任务状态名取阶段种类（developing→development 等）。 */
export function stageKindFromStatus(status) {
  return STATUS_TO_KIND[status] || null;
}

/** 由阶段种类取任务状态名（development→developing 等）。 */
export function statusFromStageKind(kind) {
  return KIND_TO_STATUS[kind] || null;
}

// ---- 工具 ----

/** 计算下一条 append-only 记录的 seq（按集合单调递增）。 */
export function nextSeq(items) {
  const list = Array.isArray(items) ? items : [];
  let max = 0;
  for (const it of list) {
    if (it && it.seq > max) max = it.seq;
  }
  return max + 1;
}

/** 读取一个流程模板快照里有序的「任务阶段」列表。 */
export function taskStagesOf(snapshot) {
  const stages = snapshot && snapshot.workflow && snapshot.workflow.taskStages;
  return Array.isArray(stages) ? stages : [];
}

function firstDevelopmentStatus(stages) {
  const dev = stages.find((s) => s && s.kind === "development");
  return dev ? statusFromStageKind(dev.kind) : "developing";
}

/** 首个 development 阶段对象（门槛失败的回退落点）。无则回退到第一个阶段。 */
export function firstDevelopmentStage(stages) {
  return stages.find((s) => s && s.kind === "development") || stages[0] || null;
}

/**
 * 定位任务当前所处阶段的下标。优先用 task.stageId（支持同 kind 多阶段，如客户端开发/服务端开发），
 * 回退到由任务状态推 kind（旧行为，内置流程 kind 唯一时完全等价）。未进入任何阶段返回 -1。
 */
export function currentStageIndex(snapshot, task) {
  const stages = taskStagesOf(snapshot);
  const stageId = task && task.stageId;
  if (stageId) {
    const i = stages.findIndex((s) => s && s.id === stageId);
    if (i !== -1) return i;
  }
  const curKind = stageKindFromStatus(task && (task.stage || task.status));
  return stages.findIndex((s) => s && s.kind === curKind);
}

// ---- 计划与调度（PRD §5.6 / §7.2 / §7.3）----

/**
 * 校验规划阶段产出的结构化任务列表：id 唯一、依赖引用存在、无环。
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePlan(tasks) {
  const errors = [];
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length < 1) errors.push("计划至少需要一个子任务");

  const ids = new Set();
  for (const t of list) {
    const id = String(t?.id || "").trim();
    if (!id) {
      errors.push("子任务缺少 id");
      continue;
    }
    if (ids.has(id)) errors.push(`子任务 id 重复：${id}`);
    ids.add(id);
    if (!String(t?.title || "").trim()) errors.push(`子任务「${id}」缺少标题`);
  }

  for (const t of list) {
    for (const dep of Array.isArray(t?.dependencies) ? t.dependencies : []) {
      if (!ids.has(dep)) errors.push(`子任务「${t.id}」依赖了不存在的任务：${dep}`);
    }
  }

  if (errors.length === 0 && hasCycle(list)) {
    errors.push("子任务依赖存在环，无法确定执行顺序");
  }

  return { ok: errors.length === 0, errors };
}

function hasCycle(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map(); // id -> 0 visiting, 1 done
  const visit = (id) => {
    if (state.get(id) === 1) return false;
    if (state.get(id) === 0) return true; // 回边
    state.set(id, 0);
    const t = byId.get(id);
    for (const dep of (t && t.dependencies) || []) {
      if (byId.has(dep) && visit(dep)) return true;
    }
    state.set(id, 1);
    return false;
  };
  for (const t of tasks) {
    if (visit(t.id)) return true;
  }
  return false;
}

/**
 * 串行调度：返回下一个可执行任务（依赖全部 committed 且自身为 pending）。
 * 无可执行任务返回 null。跳过(skipped)任务视为不可作为依赖满足来源（其下游需人工处理）。
 */
export function pickNextTask(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const byId = new Map(list.map((t) => [t.id, t]));
  // 已有进行中的任务则不再开新任务（首版串行，PRD §5.6）。
  const active = list.find((t) =>
    ["developing", "reviewing", "testing", "documenting", "approved"].includes(t.status),
  );
  if (active) return null;
  for (const t of list) {
    if (t.status !== "pending") continue;
    const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
    const ok = deps.every((d) => {
      const dep = byId.get(d);
      return dep && dep.status === "committed";
    });
    if (ok) return t;
  }
  return null;
}

/** 跳过某任务后，列出依赖它（直接/间接）因而无法满足依赖的下游任务 id。 */
export function dependentsOf(tasks, taskId) {
  const list = Array.isArray(tasks) ? tasks : [];
  const result = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of list) {
      const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
      if (deps.some((d) => d === taskId || result.has(d)) && !result.has(t.id)) {
        result.add(t.id);
        changed = true;
      }
    }
  }
  return [...result];
}

// ---- 任务阶段状态机（PRD §8.1）----

/**
 * 给定当前任务与本阶段结构化结果，计算任务下一个状态。
 * - produce 阶段（开发/文档）：提交即推进到下一阶段；
 * - gate 阶段（review/testing）：通过推进，失败回退到开发（fixing）；
 * - 走完全部阶段后置 approved（待提交集成基线）。
 * @returns {string} 下一任务状态名
 */
export function nextStage(snapshot, task, result) {
  const d = nextStageDescriptor(snapshot, task, result);
  if (d.done) return "approved";
  return statusFromStageKind(d.stage.kind);
}

/**
 * 按阶段 id 推进的「下一步」描述（支持同 kind 多阶段）：
 * - `{ done: true }`：走完全部阶段 → approved → 提交；
 * - `{ fix: true, stage }`：门槛（review/testing）未过 → 回退到首个 development 阶段（fixing）；
 * - `{ stage }`：进入下一个阶段（含同为开发的串联阶段，如客户端→服务端）。
 * stage 为快照中的阶段对象 { id, kind, roleId }，调用方据此解析每阶段独立角色。
 */
export function nextStageDescriptor(snapshot, task, result) {
  const stages = taskStagesOf(snapshot);
  if (stages.length === 0) return { done: true };
  const idx = currentStageIndex(snapshot, task);
  if (idx === -1) {
    // 尚未进入任何阶段：从第一个阶段开始。
    return { stage: stages[0] };
  }
  const stage = stages[idx];
  if (isGateKind(stage.kind) && !isStagePass(stage.kind, result)) {
    return { fix: true, stage: firstDevelopmentStage(stages) };
  }
  const next = stages[idx + 1];
  return next ? { stage: next } : { done: true };
}

/** 门槛阶段结果是否通过。 */
export function isStagePass(kind, result) {
  if (!result) return false;
  if (kind === "review") return result.verdict === "approved";
  if (kind === "testing") {
    if (typeof result.passed === "boolean") return result.passed;
    return result.verdict === "approved" || result.exitCode === 0;
  }
  return true;
}

// ---- 非法迁移拒绝（PRD §8.3，核心）----

/**
 * 校验一次阶段结果提交是否合法。不合法时返回可读中文原因。
 * @param {object} args
 * @param {object} args.snapshot  运行模板快照
 * @param {object} args.task      当前任务（含 stage/status/reviewRounds）
 * @param {string} args.type      提交类型 plan|dev|review|test|doc|integration
 * @param {string} args.roleId    提交者角色 id
 * @param {object} args.payload   结构化结果
 * @param {string} [args.integrationRoleId] 允许执行集成/合并的角色 id
 * @param {number} [args.maxReviewRounds]
 * @returns {{ ok: boolean, error?: string, code?: string }}
 */
export function validateStageSubmission({
  snapshot,
  task,
  type,
  roleId,
  payload,
  integrationRoleId,
  maxReviewRounds,
}) {
  const kind = SUBMIT_TYPE_TO_KIND[type];
  if (!kind) {
    return { ok: false, code: "unknown_type", error: `未知的阶段结果类型：${type}` };
  }

  // 集成（最终合并）：仅集成角色可执行（PRD §8.3 / §12）。
  if (kind === "integration") {
    if (integrationRoleId && roleId && roleId !== integrationRoleId) {
      return {
        ok: false,
        code: "not_integrator",
        error: "非集成角色不能执行最终集成/合并",
      };
    }
    return { ok: true };
  }

  // plan 为运行级，单独走计划提交路径。
  if (kind === "planning") return { ok: true };

  if (!task) {
    return { ok: false, code: "no_task", error: "当前没有可提交的任务" };
  }

  // 已转人工处理的任务不接受自动阶段提交（PRD §11）。
  if (task.status === "blocked") {
    return { ok: false, code: "needs_attention", error: "任务已转入人工处理，自动流程已暂停" };
  }
  if (["committed", "skipped", "failed"].includes(task.status)) {
    return { ok: false, code: "task_closed", error: `任务当前状态为 ${task.status}，不能再提交阶段结果` };
  }

  // 提交的阶段种类必须与任务当前阶段一致——防止跳过 Review、Review 未过进测试/提交等（PRD §8.3）。
  // 当前阶段优先由 task.stageId 定位（支持同 kind 多阶段），回退到由状态推 kind。
  const curIdx = currentStageIndex(snapshot, task);
  const curStage = curIdx >= 0 ? taskStagesOf(snapshot)[curIdx] : null;
  const expectedKind = curStage ? curStage.kind : stageKindFromStatus(task.stage || task.status);
  if (expectedKind && kind !== expectedKind) {
    return {
      ok: false,
      code: "wrong_stage",
      error: `当前流程要求先完成「${stageLabel(expectedKind)}」阶段，不能直接提交「${stageLabel(kind)}」结果`,
    };
  }

  // 提交者角色必须是该阶段在流程模板中的执行角色——防止开发会话在进入 Review/测试后仍存活时，
  // 主动调用 acg stage submit --type review/test 自评通过，绕过独立 Review/测试门槛（PRD §8.3）。
  // 同 kind 多阶段时，以当前阶段（curStage）的角色为准，而非按 kind 取首个。
  const stageDef = curStage && curStage.kind === kind ? curStage : (snapshot?.workflow?.taskStages || []).find((s) => s.kind === kind);
  if (stageDef && stageDef.roleId && roleId && roleId !== stageDef.roleId) {
    return {
      ok: false,
      code: "wrong_role",
      error: `「${stageLabel(kind)}」阶段应由角色「${stageDef.roleId}」提交，当前角色「${roleId}」无权提交`,
    };
  }

  // 测试失败却标记任务通过（payload 自称 passed 但实际 exitCode≠0）——拒绝静默忽略失败（PRD §7.5）。
  if (kind === "testing" && payload) {
    const claimsPass = payload.verdict === "approved" || payload.passed === true;
    const hasExit = payload.exitCode !== undefined && payload.exitCode !== null;
    const hardFail = (hasExit && Number(payload.exitCode) !== 0) || Number(payload.failed) > 0;
    if (claimsPass && hardFail) {
      return {
        ok: false,
        code: "test_contradiction",
        error: "测试存在失败用例或非零退出码，不能标记为通过",
      };
    }
  }

  // 超过最大重试轮次仍尝试继续自动 fixing 循环——拒绝（PRD §8.3 / §7.4）。
  if (isGateKind(kind) && !isStagePass(kind, payload)) {
    const cap = Number(maxReviewRounds || (snapshot?.workflow?.settings?.maxReviewRounds) || 0);
    const rounds = Number(task.reviewRounds || 0);
    if (cap > 0 && rounds >= cap) {
      return {
        ok: false,
        code: "retry_exhausted",
        error: `已达到最大重试轮次（${cap}），不能继续自动循环，请人工处理`,
      };
    }
  }

  return { ok: true };
}

function stageLabel(kind) {
  return (
    {
      planning: "规划",
      development: "开发",
      review: "Review",
      testing: "测试",
      doc: "文档",
      integration: "集成",
    }[kind] || kind
  );
}

// ---- 重试计数与预警（PRD §7.4）----

/**
 * 处理一次门槛失败（review changes_requested/failed 或 testing failed）的重试计数。
 * 每「打回一次」reviewRounds +1；到上限前一轮置 lastRoundWarning；
 * 同一 finding id 连续两轮未关闭则计入 repeatedFindingIds（高亮）。
 * @returns {{ reviewRounds, atLimit, lastRoundWarning, repeatedFindingIds, prevFindingIds }}
 */
export function applyReviewRound(task, result, maxReviewRounds) {
  const cap = Number(maxReviewRounds || 0);
  const reviewRounds = Number(task.reviewRounds || 0) + 1;
  const atLimit = cap > 0 && reviewRounds >= cap;
  const lastRoundWarning = cap > 0 && reviewRounds === cap - 1;

  const prev = Array.isArray(task.lastFindingIds) ? task.lastFindingIds : [];
  const cur = (Array.isArray(result?.findings) ? result.findings : [])
    .map((f) => String(f?.id || "").trim())
    .filter(Boolean);
  const repeatedFindingIds = cur.filter((id) => prev.includes(id));

  return { reviewRounds, atLimit, lastRoundWarning, repeatedFindingIds, prevFindingIds: cur };
}

// ---- 上下文裁剪（PRD §7.3，类比讨论组 computeDelta）----

/**
 * 为某任务的开发会话构建「最小注入上下文」：总目标 + 当前任务对象 + 集成基线/分支/worktree
 * + 仅与本任务相关的依赖任务交接产物（不回灌全历史/全 diff/全终端）+ 验收标准/范围/禁改/建议测试。
 */
export function computeTaskContext({ run, task, allTasks, handoffs }) {
  const tasks = Array.isArray(allTasks) ? allTasks : [];
  const arts = Array.isArray(handoffs) ? handoffs : [];
  const relevantTaskIds = collectDependencyIds(tasks, task);
  const relevantHandoffs = arts
    .filter((h) => relevantTaskIds.has(h.taskId))
    .map((h) => ({
      taskId: h.taskId,
      commitSha: h.commitSha,
      changeSummary: h.changeSummary,
      changedInterfaces: h.changedInterfaces || [],
      decisions: h.decisions || [],
      changedFiles: h.changedFiles || [],
    }));

  return {
    goal: run?.goal || "",
    integrationBaseline: run?.integrationBaseline || run?.baseBranch || "",
    baseBranch: run?.baseBranch || "",
    branch: task?.branch || "",
    worktree: task?.worktreePath || "",
    task: {
      id: task?.id,
      title: task?.title,
      objective: task?.objective || "",
      scope: task?.scope || [],
      forbiddenChanges: task?.forbiddenChanges || [],
      acceptanceCriteria: task?.acceptanceCriteria || [],
      suggestedTests: task?.suggestedTests || [],
      expectedFiles: task?.expectedFiles || [],
      dependencies: task?.dependencies || [],
    },
    dependencyHandoffs: relevantHandoffs,
  };
}

function collectDependencyIds(tasks, task) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Set();
  const stack = [...((task && task.dependencies) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    const t = byId.get(id);
    for (const d of (t && t.dependencies) || []) stack.push(d);
  }
  return out;
}

// ---- 集成放行校验（PRD §7.7）----

/**
 * 评估最终集成是否可放行。任一阻断项存在即禁止集成（PRD §7.7 / §15.4.5）。
 * @returns {{ ok: boolean, blockers: string[] }}
 */
export function evaluateIntegrationGuard({ run, tasks, handoffs, fullTestResult, driftState, confirmations }) {
  const blockers = [];
  const list = Array.isArray(tasks) ? tasks : [];
  const arts = Array.isArray(handoffs) ? handoffs : [];

  if (fullTestResult && fullTestResult.passed === false) {
    blockers.push("全量测试失败");
  }

  const hasBlockingFinding = arts.some((h) =>
    (Array.isArray(h.unresolvedIssues) ? h.unresolvedIssues : []).some(
      (i) => (typeof i === "string" ? false : i && i.severity === "blocking"),
    ),
  );
  if (hasBlockingFinding) blockers.push("存在未关闭的阻断级 Review 问题");

  // 提交链完整性：所有未跳过任务必须已 committed 且有 commitSha。
  const pending = list.filter((t) => !["committed", "skipped"].includes(t.status));
  if (pending.length > 0) {
    blockers.push("提交链缺失或无法验证：仍有任务未完成提交");
  } else {
    const committed = list.filter((t) => t.status === "committed");
    if (committed.some((t) => !String(t.commitSha || "").trim())) {
      blockers.push("提交链缺失或无法验证：存在没有 commit 的已通过任务");
    }
  }

  if (driftState && driftState.drifted) {
    blockers.push("目标分支发生漂移且未处理");
  }

  const mode = run?.integrationMode;
  if (mode === "direct_merge" && !(confirmations && confirmations.directMergeConfirmed)) {
    blockers.push("直接合并需要二次确认");
  }

  return { ok: blockers.length === 0, blockers };
}

// ---- 运行状态机 ----

const RUN_TRANSITIONS = {
  draft: ["planning", "terminated"],
  planning: ["awaiting_plan_approval", "failed", "terminated"],
  awaiting_plan_approval: ["running", "planning", "terminated"],
  running: ["paused", "needs_attention", "integrating", "failed", "terminated"],
  paused: ["running", "integrating", "terminated", "needs_attention"],
  needs_attention: ["running", "paused", "terminated", "failed"],
  integrating: ["completed", "paused", "needs_attention", "failed", "terminated"],
  completed: [],
  failed: ["terminated"],
  terminated: [],
};

/** 运行状态迁移是否合法。 */
export function canTransitionRun(from, to) {
  if (from === to) return true;
  return (RUN_TRANSITIONS[from] || []).includes(to);
}
