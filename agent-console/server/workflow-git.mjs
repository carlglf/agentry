// 流程运行的 Git 操作抽象层（PRD §12）。
// exec 通过注入传入：生产用 execFile 包装，测试用 mock。破坏性/受保护分支操作在此硬阻断，
// 不依赖提示词约束（PRD §12.4/§12.5）。

const DEFAULT_PROTECTED = ["main", "master"];

/** 受保护分支判定（纯函数）。 */
export function isProtectedBranch(branch, policy = {}) {
  const name = String(branch || "").trim();
  if (!name) return false;
  const list = [...DEFAULT_PROTECTED, ...((policy && policy.protectedBranches) || [])];
  if (list.includes(name)) return true;
  // release/* 等保护前缀。
  for (const pat of (policy && policy.protectedPrefixes) || ["release/"]) {
    if (name.startsWith(pat)) return true;
  }
  return false;
}

/** 任务分支命名（PRD §7.3）。 */
export function taskBranchName(runId, taskId) {
  return `task/${runId}/${taskId}`;
}

/**
 * @param {object} opts
 * @param {Function} opts.exec  (file, args, { cwd }) => Promise<{ code, stdout, stderr }>
 * @param {object}   [opts.policy] 安全策略（protectedBranches 等）
 */
export function createGitRunner({ exec, policy = {} }) {
  async function git(cwd, args) {
    return exec("git", args, { cwd });
  }

  async function isGitRepo(cwd) {
    const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return r.code === 0 && String(r.stdout).trim() === "true";
  }

  async function branchExists(cwd, branch) {
    const r = await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return r.code === 0;
  }

  async function currentBranch(cwd) {
    const r = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return String(r.stdout || "").trim();
  }

  async function getHeadSha(cwd, ref = "HEAD") {
    const r = await git(cwd, ["rev-parse", ref]);
    return String(r.stdout || "").trim();
  }

  /** 有未提交改动（含未跟踪）→ true。 */
  async function hasUncommittedChanges(cwd) {
    const r = await git(cwd, ["status", "--porcelain"]);
    return String(r.stdout || "").trim().length > 0;
  }

  /** 为任务创建分支（不切换 worktree 时基于 baseBranch 建）。 */
  async function createTaskBranch(cwd, { runId, taskId, baseBranch }) {
    const branch = taskBranchName(runId, taskId);
    const args = baseBranch
      ? ["branch", branch, baseBranch]
      : ["branch", branch];
    const r = await git(cwd, args);
    if (r.code !== 0) {
      throw new Error(`创建任务分支失败：${branch}：${r.stderr || r.stdout}`);
    }
    return branch;
  }

  /** 为任务创建独立 worktree（优先隔离，PRD §7.3）。 */
  async function createWorktree(cwd, { branch, worktreePath, baseBranch }) {
    const args = ["worktree", "add", "-b", branch, worktreePath];
    if (baseBranch) args.push(baseBranch);
    const r = await git(cwd, args);
    if (r.code !== 0) {
      throw new Error(`创建 worktree 失败：${worktreePath}：${r.stderr || r.stdout}`);
    }
    return { branch, worktreePath };
  }

  /** 移除 worktree（仅用户显式选择时调用；不自动删除未集成成果，PRD §10.2）。 */
  async function removeWorktree(cwd, worktreePath, { force = false } = {}) {
    const args = ["worktree", "remove", worktreePath];
    if (force) args.push("--force");
    const r = await git(cwd, args);
    if (r.code !== 0) throw new Error(`移除 worktree 失败：${r.stderr || r.stdout}`);
    return true;
  }

  /** 在指定目录提交全部已暂存/未暂存改动并返回 commit SHA。 */
  async function commit(cwd, { message, all = true }) {
    if (all) {
      const add = await git(cwd, ["add", "-A"]);
      if (add.code !== 0) throw new Error(`git add 失败：${add.stderr || add.stdout}`);
    }
    const r = await git(cwd, ["commit", "-m", String(message || "task commit")]);
    if (r.code !== 0) throw new Error(`git commit 失败：${r.stderr || r.stdout}`);
    return getHeadSha(cwd);
  }

  async function getChangedFiles(cwd, { base } = {}) {
    const args = base ? ["diff", "--name-only", `${base}...HEAD`] : ["diff", "--name-only", "HEAD"];
    const r = await git(cwd, args);
    return String(r.stdout || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function getDiff(cwd, { base } = {}) {
    const args = base ? ["diff", `${base}...HEAD`] : ["diff", "HEAD"];
    const r = await git(cwd, args);
    return String(r.stdout || "");
  }

  /**
   * 目标分支漂移检测：记录的基线 SHA 与当前目标分支 SHA 不一致即漂移（PRD §7.6/§7.7）。
   * @returns {{ drifted: boolean, currentSha: string, recordedSha: string }}
   */
  async function detectBaseBranchDrift(cwd, { baseBranch, recordedSha }) {
    const r = await git(cwd, ["rev-parse", baseBranch]);
    const currentSha = String(r.stdout || "").trim();
    return {
      drifted: !!recordedSha && !!currentSha && currentSha !== recordedSha,
      currentSha,
      recordedSha: recordedSha || "",
    };
  }

  /**
   * 运行测试命令（独立于 git）。返回结构化结果（PRD §7.5）。
   * 通过 = 退出码 0。失败摘要取 stderr/stdout 末尾。
   */
  async function runTestCommand(command, cwd) {
    const r = await exec("bash", ["-lc", String(command || "")], { cwd });
    const passed = r.code === 0;
    return {
      command,
      exitCode: r.code,
      passed,
      failed: passed ? 0 : 1,
      summary: passed ? "全部通过" : tail(r.stderr || r.stdout, 1000),
      log: tail((r.stdout || "") + (r.stderr || ""), 4000),
    };
  }

  async function ghAvailable() {
    const r = await exec("gh", ["--version"], {});
    return r.code === 0;
  }

  /**
   * 创建 PR（GitHub via gh）。gh 不可用则降级：返回 degraded，由上层提示用户手动建 PR。
   */
  async function createPullRequest(cwd, { title, body, base, head }) {
    if (!(await ghAvailable())) {
      return {
        ok: false,
        degraded: true,
        message: "未检测到 gh CLI，已保留任务分支与提交，请手动创建 PR。",
      };
    }
    const args = ["pr", "create", "--title", title || "", "--body", body || ""];
    if (base) args.push("--base", base);
    if (head) args.push("--head", head);
    const r = await exec("gh", args, { cwd });
    if (r.code !== 0) {
      return { ok: false, degraded: false, message: `创建 PR 失败：${r.stderr || r.stdout}` };
    }
    return { ok: true, url: String(r.stdout || "").trim() };
  }

  /**
   * 合并到目标分支。受保护分支直接合并 / 未确认 → 硬阻断（PRD §7.7/§12.6）。
   */
  async function merge(cwd, { branch, into, confirm }) {
    if (isProtectedBranch(into, policy)) {
      return { ok: false, code: "protected", message: `目标分支 ${into} 受保护，禁止直接合并` };
    }
    if (!confirm) {
      return { ok: false, code: "needs_confirm", message: "直接合并需要二次确认" };
    }
    const co = await git(cwd, ["checkout", into]);
    if (co.code !== 0) return { ok: false, code: "checkout_failed", message: co.stderr || co.stdout };
    const r = await git(cwd, ["merge", "--no-ff", branch]);
    if (r.code !== 0) return { ok: false, code: "merge_failed", message: r.stderr || r.stdout };
    return { ok: true, sha: await getHeadSha(cwd) };
  }

  /** 受守卫的 push：永不允许 --force / -f（PRD §12.4/§12.5）。 */
  async function push(cwd, { remote = "origin", branch, args = [] } = {}) {
    if (args.some((a) => a === "--force" || a === "-f" || a === "--force-with-lease")) {
      return { ok: false, code: "force_forbidden", message: "禁止强推（force push）" };
    }
    const r = await git(cwd, ["push", remote, branch, ...args]);
    return { ok: r.code === 0, message: r.stderr || r.stdout };
  }

  return {
    isGitRepo,
    branchExists,
    currentBranch,
    getHeadSha,
    hasUncommittedChanges,
    createTaskBranch,
    createWorktree,
    removeWorktree,
    commit,
    getChangedFiles,
    getDiff,
    detectBaseBranchDrift,
    runTestCommand,
    ghAvailable,
    createPullRequest,
    merge,
    push,
    isProtectedBranch: (b) => isProtectedBranch(b, policy),
    taskBranchName,
  };
}

function tail(s, n) {
  const str = String(s || "");
  return str.length > n ? str.slice(-n) : str;
}
