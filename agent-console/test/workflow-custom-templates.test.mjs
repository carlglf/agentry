import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTemplateStore } from "../server/workflow-template-store.mjs";
import { createWorkflowStore } from "../server/workflow-store.mjs";
import { handleWorkflowApi } from "../server/workflow-routes.mjs";

const runtimeMeta = {
  codex: { command: "codex", yoloArgs: ["--yolo"], readonlyArgs: ["--sandbox", "read-only"] },
  claude: { command: "claude", yoloArgs: ["--dangerously-skip-permissions"], readonlyArgs: ["--permission-mode", "plan"] },
};

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "acg-tpl-"));
}

describe("自定义运行方式模板存储", () => {
  let dir;
  let store;
  beforeEach(async () => {
    dir = await tmpDir();
    store = createTemplateStore({ dataDir: dir });
    await store.load();
  });

  it("create 自动补 id/version/createdAt 并可 list/get", async () => {
    const saved = await store.create({
      name: "我的标准流程",
      baseWorkflowId: "standard-dev",
      taskStages: [{ id: "development", kind: "development", roleId: "developer" }],
      settings: { maxReviewRounds: 2, integrationMode: "direct_merge" },
      roleBindings: { developer: { runtime: "claude", model: "x", persona: "保守", duty: "开发" } },
    });
    expect(saved.id).toMatch(/^custom_/);
    expect(saved.version).toBe(1);
    expect(saved.createdAt).toBeTruthy();
    expect(store.list()).toHaveLength(1);
    expect(store.get(saved.id).name).toBe("我的标准流程");
    expect(store.get(saved.id).roleBindings.developer.runtime).toBe("claude");
  });

  it("同 id 覆盖更新，保留原 createdAt", async () => {
    const a = await store.create({ id: "fixed", name: "v1", taskStages: [], settings: {}, roleBindings: {} });
    const b = await store.create({ id: "fixed", name: "v2", taskStages: [], settings: {}, roleBindings: {} });
    expect(store.list()).toHaveLength(1);
    expect(b.name).toBe("v2");
    expect(b.createdAt).toBe(a.createdAt);
  });

  it("remove 删除并持久化到磁盘", async () => {
    const saved = await store.create({ name: "t", taskStages: [], settings: {}, roleBindings: {} });
    expect(await store.remove(saved.id)).toBe(true);
    expect(await store.remove(saved.id)).toBe(false);
    const reopened = createTemplateStore({ dataDir: dir });
    await reopened.load();
    expect(reopened.list()).toHaveLength(0);
  });
});

// ---- 路由：保存 / 列出 / 删除 / 用自定义模板创建运行 ----

function fakeGit() {
  return {
    isGitRepo: async () => true,
    branchExists: async () => true,
    hasUncommittedChanges: async () => false,
    getHeadSha: async () => "base-sha",
    taskBranchName: (r, t) => `task/${r}/${t}`,
    getChangedFiles: async () => [],
  };
}

function fakePtyMgr() {
  const alive = new Set();
  const k = (r, s) => `run:${r}:exec:${s}`;
  return {
    execKey: k,
    ensureSession: (opts) => alive.add(k(opts.runId, opts.execSessionId)),
    typeInto: (key) => Promise.resolve(alive.has(key)),
    waitForReady: (key) => Promise.resolve(alive.has(key)),
    has: (key) => alive.has(key),
    closeSession: () => 1,
  };
}

async function call(ctx, { method, path: pathname, body, query }) {
  const captured = {};
  const url = query ? `${pathname}?${query}` : pathname;
  const handled = await handleWorkflowApi(
    { method, url, headers: { host: "127.0.0.1:5173" }, __body: body || {} },
    {},
    {
      ...ctx,
      host: "127.0.0.1",
      port: 5173,
      readJson: async (req) => req.__body,
      sendJson: (_res, status, payload) => {
        captured.status = status;
        captured.payload = payload;
      },
    },
  );
  return { handled, ...captured };
}

