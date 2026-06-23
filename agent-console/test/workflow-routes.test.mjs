import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkflowStore } from "../server/workflow-store.mjs";
import { handleWorkflowApi, recoverRuns } from "../server/workflow-routes.mjs";
import { isReadOnlyRole } from "../server/workflow-pty.mjs";

const runtimeMeta = {
  codex: { command: "codex", yoloArgs: ["--yolo"], readonlyArgs: ["--sandbox", "read-only"] },
  claude: { command: "claude", yoloArgs: ["--dangerously-skip-permissions"], readonlyArgs: ["--permission-mode", "plan"] },
};

function fakeDiscStore(groups = []) {
  return { getGroup: (id) => groups.find((g) => g.id === id) || null };
}

function fakePtyMgr() {
  const alive = new Set();
  const typed = [];
  const ensured = [];
  const k = (r, s) => `run:${r}:exec:${s}`;
  return {
    typed,
    alive,
    ensured,
    execKey: k,
    ensureSession: (opts) => {
      ensured.push(opts);
      alive.add(k(opts.runId, opts.execSessionId));
    },
    typeInto: (key, text) => {
      typed.push({ key, text });
      return Promise.resolve(alive.has(key));
    },
    waitForReady: (key) => Promise.resolve(alive.has(key)),
    has: (key) => alive.has(key),
    closeSession: (r, s) => {
      alive.delete(k(r, s));
      return 1;
    },
    closeRun: (r) => {
      let n = 0;
      for (const key of [...alive]) {
        if (key.startsWith(`run:${r}:exec:`)) {
          alive.delete(key);
          n += 1;
        }
      }
      return n;
    },
  };
}

function fakeGit({ dirty = false, protectedBranch = false, isRepo = true, drift = false, commitFails = false, worktreeFails = false } = {}) {
  let n = 0;
  const calls = { worktrees: [], taskBranches: [], merges: [], prs: [], changedFiles: [] };
  return {
    calls,
    isGitRepo: async () => isRepo,
    branchExists: async () => true,
    hasUncommittedChanges: async () => dirty,
    getHeadSha: async () => "base-sha",
    taskBranchName: (r, t) => `task/${r}/${t}`,
    createWorktree: async (cwd, opts) => {
      if (worktreeFails) throw new Error("git worktree add 失败：路径已存在");
      calls.worktrees.push(opts);
      return { branch: opts.branch, worktreePath: opts.worktreePath };
    },
    createTaskBranch: async (cwd, opts) => {
      calls.taskBranches.push(opts);
      return "branch";
    },
    getChangedFiles: async (cwd, opts) => {
      calls.changedFiles.push(opts);
      return ["a.js"];
    },
    getDiff: async () => "diff",
    commit: async () => {
      if (commitFails) throw new Error("git commit 失败：nothing to commit");
      return `sha-${++n}`;
    },
    detectBaseBranchDrift: async () => ({ drifted: drift }),
    createPullRequest: async (cwd, opts) => {
      calls.prs.push(opts);
      return { ok: true, url: "http://pr/1" };
    },
    merge: async (cwd, opts) => {
      calls.merges.push(opts);
      return { ok: true, sha: "merged" };
    },
    isProtectedBranch: () => protectedBranch,
  };
}

