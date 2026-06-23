import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkflowStore } from "../server/workflow-store.mjs";

describe("workflow-store", () => {
  let dir;
  let store;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-store-"));
    store = createWorkflowStore({ dataDir: dir });
    await store.load();
  });

  it("createRun + getRun + updateRun", async () => {
    const run = await store.createRun({
      goal: "实现登录",
      repositoryPath: "/repo",
      baseBranch: "dev",
      integrationMode: "pull_request",
      workflowTemplateId: "standard-dev",
      workflowSnapshot: { workflow: { id: "standard-dev" } },
      status: "planning",
    });
    expect(run.id).toMatch(/^wfrun_/);
    expect(store.getRun(run.id).goal).toBe("实现登录");
    const updated = await store.updateRun(run.id, { status: "running" });
    expect(updated.status).toBe("running");
  });

  it("replacePlan 建立任务并默认 pending", async () => {
    const run = await store.createRun({ goal: "g", status: "planning" });
    const tasks = await store.replacePlan(run.id, [
      { id: "a", title: "任务A", dependencies: [] },
      { id: "b", title: "任务B", dependencies: ["a"] },
    ]);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].status).toBe("pending");
    expect(store.listTasks(run.id)).toHaveLength(2);
    const t = await store.updateTask("a", { status: "developing", stage: "developing", branch: "task/x/a" });
    expect(t.status).toBe("developing");
    expect(t.branch).toBe("task/x/a");
  });

  it("角色执行会话生命周期：建→查活动→关闭", async () => {
    const run = await store.createRun({ goal: "g" });
    const s = await store.createRoleSession({ runId: run.id, memberId: "m1", roleId: "developer", taskId: "a", stageId: "development" });
    expect(s.status).toBe("starting");
    expect(store.findActiveTaskSession(run.id, "a").id).toBe(s.id);
    await store.closeRoleSession(s.id);
    expect(store.findActiveTaskSession(run.id, "a")).toBeNull();
  });

  it("stageResults append-only 带 seq", async () => {
    const run = await store.createRun({ goal: "g" });
    await store.appendStageResult({ runId: run.id, taskId: "a", type: "dev", payload: { x: 1 } });
    await store.appendStageResult({ runId: run.id, taskId: "a", type: "review", payload: { verdict: "approved" } });
    const list = store.listStageResults(run.id);
    expect(list.map((r) => r.seq)).toEqual([1, 2]);
    expect(store.listStageResults(run.id, { taskId: "a" })).toHaveLength(2);
  });

  it("createHandoff + getHandoff", async () => {
    const run = await store.createRun({ goal: "g" });
    await store.createHandoff({
      runId: run.id,
      taskId: "a",
      commitSha: "sha-a",
      changeSummary: "建表",
      changedInterfaces: ["User"],
    });
    const h = store.getHandoff(run.id, "a");
    expect(h.commitSha).toBe("sha-a");
    expect(h.changedInterfaces).toEqual(["User"]);
    expect(store.listHandoffs(run.id)).toHaveLength(1);
  });

  it("appendAudit + listAudit", async () => {
    const run = await store.createRun({ goal: "g" });
    await store.appendAudit({ runId: run.id, kind: "paused", detail: { by: "user" } });
    expect(store.listAudit(run.id)).toHaveLength(1);
    expect(store.listAudit(run.id)[0].kind).toBe("paused");
  });

  it("原子写后另一个 store 实例可读回（reload 持久化）", async () => {
    const run = await store.createRun({ goal: "持久化", status: "planning" });
    await store.replacePlan(run.id, [{ id: "a", title: "A" }]);
    await store.createHandoff({ runId: run.id, taskId: "a", commitSha: "s" });

    const store2 = createWorkflowStore({ dataDir: dir });
    await store2.load();
    expect(store2.getRun(run.id).goal).toBe("持久化");
    expect(store2.listTasks(run.id)).toHaveLength(1);
    expect(store2.getHandoff(run.id, "a").commitSha).toBe("s");
  });

  it("未 load 调用抛错", () => {
    const fresh = createWorkflowStore({ dataDir: dir });
    expect(() => fresh.listRuns()).toThrow();
  });
});
