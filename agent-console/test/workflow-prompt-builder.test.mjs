import { describe, it, expect } from "vitest";
import {
  STAGE_CLI_HINT,
  buildPlanningPrompt,
  buildDevelopmentPrompt,
  buildFixPrompt,
  buildReviewPrompt,
  buildTestingPrompt,
  buildIntegrationPrompt,
} from "../server/workflow-prompt-builder.mjs";

const context = {
  goal: "实现登录",
  baseBranch: "dev",
  integrationBaseline: "abc123",
  task: {
    id: "t2",
    title: "实现登录接口",
    objective: "提供 /login",
    branch: "task/r1/t2",
    worktree: "/wt/t2",
    scope: ["src/auth"],
    forbiddenChanges: ["不要改数据库 schema"],
    acceptanceCriteria: ["返回 token"],
    suggestedTests: ["npm test auth"],
    expectedFiles: ["src/auth/login.js"],
    dependencies: ["t1"],
  },
  dependencyHandoffs: [
    { taskId: "t1", commitSha: "sha-t1", changeSummary: "建用户表", changedInterfaces: ["User"], decisions: ["用 JWT"] },
  ],
};

describe("STAGE_CLI_HINT", () => {
  it("含 acg stage submit", () => {
    expect(STAGE_CLI_HINT).toContain("acg stage submit");
  });
});

describe("buildPlanningPrompt", () => {
  it("含目标与结构化任务要求", () => {
    const p = buildPlanningPrompt({ goal: "实现登录", repositoryPath: "/repo", baseBranch: "dev", detectedTestCommand: "npm test" });
    expect(p).toContain("实现登录");
    expect(p).toContain("--type plan");
    expect(p).toContain("npm test");
  });
});

describe("buildDevelopmentPrompt", () => {
  it("注入当前任务 + 依赖交接，不回灌全历史", () => {
    const p = buildDevelopmentPrompt({ context });
    expect(p).toContain("实现登录接口");
    expect(p).toContain("task/r1/t2");
    expect(p).toContain("建用户表"); // 依赖交接摘要
    expect(p).toContain("用 JWT"); // 设计决策
    expect(p).toContain(STAGE_CLI_HINT);
    // 不应包含"完整历史/全部 diff"之类回灌
    expect(p).not.toContain("全部历史");
  });
});

describe("buildFixPrompt", () => {
  it("携带结构化 findings 与重复高亮", () => {
    const p = buildFixPrompt({
      context,
      round: 2,
      findings: [{ id: "f1", severity: "blocking", file: "a.js", line: 3, title: "空指针", detail: "x 可能为 null", suggestedFix: "加判空" }],
      repeatedFindingIds: ["f1"],
    });
    expect(p).toContain("空指针");
    expect(p).toContain("连续多轮未解决");
    expect(p).toContain("加判空");
  });
});

describe("buildReviewPrompt / buildTestingPrompt", () => {
  it("review 含裁决格式", () => {
    const p = buildReviewPrompt({ context, changedFiles: ["a.js"], diffSummary: "改了登录" });
    expect(p).toContain("verdict");
    expect(p).toContain("a.js");
  });
  it("testing 含禁止忽略失败", () => {
    const p = buildTestingPrompt({ context, allowedTestCommands: ["npm test"] });
    expect(p).toContain("禁止忽略失败测试");
    expect(p).toContain("npm test");
  });
});

describe("buildIntegrationPrompt", () => {
  it("PR 模式", () => {
    const p = buildIntegrationPrompt({ goal: "g", tasks: [{}, {}], integrationMode: "pull_request", baseBranch: "dev" });
    expect(p).toContain("Pull Request");
    expect(p).toContain("禁止集成");
  });
  it("直接合并模式", () => {
    const p = buildIntegrationPrompt({ goal: "g", tasks: [], integrationMode: "direct_merge", baseBranch: "dev" });
    expect(p).toContain("直接合并");
  });
});