function makeCtx(store, { ptyMgr, gitRunner } = {}) {
  return {
    wfStore: store,
    ptyMgr: ptyMgr || fakePtyMgr(),
    gitRunner: gitRunner || fakeGit(),
    runtimeMeta,
    loadProjectTemplates: async () => ({ roles: {}, workflows: {}, prompts: {}, sources: {}, errors: [] }),
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

const plan = {
  tasks: [
    { id: "a", title: "建用户表", dependencies: [], acceptanceCriteria: ["表存在"] },
    { id: "b", title: "登录接口", dependencies: ["a"], acceptanceCriteria: ["返回 token"] },
    { id: "c", title: "前端表单", dependencies: ["b"], acceptanceCriteria: ["可提交"] },
  ],
};

async function createRun(ctx, over = {}) {
  const res = await call(ctx, {
    method: "POST",
    path: "/api/workflow/runs",
    body: {
      projectId: "p1",
      goal: "实现登录",
      repositoryPath: "/repo",
      baseBranch: "dev",
      workflowTemplateId: "standard-dev",
      ...over,
    },
  });
  return res;
}

async function submitStage(ctx, runId, body) {
  return call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/stage`, body });
}

describe("创建运行预检（PRD §7.1 / §15.4.4）", () => {
  let dir;
  let store;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-routes-"));
    store = createWorkflowStore({ dataDir: dir });
    await store.load();
  });

  it("非 git 仓库 → 拒绝", async () => {
    const ctx = makeCtx(store, { gitRunner: fakeGit({ isRepo: false }) });
    const res = await createRun(ctx);
    expect(res.status).toBe(400);
    expect(res.payload.code).toBe("not_a_repo");
  });

  it("工作区有未提交改动 → 拒绝（不接管用户改动）", async () => {
    const ctx = makeCtx(store, { gitRunner: fakeGit({ dirty: true }) });
    const res = await createRun(ctx);
    expect(res.status).toBe(409);
    expect(res.payload.code).toBe("dirty_worktree");
  });

  it("干净仓库 → 创建成功，进入 planning，拉起规划会话", async () => {
    const ctx = makeCtx(store);
    const res = await createRun(ctx);
    expect(res.status).toBe(201);
    expect(res.payload.run.status).toBe("planning");
    expect(ctx.ptyMgr.typed.length).toBeGreaterThan(0); // 规划提示词已注入
  });

  it("运行保存不可变模板快照（PRD §15.4.2）", async () => {
    const ctx = makeCtx(store);
    const res = await createRun(ctx);
    const snap = res.payload.run.workflowSnapshot;
    expect(snap.workflow.id).toBe("standard-dev");
    expect(snap.sources.length).toBeGreaterThan(0);
  });
});

describe("端到端：3 个依赖任务串行（PRD §15.2）", () => {
  let dir;
  let store;
  let ctx;
  let runId;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-e2e-"));
    store = createWorkflowStore({ dataDir: dir });
    await store.load();
    ctx = makeCtx(store);
    const res = await createRun(ctx);
    runId = res.payload.run.id;
    // 提交计划 + 确认
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan`, body: plan });
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan/approve`, body: {} });
  });

  it("计划确认后进入运行，首任务进开发", () => {
    const run = store.getRun(runId);
    expect(run.status).toBe("running");
    expect(run.currentTaskId).toBe("a");
    expect(store.getTask("a").status).toBe("developing");
  });

  it("完整跑通：含一次 Review 打回 + 一次测试失败，仅通过后才提交，最终建 PR", async () => {
    // —— 任务 a：注入一次 Review 打回 ——
    await submitStage(ctx, runId, { type: "dev", taskId: "a", roleId: "developer", payload: { changeSummary: "建表", decisions: ["用 JWT"] } });
    expect(store.getTask("a").status).toBe("reviewing");

    const bounce = await submitStage(ctx, runId, {
      type: "review",
      taskId: "a",
      roleId: "reviewer",
      payload: { verdict: "changes_requested", findings: [{ id: "f1", severity: "major", title: "缺索引" }] },
    });
    expect(bounce.payload.bounced).toBe(true);
    expect(store.getTask("a").status).toBe("developing");
    expect(store.getTask("a").reviewRounds).toBe(1);

    await submitStage(ctx, runId, { type: "dev", taskId: "a", roleId: "developer", payload: { changeSummary: "建表+索引" } });
    await submitStage(ctx, runId, { type: "review", taskId: "a", roleId: "reviewer", payload: { verdict: "approved", findings: [] } });
    expect(store.getTask("a").status).toBe("testing");
    // 测试通过 → 提交
    const committedA = await submitStage(ctx, runId, { type: "test", taskId: "a", roleId: "tester", payload: { passed: true, exitCode: 0 } });
    expect(committedA.payload.committed).toBe(true);
    expect(store.getTask("a").status).toBe("committed");
    expect(store.getTask("a").commitSha).toBeTruthy();
    // 交接产物已生成
    expect(store.getHandoff(runId, "a")).toBeTruthy();
    expect(store.getHandoff(runId, "a").decisions).toContain("用 JWT");
    // 推进到任务 b
    expect(store.getRun(runId).currentTaskId).toBe("b");
    expect(store.getTask("b").status).toBe("developing");

    // —— 任务 b：注入一次测试失败 ——
    await submitStage(ctx, runId, { type: "dev", taskId: "b", roleId: "developer", payload: { changeSummary: "登录" } });
    await submitStage(ctx, runId, { type: "review", taskId: "b", roleId: "reviewer", payload: { verdict: "approved", findings: [] } });
    const testFail = await submitStage(ctx, runId, { type: "test", taskId: "b", roleId: "tester", payload: { passed: false, exitCode: 1, failed: 1 } });
    expect(testFail.payload.bounced).toBe(true);
    expect(store.getTask("b").status).toBe("developing");
    // 修复后重走
    await submitStage(ctx, runId, { type: "dev", taskId: "b", roleId: "developer", payload: { changeSummary: "登录修复" } });
    await submitStage(ctx, runId, { type: "review", taskId: "b", roleId: "reviewer", payload: { verdict: "approved", findings: [] } });
    await submitStage(ctx, runId, { type: "test", taskId: "b", roleId: "tester", payload: { passed: true, exitCode: 0 } });
    expect(store.getTask("b").status).toBe("committed");

    // —— 任务 c：干净跑通 ——
    expect(store.getRun(runId).currentTaskId).toBe("c");
    await submitStage(ctx, runId, { type: "dev", taskId: "c", roleId: "developer", payload: { changeSummary: "表单" } });
    await submitStage(ctx, runId, { type: "review", taskId: "c", roleId: "reviewer", payload: { verdict: "approved", findings: [] } });
    await submitStage(ctx, runId, { type: "test", taskId: "c", roleId: "tester", payload: { passed: true, exitCode: 0 } });
    expect(store.getTask("c").status).toBe("committed");

    // 全部完成 → 进入集成
    expect(store.getRun(runId).status).toBe("integrating");

    // —— 最终集成：建 PR ——
    const integ = await call(ctx, {
      method: "POST",
      path: `/api/workflow/runs/${runId}/integrate`,
      body: { fullTestResult: { passed: true } },
    });
    expect(integ.status).toBe(200);
    expect(integ.payload.result.url).toContain("/pr/");
    expect(store.getRun(runId).status).toBe("completed");
  });

  it("每个任务使用独立开发会话；任务通过后下一任务新建会话（PRD §15.2.7）", async () => {
    await submitStage(ctx, runId, { type: "dev", taskId: "a", roleId: "developer", payload: {} });
    await submitStage(ctx, runId, { type: "review", taskId: "a", roleId: "reviewer", payload: { verdict: "approved" } });
    await submitStage(ctx, runId, { type: "test", taskId: "a", roleId: "tester", payload: { passed: true } });
    const sessionsA = store.listRoleSessions(runId).filter((s) => s.taskId === "a" && s.roleId === "developer");
    const devSessA = sessionsA[0];
    // 推进到 b，b 的开发会话是新的
    const sessionsB = store.listRoleSessions(runId).filter((s) => s.taskId === "b" && s.roleId === "developer");
    expect(sessionsB.length).toBe(1);
    expect(sessionsB[0].id).not.toBe(devSessA.id);
    // a 的开发会话已关闭
    expect(store.getRoleSession(devSessA.id).status).toBe("completed");
  });
});

describe("非法迁移拒绝（PRD §15.3）", () => {
  let store;
  let ctx;
  let runId;
  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-illegal-"));
    store = createWorkflowStore({ dataDir: dir });
    await store.load();
    ctx = makeCtx(store);
    const res = await createRun(ctx);
    runId = res.payload.run.id;
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan`, body: plan });
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan/approve`, body: {} });
  });

  it("跳过 Review（开发中直接提交测试）→ 拒绝", async () => {
    const res = await submitStage(ctx, runId, { type: "test", taskId: "a", roleId: "tester", payload: { passed: true } });
    expect(res.status).toBe(409);
    expect(res.payload.error).toContain("开发");
  });

  it("测试失败后标记通过 → 拒绝", async () => {
    await submitStage(ctx, runId, { type: "dev", taskId: "a", roleId: "developer", payload: {} });
    await submitStage(ctx, runId, { type: "review", taskId: "a", roleId: "reviewer", payload: { verdict: "approved" } });
    const res = await submitStage(ctx, runId, { type: "test", taskId: "a", roleId: "tester", payload: { passed: true, exitCode: 1, failed: 2 } });
    expect(res.status).toBe(409);
    expect(res.payload.code).toBe("test_contradiction");
  });

  it("非集成角色执行集成 → 拒绝", async () => {
    const res = await submitStage(ctx, runId, { type: "integration", roleId: "developer", payload: {} });
    expect(res.status).toBe(409);
    expect(res.payload.code).toBe("not_integrator");
  });

  it("超过最大重试轮次继续自动循环 → 拒绝并转人工", async () => {
    // 默认 maxReviewRounds=3：连续打回到上限。
    await submitStage(ctx, runId, { type: "dev", taskId: "a", roleId: "developer", payload: {} });
    for (let i = 0; i < 3; i += 1) {
      await submitStage(ctx, runId, { type: "review", taskId: "a", roleId: "reviewer", payload: { verdict: "changes_requested", findings: [{ id: "f1" }] } });
      if (store.getTask("a").status === "developing") {
        await submitStage(ctx, runId, { type: "dev", taskId: "a", roleId: "developer", payload: {} });
      }
    }
    // 已转人工 needs_attention
    expect(store.getRun(runId).status).toBe("needs_attention");
    expect(store.getTask("a").status).toBe("blocked");
    // 再次提交被拒
    const again = await submitStage(ctx, runId, { type: "review", taskId: "a", roleId: "reviewer", payload: { verdict: "approved" } });
    expect(again.status).toBe(409);
  });
});

describe("集成阻断与暂停恢复终止（PRD §15.4）", () => {
  let store;
  let ctx;
  let runId;
  async function setupRunning(gitOpts) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-guard-"));
    store = createWorkflowStore({ dataDir: dir });
    await store.load();
    ctx = makeCtx(store, gitOpts ? { gitRunner: fakeGit(gitOpts) } : {});
    const res = await createRun(ctx);
    runId = res.payload.run.id;
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan`, body: { tasks: [{ id: "a", title: "唯一任务", dependencies: [] }] } });
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan/approve`, body: {} });
    // 跑完唯一任务
    await submitStage(ctx, runId, { type: "dev", taskId: "a", roleId: "developer", payload: {} });
    await submitStage(ctx, runId, { type: "review", taskId: "a", roleId: "reviewer", payload: { verdict: "approved" } });
    await submitStage(ctx, runId, { type: "test", taskId: "a", roleId: "tester", payload: { passed: true } });
  }

  it("全量测试失败 → 集成被阻止", async () => {
    await setupRunning();
    const res = await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/integrate`, body: { fullTestResult: { passed: false } } });
    expect(res.status).toBe(409);
    expect(res.payload.blockers.join("")).toContain("全量测试失败");
  });

  it("目标分支漂移 → 集成被阻止", async () => {
    await setupRunning({ drift: true });
    const res = await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/integrate`, body: { fullTestResult: { passed: true } } });
    expect(res.status).toBe(409);
    expect(res.payload.blockers.join("")).toContain("漂移");
  });

  it("受保护分支直接合并 → 拒绝", async () => {
    await setupRunning({ protectedBranch: true });
    await store.updateRun(runId, { integrationMode: "direct_merge" });
    const res = await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/integrate`, body: { fullTestResult: { passed: true }, confirm: true } });
    expect(res.status).toBe(409);
    expect(res.payload.code).toBe("protected");
  });

  it("暂停 / 恢复 / 终止（终止保留记录）", async () => {
    await setupRunning();
    // 构造真实进行中状态（任务 a 处于开发阶段），验证 pause → resume（恢复并重入阶段）→ terminate。
    await store.updateTask("a", { status: "developing" });
    await store.updateRun(runId, { status: "running", currentTaskId: "a", currentStageId: "development" });
    const pause = await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/pause`, body: {} });
    expect(pause.payload.run.status).toBe("paused");
    const resume = await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/resume`, body: {} });
    // 恢复后重新进入开发阶段、保持 running。
    expect(resume.payload.run.status).toBe("running");
    const term = await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/terminate`, body: {} });
    expect(term.payload.run.status).toBe("terminated");
    // 终止后任务/提交记录仍在
    expect(store.getTask("a").commitSha).toBeTruthy();
    expect(store.listAudit(runId).some((a) => a.kind === "terminated")).toBe(true);
  });
});

describe("跳过任务提示受影响下游（PRD §11）", () => {
  it("跳过有依赖任务时返回受影响下游", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-skip-"));
    const store = createWorkflowStore({ dataDir: dir });
    await store.load();
    const ctx = makeCtx(store);
    const res = await createRun(ctx);
    const runId = res.payload.run.id;
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan`, body: plan });
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan/approve`, body: {} });
    const skip = await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/tasks/a/skip`, body: {} });
    expect(skip.payload.affected.sort()).toEqual(["b", "c"]);
  });

  it("跳过唯一/当前任务后继续调度，不卡在指向已跳过任务的 running", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-skip2-"));
    const store = createWorkflowStore({ dataDir: dir });
    await store.load();
    const ctx = makeCtx(store);
    const res = await createRun(ctx);
    const runId = res.payload.run.id;
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan`, body: { tasks: [{ id: "a", title: "唯一任务", dependencies: [] }] } });
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan/approve`, body: {} });
    expect(store.getRun(runId).currentTaskId).toBe("a");
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/tasks/a/skip`, body: {} });
    // 当前任务被清空且进入集成（唯一任务被跳过 → allDone）。
    const run = store.getRun(runId);
    expect(run.currentTaskId).toBeFalsy();
    expect(run.status).toBe("integrating");
  });
});

describe("补丁修复回归（依赖基线/提交失败/直接合并/恢复）", () => {
  let dir;
  let store;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-patch-"));
    store = createWorkflowStore({ dataDir: dir });
    await store.load();
  });

  async function runTaskToCommit(ctx, runId, taskId) {
    await submitStage(ctx, runId, { type: "dev", taskId, roleId: "developer", payload: {} });
    await submitStage(ctx, runId, { type: "review", taskId, roleId: "reviewer", payload: { verdict: "approved" } });
    return submitStage(ctx, runId, { type: "test", taskId, roleId: "tester", payload: { passed: true } });
  }

  it("后续任务以集成基线（上一任务 commit）为分支 base", async () => {
    const git = fakeGit();
    const ctx = makeCtx(store, { gitRunner: git });
    const res = await createRun(ctx);
    const runId = res.payload.run.id;
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan`, body: plan });
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan/approve`, body: {} });
    // 任务 a：base 应为创建运行时的基线（base-sha）。
    const wtA = git.calls.worktrees.find((w) => w.branch === `task/${runId}/a`);
    expect(wtA.baseBranch).toBe("base-sha");
    await runTaskToCommit(ctx, runId, "a");
    // 任务 b：base 应为 a 的 commit（sha-1），而非原目标分支。
    const wtB = git.calls.worktrees.find((w) => w.branch === `task/${runId}/b`);
    expect(wtB.baseBranch).toBe("sha-1");
  });

  it("提交失败不静默推进：任务 blocked、运行转人工", async () => {
    const git = fakeGit({ commitFails: true });
    const ctx = makeCtx(store, { gitRunner: git });
    const res = await createRun(ctx);
    const runId = res.payload.run.id;
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan`, body: { tasks: [{ id: "a", title: "唯一任务", dependencies: [] }] } });
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan/approve`, body: {} });
    const r = await runTaskToCommit(ctx, runId, "a");
    expect(r.payload.needsAttention).toBe(true);
    expect(store.getTask("a").status).toBe("blocked");
    expect(store.getRun(runId).status).toBe("needs_attention");
    // 未生成交接产物 / 未推进。
    expect(store.getHandoff(runId, "a")).toBeFalsy();
  });

  it("直接合并：合并最终任务分支到目标分支（非目标分支合并自身）", async () => {
    const git = fakeGit(); // baseBranch=dev 非受保护
    const ctx = makeCtx(store, { gitRunner: git });
    const res = await createRun(ctx, { overrides: { integrationMode: "direct_merge" } });
    const runId = res.payload.run.id;
    expect(store.getRun(runId).integrationMode).toBe("direct_merge");
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan`, body: { tasks: [{ id: "a", title: "唯一任务", dependencies: [] }] } });
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan/approve`, body: {} });
    await runTaskToCommit(ctx, runId, "a");
    expect(store.getRun(runId).status).toBe("integrating");
    const integ = await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/integrate`, body: { fullTestResult: { passed: true }, confirm: true } });
    expect(integ.status).toBe(200);
    expect(store.getRun(runId).status).toBe("completed");
    expect(git.calls.merges.length).toBe(1);
    expect(git.calls.merges[0].branch).toBe(`task/${runId}/a`);
    expect(git.calls.merges[0].into).toBe("dev");
  });

  it("从 integrating 暂停后恢复回到 integrating（不卡在无当前任务的 running）", async () => {
    const ctx = makeCtx(store);
    const res = await createRun(ctx);
    const runId = res.payload.run.id;
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan`, body: { tasks: [{ id: "a", title: "唯一任务", dependencies: [] }] } });
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan/approve`, body: {} });
    await runTaskToCommit(ctx, runId, "a");
    expect(store.getRun(runId).status).toBe("integrating");
    const pause = await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/pause`, body: {} });
    expect(pause.payload.run.status).toBe("paused");
    const resume = await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/resume`, body: {} });
    expect(resume.payload.run.status).toBe("integrating");
  });
});

