import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  builtinTemplates,
  validateRoleTemplate,
  validateWorkflowTemplate,
  scanForSecrets,
  applyWorkflowOverrides,
  resolveTemplates,
  snapshotTemplates,
  loadProjectTemplates,
  validateResolvedWorkflow,
  stableHash,
} from "../server/workflow-templates.mjs";

describe("内置模板有效", () => {
  it("两套官方流程通过校验", () => {
    for (const id of Object.keys(BUILTIN_WORKFLOWS)) {
      const check = validateWorkflowTemplate(BUILTIN_WORKFLOWS[id], BUILTIN_ROLES);
      expect(check.ok, check.errors.join("；")).toBe(true);
    }
  });
  it("内置角色全部通过校验", () => {
    for (const [id, r] of Object.entries(BUILTIN_ROLES)) {
      expect(validateRoleTemplate(r, id).ok).toBe(true);
    }
  });
});

describe("validateRoleTemplate 越权拒绝", () => {
  it("只读范围申请提交权限 → 拒绝", () => {
    const r = validateRoleTemplate(
      { id: "x", name: "X", permissions: { workspaceScope: "read-only", canCommit: true } },
      "x",
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join("")).toContain("超出策略");
  });
  it("未知权限字段 → 拒绝", () => {
    const r = validateRoleTemplate(
      { id: "x", name: "X", permissions: { rootAccess: true } },
      "x",
    );
    expect(r.ok).toBe(false);
  });
  it("非法 workspaceScope → 拒绝", () => {
    const r = validateRoleTemplate({ id: "x", name: "X", permissions: { workspaceScope: "host" } }, "x");
    expect(r.ok).toBe(false);
  });
});

describe("validateWorkflowTemplate", () => {
  it("拒绝高风险静默标记", () => {
    const wf = { ...BUILTIN_WORKFLOWS["standard-dev"], forcePush: true };
    const r = validateWorkflowTemplate(wf, BUILTIN_ROLES);
    expect(r.ok).toBe(false);
    expect(r.errors.join("")).toContain("forcePush");
  });
  it("拒绝关闭门槛", () => {
    const wf = {
      ...BUILTIN_WORKFLOWS["standard-dev"],
      taskStages: [
        { id: "development", kind: "development", roleId: "developer" },
        { id: "review", kind: "review", roleId: "reviewer", gate: false },
      ],
    };
    expect(validateWorkflowTemplate(wf, BUILTIN_ROLES).ok).toBe(false);
  });
  it("拒绝缺少可用角色", () => {
    const wf = {
      ...BUILTIN_WORKFLOWS["lightweight-dev"],
      taskStages: [{ id: "development", kind: "development", roleId: "ghost" }],
    };
    expect(validateWorkflowTemplate(wf, BUILTIN_ROLES).ok).toBe(false);
  });
  it("拒绝 maxReviewRounds 非正（无退出条件）", () => {
    const wf = { ...BUILTIN_WORKFLOWS["lightweight-dev"], settings: { maxReviewRounds: 0, integrationMode: "pull_request" } };
    expect(validateWorkflowTemplate(wf, BUILTIN_ROLES).ok).toBe(false);
  });
});

describe("scanForSecrets", () => {
  it("命中常见凭据", () => {
    expect(scanForSecrets("token = 'ghp_abcdef0123456789ABCDEFGHIJKLMNOP'").found).toBe(true);
    expect(scanForSecrets('api_key: "supersecretvalue"').found).toBe(true);
    expect(scanForSecrets("普通文本").found).toBe(false);
  });
});

describe("applyWorkflowOverrides", () => {
  it("关闭测试角色移除测试阶段（PRD §15.1.3）", () => {
    const wf = applyWorkflowOverrides(BUILTIN_WORKFLOWS["standard-dev"], { enableTesting: false });
    expect(wf.taskStages.some((s) => s.kind === "testing")).toBe(false);
    // 移除后流程仍合法、无不可达阶段
    expect(validateWorkflowTemplate(wf, BUILTIN_ROLES).ok).toBe(true);
  });
  it("启用文档角色追加文档阶段（PRD §15.1.4）", () => {
    const wf = applyWorkflowOverrides(BUILTIN_WORKFLOWS["lightweight-dev"], { enableDoc: true });
    expect(wf.taskStages.some((s) => s.kind === "doc")).toBe(true);
  });
  it("覆盖 maxReviewRounds 与集成方式", () => {
    const wf = applyWorkflowOverrides(BUILTIN_WORKFLOWS["lightweight-dev"], {
      maxReviewRounds: 5,
      integrationMode: "direct_merge",
    });
    expect(wf.settings.maxReviewRounds).toBe(5);
    expect(wf.settings.integrationMode).toBe("direct_merge");
  });
  it("显式 taskStages 覆盖整体替换阶段列表（增删/排序角色）并对 kind 去重", () => {
    const wf = applyWorkflowOverrides(BUILTIN_WORKFLOWS["standard-dev"], {
      taskStages: [
        { id: "development", kind: "development", roleId: "developer" },
        { id: "doc", kind: "doc", roleId: "doc" },
        { id: "dup", kind: "doc", roleId: "doc" },
      ],
    });
    expect(wf.taskStages.map((s) => s.kind)).toEqual(["development", "doc"]);
    expect(validateWorkflowTemplate(wf, BUILTIN_ROLES).ok).toBe(true);
  });
});

