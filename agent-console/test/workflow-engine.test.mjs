import { describe, it, expect } from "vitest";
import {
  validatePlan,
  pickNextTask,
  dependentsOf,
  nextStage,
  nextStageDescriptor,
  currentStageIndex,
  isStagePass,
  validateStageSubmission,
  applyReviewRound,
  computeTaskContext,
  evaluateIntegrationGuard,
  canTransitionRun,
  nextSeq,
  stageKindFromStatus,
  statusFromStageKind,
} from "../server/workflow-engine.mjs";

// 标准流程快照：任务阶段 开发 → Review → 测试。
const standardSnapshot = {
  workflow: {
    taskStages: [
      { id: "development", kind: "development", roleId: "developer" },
      { id: "review", kind: "review", roleId: "reviewer" },
      { id: "testing", kind: "testing", roleId: "tester" },
    ],
    settings: { maxReviewRounds: 3, integrationMode: "pull_request" },
  },
};
// 轻量流程：开发 → Review（无独立测试阶段）。
const lightSnapshot = {
  workflow: {
    taskStages: [
      { id: "development", kind: "development", roleId: "developer" },
      { id: "review", kind: "review", roleId: "reviewer" },
    ],
    settings: { maxReviewRounds: 3, integrationMode: "pull_request" },
  },
};

const task = (over = {}) => ({
  id: over.id || "t1",
  title: over.title || "任务一",
  status: over.status || "developing",
  stage: over.stage || over.status || "developing",
  dependencies: over.dependencies || [],
  reviewRounds: over.reviewRounds || 0,
  ...over,
});