describe("自定义运行方式模板路由", () => {
  let ctx;
  beforeEach(async () => {
    const dir = await tmpDir();
    const wfStore = createWorkflowStore({ dataDir: dir });
    await wfStore.load();
    const tplStore = createTemplateStore({ dataDir: dir });
    await tplStore.load();
    ctx = {
      wfStore,
      tplStore,
      ptyMgr: fakePtyMgr(),
      gitRunner: fakeGit(),
      runtimeMeta,
      loadProjectTemplates: async () => ({ roles: {}, workflows: {}, prompts: {}, sources: {}, errors: [] }),
    };
  });

  it("POST 缺少名称 → 400", async () => {
    const res = await call(ctx, { method: "POST", path: "/api/workflow/custom-templates", body: { name: "  " } });
    expect(res.status).toBe(400);
    expect(res.payload.code).toBe("missing_name");
  });

  it("POST 非法流程（无开发阶段作回退）→ 400 invalid_workflow", async () => {
    const res = await call(ctx, {
      method: "POST",
      path: "/api/workflow/custom-templates",
      body: {
        name: "坏流程",
        baseWorkflowId: "standard-dev",
        planningRoleId: "planner",
        integrationRoleId: "integrator",
        taskStages: [{ id: "review", kind: "review", roleId: "reviewer" }],
        settings: { maxReviewRounds: 3, integrationMode: "pull_request" },
      },
    });
    expect(res.status).toBe(400);
    expect(res.payload.code).toBe("invalid_workflow");
  });

  it("保存后出现在 GET /templates，来源为“自定义”且携带 roleBindings，删除后消失", async () => {
    const save = await call(ctx, {
      method: "POST",
      path: "/api/workflow/custom-templates",
      body: {
        name: "我的精简流程",
        description: "只开发+Review",
        baseWorkflowId: "lightweight-dev",
        planningRoleId: "planner",
        integrationRoleId: "integrator",
        taskStages: [
          { id: "development", kind: "development", roleId: "developer" },
          { id: "review", kind: "review", roleId: "reviewer" },
        ],
        settings: { maxReviewRounds: 2, integrationMode: "direct_merge" },
        roleBindings: { developer: { runtime: "claude", model: "m", persona: "细致", duty: "开发" } },
      },
    });
    expect(save.status).toBe(201);
    const id = save.payload.template.id;

    const list = await call(ctx, { method: "GET", path: "/api/workflow/templates", query: "repoPath=" });
    const found = list.payload.workflows.find((w) => w.id === id);
    expect(found).toBeTruthy();
    expect(found.source).toBe("自定义");
    expect(found.baseWorkflowId).toBe("lightweight-dev");
    expect(found.roleBindings.developer.persona).toBe("细致");
    // 内置两种仍在。
    expect(list.payload.workflows.some((w) => w.id === "standard-dev")).toBe(true);

    const del = await call(ctx, { method: "DELETE", path: `/api/workflow/custom-templates/${id}` });
    expect(del.status).toBe(200);
    const list2 = await call(ctx, { method: "GET", path: "/api/workflow/templates", query: "repoPath=" });
    expect(list2.payload.workflows.some((w) => w.id === id)).toBe(false);
  });

  it("启动页增删角色：taskStages 覆盖体现在运行快照", async () => {
    const run = await call(ctx, {
      method: "POST",
      path: "/api/workflow/runs",
      body: {
        projectId: "p1",
        goal: "只开发+文档",
        repositoryPath: "/repo",
        baseBranch: "main",
        workflowTemplateId: "standard-dev",
        overrides: {
          taskStages: [
            { id: "development", kind: "development", roleId: "developer" },
            { id: "doc", kind: "doc", roleId: "doc" },
          ],
        },
      },
    });
    expect(run.status).toBe(201);
    expect(run.payload.run.workflowSnapshot.workflow.taskStages.map((s) => s.kind)).toEqual(["development", "doc"]);
  });

  it("启动页删掉开发角色（无回退落点）→ 400 invalid_workflow", async () => {
    const run = await call(ctx, {
      method: "POST",
      path: "/api/workflow/runs",
      body: {
        projectId: "p1",
        goal: "缺开发阶段",
        repositoryPath: "/repo",
        baseBranch: "main",
        workflowTemplateId: "standard-dev",
        overrides: { taskStages: [{ id: "review", kind: "review", roleId: "reviewer" }] },
      },
    });
    expect(run.status).toBe(400);
    expect(run.payload.code).toBe("invalid_workflow");
  });

  it("可用已保存的自定义模板创建运行", async () => {
    const save = await call(ctx, {
      method: "POST",
      path: "/api/workflow/custom-templates",
      body: {
        name: "可启动流程",
        baseWorkflowId: "standard-dev",
        planningRoleId: "planner",
        integrationRoleId: "integrator",
        taskStages: [
          { id: "development", kind: "development", roleId: "developer" },
          { id: "review", kind: "review", roleId: "reviewer" },
        ],
        settings: { maxReviewRounds: 3, integrationMode: "pull_request" },
        roleBindings: {},
      },
    });
    const id = save.payload.template.id;
    const run = await call(ctx, {
      method: "POST",
      path: "/api/workflow/runs",
      body: {
        projectId: "p1",
        goal: "用自定义流程开发",
        repositoryPath: "/repo",
        baseBranch: "main",
        workflowTemplateId: id,
      },
    });
    expect(run.status).toBe(201);
    expect(run.payload.run.workflowTemplateId).toBe(id);
    expect(run.payload.run.workflowSnapshot.workflow.id).toBe(id);
  });

  // ---- 灵活形态：不限数量自定义角色（客户端开发 + 服务端开发）+ 自定义规划 ----
  it("stages 形态：保存两段开发（客户端/服务端）+ 自定义规划，按 kind 合成权限锁定的独立角色", async () => {
    const save = await call(ctx, {
      method: "POST",
      path: "/api/workflow/custom-templates",
      body: {
        name: "前后端分离流程",
        stages: [
          { kind: "development", name: "客户端开发", runtime: "claude", model: "c", persona: "只做前端", duty: "客户端" },
          { kind: "development", name: "服务端开发", runtime: "codex", model: "s", persona: "只做后端", duty: "服务端" },
          { kind: "review", name: "代码审查", runtime: "codex", model: "r", persona: "严格", duty: "审查" },
        ],
        planning: { runtime: "claude", model: "p", persona: "架构师", duty: "拆分前后端任务", prompt: "请把目标拆成客户端任务与服务端任务。" },
        settings: { maxReviewRounds: 2, integrationMode: "direct_merge" },
      },
    });
    expect(save.status).toBe(201);
    const tpl = save.payload.template;
    // 两个开发阶段、唯一阶段 id、各自独立 roleId。
    const devStages = tpl.taskStages.filter((s) => s.kind === "development");
    expect(devStages).toHaveLength(2);
    expect(new Set(tpl.taskStages.map((s) => s.id)).size).toBe(tpl.taskStages.length);
    // 角色权限按 kind 锁定：开发可写可提交、Review 只读。
    const devRole = tpl.roles[devStages[0].roleId];
    expect(devRole.permissions.canWriteCode).toBe(true);
    expect(devRole.permissions.canCommit).toBe(true);
    const reviewStage = tpl.taskStages.find((s) => s.kind === "review");
    expect(tpl.roles[reviewStage.roleId].permissions.canWriteCode).toBe(false);
    // 自定义规划提示词随模板保存。
    expect(tpl.prompts.planning).toContain("客户端任务");
    expect(tpl.roleBindings.planner.duty).toBe("拆分前后端任务");

    // 用它创建运行：快照阶段顺序 = 客户端→服务端→Review；两段开发为不同角色。
    const run = await call(ctx, {
      method: "POST",
      path: "/api/workflow/runs",
      body: { projectId: "p1", goal: "x", repositoryPath: "/repo", baseBranch: "main", workflowTemplateId: tpl.id },
    });
    expect(run.status).toBe(201);
    const snapKinds = run.payload.run.workflowSnapshot.workflow.taskStages.map((s) => s.kind);
    expect(snapKinds).toEqual(["development", "development", "review"]);
    const snapRoleIds = run.payload.run.workflowSnapshot.workflow.taskStages.map((s) => s.roleId);
    expect(new Set(snapRoleIds.slice(0, 2)).size).toBe(2); // 两段开发角色不同
    // 模板自带角色绑定被作为默认注入运行 settings。
    expect(run.payload.run.settings.roleBindings[snapRoleIds[0]].persona).toBe("只做前端");
    // 规划快照带自定义 planning 提示词。
    expect(run.payload.run.workflowSnapshot.prompts.planning).toContain("服务端任务");
  });

  it("stages 形态：缺开发阶段 → 400", async () => {
    const res = await call(ctx, {
      method: "POST",
      path: "/api/workflow/custom-templates",
      body: { name: "无开发", stages: [{ kind: "review", name: "审查" }], settings: {} },
    });
    expect(res.status).toBe(400);
    expect(res.payload.code).toBe("no_development");
  });
});