describe("resolveTemplates + snapshotTemplates", () => {
  it("项目 .acg 同 id 覆盖内置（PRD §15.5.2）", () => {
    const project = {
      workflows: {
        "standard-dev": { ...BUILTIN_WORKFLOWS["standard-dev"], description: "项目自定义标准", __relativePath: ".acg/workflows/standard-dev.json" },
      },
    };
    const resolved = resolveTemplates({ builtin: builtinTemplates(), project });
    expect(resolved.workflows["standard-dev"].description).toBe("项目自定义标准");
    expect(resolved.sources["workflow:standard-dev"].source).toBe("项目 .acg");
  });
  it("快照记录来源/相对路径/版本/内容 hash（PRD §15.5.6）", () => {
    const resolved = resolveTemplates({ builtin: builtinTemplates() });
    const snap = snapshotTemplates({ resolved, workflowId: "standard-dev" });
    const wfSource = snap.sources.find((s) => s.kind === "workflow" && s.id === "standard-dev");
    expect(wfSource.source).toBe("内置");
    expect(wfSource.contentHash).toBeTruthy();
    expect(wfSource.contentHash.length).toBe(16);
    // 快照不可变
    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => {
      snap.workflow.taskStages.push({});
    }).toThrow();
  });
  it("快照仅含 workflow 用到的角色", () => {
    const resolved = resolveTemplates({ builtin: builtinTemplates() });
    const snap = snapshotTemplates({ resolved, workflowId: "lightweight-dev" });
    expect(snap.roles.developer).toBeTruthy();
    expect(snap.roles.tester).toBeUndefined(); // 轻量流程不含测试
  });
  it("本次修改覆盖应用于快照（PRD §15.5.4）", () => {
    const resolved = resolveTemplates({ builtin: builtinTemplates() });
    const snap = snapshotTemplates({ resolved, workflowId: "standard-dev", overrides: { enableTesting: false } });
    expect(snap.workflow.taskStages.some((s) => s.kind === "testing")).toBe(false);
  });
});

describe("loadProjectTemplates（.acg I/O）", () => {
  let dir;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "acg-tpl-"));
    await fs.mkdir(path.join(dir, ".acg", "roles"), { recursive: true });
    await fs.mkdir(path.join(dir, ".acg", "workflows"), { recursive: true });
    await fs.mkdir(path.join(dir, ".acg", "prompts"), { recursive: true });
  });

  it("读取合法角色/流程/提示词", async () => {
    await fs.writeFile(
      path.join(dir, ".acg", "roles", "developer.json"),
      JSON.stringify({ id: "developer", name: "项目开发", permissions: { workspaceScope: "worktree", canWriteCode: true } }),
    );
    await fs.writeFile(
      path.join(dir, ".acg", "workflows", "standard-dev.json"),
      JSON.stringify(BUILTIN_WORKFLOWS["standard-dev"]),
    );
    await fs.writeFile(path.join(dir, ".acg", "prompts", "development.md"), "项目开发提示词");
    const res = await loadProjectTemplates(dir);
    expect(res.errors).toEqual([]);
    expect(res.roles.developer.name).toBe("项目开发");
    expect(res.roles.developer.__relativePath).toContain(".acg");
    expect(res.workflows["standard-dev"]).toBeTruthy();
    expect(res.prompts.development).toBe("项目开发提示词");
  });

  it("含凭据的文件被拒绝并给可读原因（PRD §15.5.5）", async () => {
    await fs.writeFile(
      path.join(dir, ".acg", "prompts", "review.md"),
      "token = 'ghp_abcdefghij0123456789ABCDEFGHIJKLMN'",
    );
    const res = await loadProjectTemplates(dir);
    expect(res.errors.join("")).toContain("凭据");
    expect(res.prompts.review).toBeUndefined();
  });

  it("越权角色被拒绝（PRD §15.5.5）", async () => {
    await fs.writeFile(
      path.join(dir, ".acg", "roles", "evil.json"),
      JSON.stringify({ id: "evil", name: "越权", permissions: { workspaceScope: "read-only", canCommit: true } }),
    );
    const res = await loadProjectTemplates(dir);
    expect(res.errors.join("")).toContain("超出策略");
    expect(res.roles.evil).toBeUndefined();
  });

  it("非法迁移的 .acg 流程在合成校验时被拒绝（PRD §15.5.5）", async () => {
    await fs.writeFile(
      path.join(dir, ".acg", "workflows", "bad.json"),
      JSON.stringify({
        id: "bad",
        name: "坏流程",
        taskStages: [{ id: "review", kind: "review", roleId: "reviewer", gate: false }],
        settings: { maxReviewRounds: 3, integrationMode: "pull_request" },
      }),
    );
    const project = await loadProjectTemplates(dir);
    const resolved = resolveTemplates({ builtin: builtinTemplates(), project });
    const check = validateResolvedWorkflow(resolved, "bad");
    expect(check.ok).toBe(false);
  });

  it("高风险静默 git 的 .acg 流程被拒绝（PRD §15.5.5）", async () => {
    await fs.writeFile(
      path.join(dir, ".acg", "workflows", "risky.json"),
      JSON.stringify({
        id: "risky",
        name: "风险流程",
        forcePush: true,
        taskStages: [
          { id: "development", kind: "development", roleId: "developer" },
          { id: "review", kind: "review", roleId: "reviewer" },
        ],
        settings: { maxReviewRounds: 3, integrationMode: "pull_request" },
      }),
    );
    const project = await loadProjectTemplates(dir);
    const resolved = resolveTemplates({ builtin: builtinTemplates(), project });
    expect(validateResolvedWorkflow(resolved, "risky").ok).toBe(false);
  });
});

describe("stableHash", () => {
  it("确定且随内容变化", () => {
    expect(stableHash("a")).toBe(stableHash("a"));
    expect(stableHash("a")).not.toBe(stableHash("b"));
  });
});