describe("validatePlan", () => {
  it("通过：合法依赖链", () => {
    const r = validatePlan([
      { id: "a", title: "A", dependencies: [] },
      { id: "b", title: "B", dependencies: ["a"] },
    ]);
    expect(r.ok).toBe(true);
  });
  it("拒绝：空计划 / 缺标题 / 依赖不存在 / 环", () => {
    expect(validatePlan([]).ok).toBe(false);
    expect(validatePlan([{ id: "a" }]).ok).toBe(false);
    expect(validatePlan([{ id: "a", title: "A", dependencies: ["x"] }]).ok).toBe(false);
    const cyc = validatePlan([
      { id: "a", title: "A", dependencies: ["b"] },
      { id: "b", title: "B", dependencies: ["a"] },
    ]);
    expect(cyc.ok).toBe(false);
    expect(cyc.errors.join("")).toContain("环");
  });
  it("拒绝：id 重复", () => {
    const r = validatePlan([
      { id: "a", title: "A" },
      { id: "a", title: "B" },
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("pickNextTask 串行调度", () => {
  it("依赖未完成则不选", () => {
    const tasks = [
      { id: "a", status: "pending", dependencies: [] },
      { id: "b", status: "pending", dependencies: ["a"] },
    ];
    expect(pickNextTask(tasks).id).toBe("a");
  });
  it("依赖完成后选下一项", () => {
    const tasks = [
      { id: "a", status: "committed", dependencies: [] },
      { id: "b", status: "pending", dependencies: ["a"] },
    ];
    expect(pickNextTask(tasks).id).toBe("b");
  });
  it("有进行中任务时不开新任务（串行）", () => {
    const tasks = [
      { id: "a", status: "developing", dependencies: [] },
      { id: "b", status: "pending", dependencies: [] },
    ];
    expect(pickNextTask(tasks)).toBeNull();
  });
  it("依赖被跳过时下游不可执行", () => {
    const tasks = [
      { id: "a", status: "skipped", dependencies: [] },
      { id: "b", status: "pending", dependencies: ["a"] },
    ];
    expect(pickNextTask(tasks)).toBeNull();
  });
});

describe("dependentsOf", () => {
  it("收集直接与间接下游", () => {
    const tasks = [
      { id: "a", dependencies: [] },
      { id: "b", dependencies: ["a"] },
      { id: "c", dependencies: ["b"] },
    ];
    expect(dependentsOf(tasks, "a").sort()).toEqual(["b", "c"]);
  });
});

describe("nextStage 任务阶段状态机", () => {
  it("开发提交 → 进入 Review", () => {
    expect(nextStage(standardSnapshot, task({ stage: "developing" }), {})).toBe("reviewing");
  });
  it("Review 通过 → 进入测试", () => {
    expect(
      nextStage(standardSnapshot, task({ stage: "reviewing" }), { verdict: "approved" }),
    ).toBe("testing");
  });
  it("Review 打回 → 回到开发", () => {
    expect(
      nextStage(standardSnapshot, task({ stage: "reviewing" }), { verdict: "changes_requested" }),
    ).toBe("developing");
  });
  it("测试通过 → approved", () => {
    expect(
      nextStage(standardSnapshot, task({ stage: "testing" }), { passed: true }),
    ).toBe("approved");
  });
  it("测试失败 → 回到开发", () => {
    expect(
      nextStage(standardSnapshot, task({ stage: "testing" }), { passed: false }),
    ).toBe("developing");
  });
  it("轻量流程：Review 通过直接 approved（无测试阶段）", () => {
    expect(
      nextStage(lightSnapshot, task({ stage: "reviewing" }), { verdict: "approved" }),
    ).toBe("approved");
  });
});

// 同 kind 多阶段：客户端开发 → 服务端开发 → Review。按阶段 id 推进。
const multiDevSnapshot = {
  workflow: {
    taskStages: [
      { id: "client-dev", kind: "development", roleId: "client-dev" },
      { id: "server-dev", kind: "development", roleId: "server-dev" },
      { id: "review", kind: "review", roleId: "reviewer" },
    ],
    settings: { maxReviewRounds: 3, integrationMode: "pull_request" },
  },
};

describe("nextStageDescriptor 同 kind 多阶段（客户端→服务端开发）", () => {
  it("客户端开发提交 → 进入服务端开发（按 stageId 区分，而非按 kind 回到首个）", () => {
    const d = nextStageDescriptor(multiDevSnapshot, task({ stageId: "client-dev", status: "developing", stage: "developing" }), {});
    expect(d.stage.id).toBe("server-dev");
    expect(d.done).toBeFalsy();
    expect(d.fix).toBeFalsy();
  });
  it("服务端开发提交 → 进入 Review", () => {
    const d = nextStageDescriptor(multiDevSnapshot, task({ stageId: "server-dev", status: "developing", stage: "developing" }), {});
    expect(d.stage.id).toBe("review");
  });
  it("Review 打回 → fix 回到首个开发阶段（客户端开发）", () => {
    const d = nextStageDescriptor(multiDevSnapshot, task({ stageId: "review", status: "reviewing", stage: "reviewing" }), { verdict: "changes_requested" });
    expect(d.fix).toBe(true);
    expect(d.stage.id).toBe("client-dev");
  });
  it("Review 通过 → done（走完全部阶段）", () => {
    const d = nextStageDescriptor(multiDevSnapshot, task({ stageId: "review", status: "reviewing", stage: "reviewing" }), { verdict: "approved" });
    expect(d.done).toBe(true);
  });
  it("currentStageIndex 优先按 stageId 定位（同 kind 多阶段不歧义）", () => {
    expect(currentStageIndex(multiDevSnapshot, task({ stageId: "server-dev", status: "developing" }))).toBe(1);
    // 无 stageId 时回退到按状态推 kind（取首个 development）
    expect(currentStageIndex(multiDevSnapshot, task({ status: "developing" }))).toBe(0);
  });
});

describe("validateStageSubmission 非法迁移拒绝（PRD §8.3 / §15.3）", () => {
  it("拒绝：跳过 Review（开发中提交 review/test 之外——开发中直接提交测试结果）", () => {
    const r = validateStageSubmission({
      snapshot: standardSnapshot,
      task: task({ stage: "developing", status: "developing" }),
      type: "test",
      roleId: "tester",
      payload: { passed: true },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("开发");
  });
  it("拒绝：Review 未通过却提交测试（reviewing 阶段提交 test）", () => {
    const r = validateStageSubmission({
      snapshot: standardSnapshot,
      task: task({ stage: "reviewing", status: "reviewing" }),
      type: "test",
      roleId: "tester",
      payload: { passed: true },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("wrong_stage");
  });
  it("拒绝：测试失败却标记通过", () => {
    const r = validateStageSubmission({
      snapshot: standardSnapshot,
      task: task({ stage: "testing", status: "testing" }),
      type: "test",
      roleId: "tester",
      payload: { passed: true, exitCode: 1, failed: 2 },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("test_contradiction");
  });
  it("拒绝：非集成角色执行集成/合并", () => {
    const r = validateStageSubmission({
      snapshot: standardSnapshot,
      task: null,
      type: "integration",
      roleId: "developer",
      integrationRoleId: "integrator",
      payload: {},
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not_integrator");
  });
  it("允许：集成角色执行集成", () => {
    const r = validateStageSubmission({
      type: "integration",
      roleId: "integrator",
      integrationRoleId: "integrator",
      payload: {},
    });
    expect(r.ok).toBe(true);
  });
  it("拒绝：超过最大重试轮次继续自动循环", () => {
    const r = validateStageSubmission({
      snapshot: standardSnapshot,
      task: task({ stage: "reviewing", status: "reviewing", reviewRounds: 3 }),
      type: "review",
      roleId: "reviewer",
      payload: { verdict: "changes_requested" },
      maxReviewRounds: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("retry_exhausted");
  });
  it("拒绝：任务已转人工处理", () => {
    const r = validateStageSubmission({
      snapshot: standardSnapshot,
      task: task({ stage: "reviewing", status: "blocked" }),
      type: "review",
      roleId: "reviewer",
      payload: { verdict: "approved" },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("needs_attention");
  });
  it("允许：阶段一致的正常提交", () => {
    const r = validateStageSubmission({
      snapshot: standardSnapshot,
      task: task({ stage: "reviewing", status: "reviewing" }),
      type: "review",
      roleId: "reviewer",
      payload: { verdict: "approved" },
    });
    expect(r.ok).toBe(true);
  });
});

describe("applyReviewRound", () => {
  it("计数 + 上限 + 预警", () => {
    const r1 = applyReviewRound(task({ reviewRounds: 0 }), { findings: [] }, 3);
    expect(r1.reviewRounds).toBe(1);
    expect(r1.atLimit).toBe(false);
    const r2 = applyReviewRound(task({ reviewRounds: 1 }), { findings: [] }, 3);
    expect(r2.lastRoundWarning).toBe(true);
    const r3 = applyReviewRound(task({ reviewRounds: 2 }), { findings: [] }, 3);
    expect(r3.atLimit).toBe(true);
  });
  it("重复 finding 高亮", () => {
    const t = task({ lastFindingIds: ["f1", "f2"] });
    const r = applyReviewRound(t, { findings: [{ id: "f1" }, { id: "f3" }] }, 3);
    expect(r.repeatedFindingIds).toEqual(["f1"]);
    expect(r.prevFindingIds).toEqual(["f1", "f3"]);
  });
});

describe("computeTaskContext 上下文裁剪（PRD §7.3）", () => {
  const run = { goal: "实现登录", baseBranch: "main", integrationBaseline: "abc123" };
  const allTasks = [
    { id: "a", dependencies: [] },
    { id: "b", dependencies: ["a"] },
    { id: "c", dependencies: ["b"] },
  ];
  const handoffs = [
    { taskId: "a", commitSha: "sha-a", changeSummary: "建表", changedInterfaces: ["User"], decisions: ["用 JWT"], changedFiles: ["a.js"], testResults: [{ big: "x" }], unresolvedIssues: ["xx"] },
    { taskId: "z", commitSha: "sha-z", changeSummary: "无关" },
  ];
  it("只注入相关依赖的交接，不含全 diff/测试", () => {
    const ctx = computeTaskContext({ run, task: allTasks[2], allTasks, handoffs });
    expect(ctx.goal).toBe("实现登录");
    expect(ctx.dependencyHandoffs).toHaveLength(1);
    expect(ctx.dependencyHandoffs[0].taskId).toBe("a");
    // 不回灌 testResults / unresolvedIssues 大字段
    expect(ctx.dependencyHandoffs[0].testResults).toBeUndefined();
    expect(ctx.dependencyHandoffs[0].changedInterfaces).toEqual(["User"]);
  });
  it("无关任务的交接不注入", () => {
    const ctx = computeTaskContext({ run, task: allTasks[0], allTasks, handoffs });
    expect(ctx.dependencyHandoffs).toHaveLength(0);
  });
});

describe("evaluateIntegrationGuard（PRD §7.7 / §15.4.5）", () => {
  const okTasks = [
    { id: "a", status: "committed", commitSha: "sha-a" },
    { id: "b", status: "committed", commitSha: "sha-b" },
  ];
  it("全部通过时放行（PR 模式）", () => {
    const r = evaluateIntegrationGuard({
      run: { integrationMode: "pull_request" },
      tasks: okTasks,
      handoffs: [],
      fullTestResult: { passed: true },
      driftState: { drifted: false },
    });
    expect(r.ok).toBe(true);
  });
  it("全量测试失败 → 阻断", () => {
    const r = evaluateIntegrationGuard({
      run: { integrationMode: "pull_request" },
      tasks: okTasks,
      fullTestResult: { passed: false },
    });
    expect(r.ok).toBe(false);
    expect(r.blockers.join("")).toContain("全量测试失败");
  });
  it("阻断级 Review 未关闭 → 阻断", () => {
    const r = evaluateIntegrationGuard({
      run: { integrationMode: "pull_request" },
      tasks: okTasks,
      handoffs: [{ taskId: "a", unresolvedIssues: [{ id: "f1", severity: "blocking" }] }],
      fullTestResult: { passed: true },
    });
    expect(r.ok).toBe(false);
    expect(r.blockers.join("")).toContain("阻断");
  });
  it("提交链缺失 → 阻断", () => {
    const r = evaluateIntegrationGuard({
      run: { integrationMode: "pull_request" },
      tasks: [{ id: "a", status: "developing" }],
      fullTestResult: { passed: true },
    });
    expect(r.ok).toBe(false);
    expect(r.blockers.join("")).toContain("提交链");
  });
  it("目标分支漂移 → 阻断", () => {
    const r = evaluateIntegrationGuard({
      run: { integrationMode: "pull_request" },
      tasks: okTasks,
      fullTestResult: { passed: true },
      driftState: { drifted: true },
    });
    expect(r.ok).toBe(false);
    expect(r.blockers.join("")).toContain("漂移");
  });
  it("直接合并未二次确认 → 阻断", () => {
    const r = evaluateIntegrationGuard({
      run: { integrationMode: "direct_merge" },
      tasks: okTasks,
      fullTestResult: { passed: true },
      confirmations: {},
    });
    expect(r.ok).toBe(false);
    expect(r.blockers.join("")).toContain("二次确认");
  });
  it("直接合并已确认 → 放行", () => {
    const r = evaluateIntegrationGuard({
      run: { integrationMode: "direct_merge" },
      tasks: okTasks,
      fullTestResult: { passed: true },
      confirmations: { directMergeConfirmed: true },
    });
    expect(r.ok).toBe(true);
  });
});

describe("canTransitionRun 运行状态机", () => {
  it("合法迁移", () => {
    expect(canTransitionRun("planning", "awaiting_plan_approval")).toBe(true);
    expect(canTransitionRun("running", "paused")).toBe(true);
    expect(canTransitionRun("paused", "running")).toBe(true);
  });
  it("非法迁移", () => {
    expect(canTransitionRun("completed", "running")).toBe(false);
    expect(canTransitionRun("draft", "completed")).toBe(false);
  });
});

describe("工具函数", () => {
  it("nextSeq", () => {
    expect(nextSeq([{ seq: 1 }, { seq: 3 }])).toBe(4);
    expect(nextSeq([])).toBe(1);
  });
  it("stage 种类↔状态映射", () => {
    expect(stageKindFromStatus("reviewing")).toBe("review");
    expect(statusFromStageKind("testing")).toBe("testing");
  });
  it("isStagePass", () => {
    expect(isStagePass("review", { verdict: "approved" })).toBe(true);
    expect(isStagePass("testing", { passed: false })).toBe(false);
    expect(isStagePass("testing", { exitCode: 0 })).toBe(true);
  });
});