describe("补丁修复回归 2（建分支失败/角色门槛/暂停拒收/增量基线）", () => {
  let dir;
  let store;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-patch2-"));
    store = createWorkflowStore({ dataDir: dir });
    await store.load();
  });

  async function startSingleTaskRun(ctx) {
    const res = await createRun(ctx);
    const runId = res.payload.run.id;
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan`, body: { tasks: [{ id: "a", title: "唯一任务", dependencies: [] }] } });
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan/approve`, body: {} });
    return runId;
  }

  it("worktree/分支创建失败 → 任务 blocked、运行转人工、不写入分支路径、不进入阶段", async () => {
    const git = fakeGit({ worktreeFails: true });
    const ctx = makeCtx(store, { gitRunner: git });
    const res = await createRun(ctx);
    const runId = res.payload.run.id;
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan`, body: { tasks: [{ id: "a", title: "唯一任务", dependencies: [] }] } });
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan/approve`, body: {} });
    const task = store.getTask("a");
    expect(task.status).toBe("blocked");
    expect(task.branch).toBeFalsy();
    expect(task.worktreePath).toBeFalsy();
    expect(store.getRun(runId).status).toBe("needs_attention");
    // 未进入开发阶段（任务状态不是 developing）。
    expect(task.status).not.toBe("developing");
  });

  it("非该阶段执行角色提交 review → 拒绝（开发会话不能自评通过绕过门槛）", async () => {
    const ctx = makeCtx(store);
    const runId = await startSingleTaskRun(ctx);
    await submitStage(ctx, runId, { type: "dev", taskId: "a", roleId: "developer", payload: {} });
    // 开发角色冒充 reviewer 提交 review 结果。
    const res = await submitStage(ctx, runId, { type: "review", taskId: "a", roleId: "developer", payload: { verdict: "approved" } });
    expect(res.status).toBe(409);
    expect(res.payload.code).toBe("wrong_role");
    // 任务仍停在 review 阶段，未被放行。
    expect(store.getTask("a").status).toBe("reviewing");
  });

  it("暂停后角色仍提交阶段结果 → 拒绝（安全暂停生效）", async () => {
    const ctx = makeCtx(store);
    const runId = await startSingleTaskRun(ctx);
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/pause`, body: {} });
    expect(store.getRun(runId).status).toBe("paused");
    const res = await submitStage(ctx, runId, { type: "dev", taskId: "a", roleId: "developer", payload: {} });
    expect(res.status).toBe(409);
    expect(res.payload.code).toBe("run_not_active");
    // 任务未被推进出开发阶段。
    expect(store.getTask("a").status).toBe("developing");
  });

  it("后续任务的增量 diff 以任务自身基线为 base（非原目标分支）", async () => {
    const git = fakeGit();
    const ctx = makeCtx(store, { gitRunner: git });
    const res = await createRun(ctx);
    const runId = res.payload.run.id;
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan`, body: plan });
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan/approve`, body: {} });
    // 任务 a 提交（产生 sha-1，成为 b 的基线）。
    await submitStage(ctx, runId, { type: "dev", taskId: "a", roleId: "developer", payload: {} });
    await submitStage(ctx, runId, { type: "review", taskId: "a", roleId: "reviewer", payload: { verdict: "approved" } });
    await submitStage(ctx, runId, { type: "test", taskId: "a", roleId: "tester", payload: { passed: true } });
    // 任务 b 进入 review：getChangedFiles 应以 b 的基线（sha-1）diff。
    await submitStage(ctx, runId, { type: "dev", taskId: "b", roleId: "developer", payload: {} });
    const bReviewDiff = git.calls.changedFiles.slice().reverse().find((c) => c && c.base);
    expect(bReviewDiff.base).toBe("sha-1");
    // 任务 a 的 review diff 用的是原始基线 base-sha。
    expect(git.calls.changedFiles.some((c) => c && c.base === "base-sha")).toBe(true);
  });
});

describe("补丁修复回归 3（讨论组绑定/恢复/集成自动化/权限沙箱/接管）", () => {
  let dir;
  let store;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-patch3-"));
    store = createWorkflowStore({ dataDir: dir });
    await store.load();
  });

  async function startSingleTaskRun(ctx) {
    const res = await createRun(ctx);
    const runId = res.payload.run.id;
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan`, body: { tasks: [{ id: "a", title: "唯一任务", dependencies: [] }] } });
    await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/plan/approve`, body: {} });
    return runId;
  }

  async function runTaskToCommitted(ctx, runId, taskId) {
    await submitStage(ctx, runId, { type: "dev", taskId, roleId: "developer", payload: {} });
    await submitStage(ctx, runId, { type: "review", taskId, roleId: "reviewer", payload: { verdict: "approved" } });
    await submitStage(ctx, runId, { type: "test", taskId, roleId: "tester", payload: { passed: true } });
  }

  // ---- 缺口① 复用讨论组 ----
  it("绑定讨论组成员 → 角色执行会话使用成员 runtime/model，并注入人格前言", async () => {
    const group = { id: "g1", members: [{ id: "m1", name: "小规", runtime: "claude", model: "opus", persona: "严谨", duty: "规划" }] };
    const ctx = makeCtx(store, { ptyMgr: fakePtyMgr() });
    ctx.discStore = fakeDiscStore([group]);
    const res = await createRun(ctx, {
      groupId: "g1",
      settings: { roleBindings: { planner: { memberId: "m1", runtime: "claude", model: "opus", persona: "严谨", duty: "规划" } } },
    });
    expect(res.status).toBe(201);
    const planEnsure = ctx.ptyMgr.ensured.find((e) => e.label === "planner:planning");
    expect(planEnsure.runtime).toBe("claude");
    expect(planEnsure.model).toBe("opus");
    // 人格/职责前言进入注入文本。
    expect(ctx.ptyMgr.typed.some((t) => t.text.includes("严谨") && t.text.includes("规划"))).toBe(true);
  });

  it("无讨论组自定义角色 → 角色执行会话使用自定义 runtime/model，并注入人格前言", async () => {
    const ctx = makeCtx(store, { ptyMgr: fakePtyMgr() });
    const res = await createRun(ctx, {
      settings: { roleBindings: { planner: { runtime: "claude", model: "opus", persona: "先问清边界", duty: "需求规划" } } },
    });
    expect(res.status).toBe(201);
    const planEnsure = ctx.ptyMgr.ensured.find((e) => e.label === "planner:planning");
    expect(planEnsure.runtime).toBe("claude");
    expect(planEnsure.model).toBe("opus");
    expect(ctx.ptyMgr.typed.some((t) => t.text.includes("先问清边界") && t.text.includes("需求规划"))).toBe(true);
  });

  it("绑定不存在的成员 → 创建运行 400", async () => {
    const group = { id: "g1", members: [{ id: "m1", name: "小规", runtime: "claude", model: "opus" }] };
    const ctx = makeCtx(store);
    ctx.discStore = fakeDiscStore([group]);
    const res = await createRun(ctx, {
      groupId: "g1",
      settings: { roleBindings: { planner: { memberId: "nope" } } },
    });
    expect(res.status).toBe(400);
    expect(res.payload.code).toBe("bad_member_binding");
  });

  // ---- 缺口② 恢复 ----
  it("recoverRuns 对进行中运行重建当前阶段会话并记审计", async () => {
    const ctx = makeCtx(store);
    const runId = await startSingleTaskRun(ctx);
    expect(store.getRun(runId).status).toBe("running");
    // 模拟服务重启：全新 ptyMgr（无存活会话），同一 store。
    const freshPty = fakePtyMgr();
    const ctx2 = makeCtx(store, { ptyMgr: freshPty });
    await recoverRuns(ctx2);
    expect(freshPty.ensured.length).toBeGreaterThan(0);
    expect(store.listAudit(runId).some((a) => a.kind === "recovered")).toBe(true);
  });

  it("needs_attention 可恢复（resume）并重入阶段", async () => {
    const ctx = makeCtx(store);
    const runId = await startSingleTaskRun(ctx);
    await store.updateRun(runId, { status: "needs_attention" });
    const freshPty = fakePtyMgr();
    const ctx2 = makeCtx(store, { ptyMgr: freshPty });
    const res = await call(ctx2, { method: "POST", path: `/api/workflow/runs/${runId}/resume`, body: {} });
    expect(res.status).toBe(200);
    expect(store.getRun(runId).status).toBe("running");
    expect(freshPty.ensured.length).toBeGreaterThan(0);
  });

  // ---- 缺口③ 集成自动化 ----
  it("全部任务完成 → 自动进入集成并拉起集成角色会话", async () => {
    const ctx = makeCtx(store);
    const runId = await startSingleTaskRun(ctx);
    await runTaskToCommitted(ctx, runId, "a");
    expect(store.getRun(runId).status).toBe("integrating");
    // 自动创建了集成角色执行会话。
    expect(store.listRoleSessions(runId).some((s) => s.stageId === "integration")).toBe(true);
    expect(ctx.ptyMgr.ensured.some((e) => e.label === "integrator:integration")).toBe(true);
  });

  it("集成放行以集成角色上报的 fullTest 为准（无需 body 勾选）", async () => {
    const ctx = makeCtx(store);
    const runId = await startSingleTaskRun(ctx);
    await runTaskToCommitted(ctx, runId, "a");
    // 集成角色上报全量测试通过。
    await submitStage(ctx, runId, { type: "integration", roleId: "integrator", payload: { fullTest: { passed: true, summary: "全绿" } } });
    const res = await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/integrate`, body: {} });
    expect(res.status).toBe(200);
    expect(res.payload.ok).toBe(true);
  });

  // ---- 缺口④ 权限沙箱 ----
  it("reviewer/tester 以只读权限拉起，developer 仍可写", async () => {
    const ctx = makeCtx(store);
    const runId = await startSingleTaskRun(ctx);
    await submitStage(ctx, runId, { type: "dev", taskId: "a", roleId: "developer", payload: {} });
    const devEnsure = ctx.ptyMgr.ensured.find((e) => e.label === "developer:a");
    const revEnsure = ctx.ptyMgr.ensured.find((e) => e.label === "reviewer:a");
    expect(isReadOnlyRole(devEnsure.permissions)).toBe(false);
    expect(isReadOnlyRole(revEnsure.permissions)).toBe(true);
    expect(revEnsure.env.AGENT_CONSOLE_READONLY).toBe("1");
    expect(devEnsure.env.AGENT_CONSOLE_READONLY).toBe("0");
  });

  // ---- 缺口⑤ 人工接管 ----
  it("retry：needs_attention → running 并重入当前阶段", async () => {
    const ctx = makeCtx(store);
    const runId = await startSingleTaskRun(ctx);
    await store.updateRun(runId, { status: "needs_attention" });
    const freshPty = fakePtyMgr();
    const ctx2 = makeCtx(store, { ptyMgr: freshPty });
    const res = await call(ctx2, { method: "POST", path: `/api/workflow/runs/${runId}/retry`, body: {} });
    expect(res.status).toBe(200);
    expect(store.getRun(runId).status).toBe("running");
    expect(freshPty.ensured.length).toBeGreaterThan(0);
  });

  it("rewind-dev：任务退回开发并重发修复提示", async () => {
    const ctx = makeCtx(store);
    const runId = await startSingleTaskRun(ctx);
    await submitStage(ctx, runId, { type: "dev", taskId: "a", roleId: "developer", payload: {} });
    expect(store.getTask("a").status).toBe("reviewing");
    const res = await call(ctx, {
      method: "POST",
      path: `/api/workflow/runs/${runId}/tasks/a/rewind-dev`,
      body: { findings: [{ id: "f1", title: "修一下" }] },
    });
    expect(res.status).toBe(200);
    expect(store.getTask("a").status).toBe("developing");
  });

  it("raise-retry-limit：提升 Review 重试上限", async () => {
    const ctx = makeCtx(store);
    const runId = await startSingleTaskRun(ctx);
    const base = store.getRun(runId).workflowSnapshot.workflow.settings.maxReviewRounds;
    const res = await call(ctx, { method: "POST", path: `/api/workflow/runs/${runId}/raise-retry-limit`, body: {} });
    expect(res.status).toBe(200);
    expect(res.payload.maxReviewRounds).toBe(base + 1);
    expect(store.getRun(runId).settings.overrides.maxReviewRounds).toBe(base + 1);
  });
});
