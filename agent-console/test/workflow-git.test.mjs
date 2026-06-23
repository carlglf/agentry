import { describe, it, expect } from "vitest";
import { createGitRunner, isProtectedBranch, taskBranchName } from "../server/workflow-git.mjs";

// mock exec：按 (file, args) 命中返回预设结果，并记录所有调用。
function makeExec(handlers = {}) {
  const calls = [];
  const exec = (file, args, opts) => {
    calls.push({ file, args, opts });
    const key = `${file} ${args.join(" ")}`;
    for (const [pattern, result] of Object.entries(handlers)) {
      if (key.startsWith(pattern)) {
        return Promise.resolve({ code: 0, stdout: "", stderr: "", ...result });
      }
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { exec, calls };
}

describe("isProtectedBranch / taskBranchName", () => {
  it("默认保护 main/master", () => {
    expect(isProtectedBranch("main")).toBe(true);
    expect(isProtectedBranch("master")).toBe(true);
    expect(isProtectedBranch("feature/x")).toBe(false);
  });
  it("release/ 前缀受保护", () => {
    expect(isProtectedBranch("release/1.0")).toBe(true);
  });
  it("策略自定义保护分支", () => {
    expect(isProtectedBranch("prod", { protectedBranches: ["prod"] })).toBe(true);
  });
  it("任务分支命名", () => {
    expect(taskBranchName("r1", "t1")).toBe("task/r1/t1");
  });
});

describe("git runner 基础查询", () => {
  it("isGitRepo", async () => {
    const { exec } = makeExec({ "git rev-parse --is-inside-work-tree": { stdout: "true\n" } });
    const g = createGitRunner({ exec });
    expect(await g.isGitRepo("/repo")).toBe(true);
  });
  it("hasUncommittedChanges 检测未提交改动（不覆盖用户改动，PRD §15.4.4）", async () => {
    const dirty = createGitRunner({ exec: makeExec({ "git status --porcelain": { stdout: " M a.js\n" } }).exec });
    expect(await dirty.hasUncommittedChanges("/repo")).toBe(true);
    const clean = createGitRunner({ exec: makeExec({ "git status --porcelain": { stdout: "" } }).exec });
    expect(await clean.hasUncommittedChanges("/repo")).toBe(false);
  });
  it("branchExists", async () => {
    const yes = createGitRunner({ exec: makeExec({ "git rev-parse --verify": { code: 0 } }).exec });
    expect(await yes.branchExists("/repo", "dev")).toBe(true);
    const no = createGitRunner({ exec: makeExec({ "git rev-parse --verify": { code: 1 } }).exec });
    expect(await no.branchExists("/repo", "dev")).toBe(false);
  });
});

describe("分支/worktree/commit", () => {
  it("createTaskBranch 使用约定命名", async () => {
    const { exec, calls } = makeExec();
    const g = createGitRunner({ exec });
    const branch = await g.createTaskBranch("/repo", { runId: "r1", taskId: "t1", baseBranch: "dev" });
    expect(branch).toBe("task/r1/t1");
    expect(calls.some((c) => c.args.join(" ") === "branch task/r1/t1 dev")).toBe(true);
  });
  it("createWorktree", async () => {
    const { exec, calls } = makeExec();
    const g = createGitRunner({ exec });
    await g.createWorktree("/repo", { branch: "task/r1/t1", worktreePath: "/wt/t1", baseBranch: "dev" });
    expect(calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(true);
  });
  it("commit 返回 head sha", async () => {
    const { exec } = makeExec({ "git rev-parse HEAD": { stdout: "deadbeef\n" } });
    const g = createGitRunner({ exec });
    const sha = await g.commit("/repo", { message: "feat" });
    expect(sha).toBe("deadbeef");
  });
  it("commit 失败抛错", async () => {
    const g = createGitRunner({ exec: makeExec({ "git commit": { code: 1, stderr: "nothing to commit" } }).exec });
    await expect(g.commit("/repo", { message: "x" })).rejects.toThrow();
  });
});

describe("漂移检测", () => {
  it("记录基线与当前不同 → 漂移", async () => {
    const g = createGitRunner({ exec: makeExec({ "git rev-parse dev": { stdout: "newsha\n" } }).exec });
    const r = await g.detectBaseBranchDrift("/repo", { baseBranch: "dev", recordedSha: "oldsha" });
    expect(r.drifted).toBe(true);
  });
  it("一致 → 不漂移", async () => {
    const g = createGitRunner({ exec: makeExec({ "git rev-parse dev": { stdout: "samesha\n" } }).exec });
    const r = await g.detectBaseBranchDrift("/repo", { baseBranch: "dev", recordedSha: "samesha" });
    expect(r.drifted).toBe(false);
  });
});

describe("测试命令执行", () => {
  it("退出码 0 → 通过", async () => {
    const g = createGitRunner({ exec: makeExec({ "bash -lc": { code: 0, stdout: "ok" } }).exec });
    const r = await g.runTestCommand("npm test", "/repo");
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
  });
  it("非零退出 → 失败 + 摘要", async () => {
    const g = createGitRunner({ exec: makeExec({ "bash -lc": { code: 1, stderr: "1 failing" } }).exec });
    const r = await g.runTestCommand("npm test", "/repo");
    expect(r.passed).toBe(false);
    expect(r.summary).toContain("failing");
  });
});

describe("PR 与合并安全", () => {
  it("gh 缺失 → 降级", async () => {
    const g = createGitRunner({ exec: makeExec({ "gh --version": { code: 1 } }).exec });
    const r = await g.createPullRequest("/repo", { title: "t", body: "b", base: "dev", head: "task/r1/t1" });
    expect(r.ok).toBe(false);
    expect(r.degraded).toBe(true);
  });
  it("gh 可用 → 创建 PR 返回 url", async () => {
    const g = createGitRunner({
      exec: makeExec({
        "gh --version": { code: 0 },
        "gh pr create": { code: 0, stdout: "https://github.com/x/y/pull/1\n" },
      }).exec,
    });
    const r = await g.createPullRequest("/repo", { title: "t", body: "b", base: "dev", head: "h" });
    expect(r.ok).toBe(true);
    expect(r.url).toContain("/pull/1");
  });
  it("受保护分支直接合并 → 硬阻断（PRD §12.6）", async () => {
    const g = createGitRunner({ exec: makeExec().exec });
    const r = await g.merge("/repo", { branch: "task/r1/t1", into: "main", confirm: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("protected");
  });
  it("未确认直接合并 → 阻断", async () => {
    const g = createGitRunner({ exec: makeExec().exec });
    const r = await g.merge("/repo", { branch: "task/r1/t1", into: "dev", confirm: false });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("needs_confirm");
  });
  it("非保护分支 + 已确认 → 合并", async () => {
    const g = createGitRunner({ exec: makeExec({ "git rev-parse HEAD": { stdout: "mergedsha\n" } }).exec });
    const r = await g.merge("/repo", { branch: "task/r1/t1", into: "dev", confirm: true });
    expect(r.ok).toBe(true);
    expect(r.sha).toBe("mergedsha");
  });
  it("强推被禁止（PRD §12.4/§12.5）", async () => {
    const g = createGitRunner({ exec: makeExec().exec });
    const r = await g.push("/repo", { branch: "dev", args: ["--force"] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("force_forbidden");
  });
});
