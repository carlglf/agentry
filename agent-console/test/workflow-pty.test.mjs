import { describe, it, expect } from "vitest";
import {
  createRoleSessionPtyManager,
  execKey,
  isWorkflowKey,
  isRuntimeReady,
  isReadOnlyRole,
} from "../server/workflow-pty.mjs";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const runtimeMeta = {
  codex: { command: "codex", yoloArgs: ["--yolo"], readonlyArgs: ["--sandbox", "read-only"] },
  claude: { command: "claude", yoloArgs: ["--dangerously-skip-permissions"], readonlyArgs: ["--permission-mode", "plan"] },
};

function makeFakeSpawn() {
  const terms = [];
  const spawn = (shell, args, opts) => {
    const term = {
      shell,
      args,
      opts,
      writes: [],
      killed: false,
      _onData: null,
      _onExit: null,
      write(d) {
        this.writes.push(d);
      },
      onData(fn) {
        this._onData = fn;
      },
      onExit(fn) {
        this._onExit = fn;
      },
      resize() {},
      kill() {
        this.killed = true;
      },
    };
    terms.push(term);
    return term;
  };
  return { spawn, terms };
}

const syncTimer = (fn) => fn();

describe("key helpers", () => {
  it("execKey / isWorkflowKey", () => {
    expect(execKey("r1", "s1")).toBe("run:r1:exec:s1");
    expect(isWorkflowKey("run:r1:exec:s1")).toBe(true);
    expect(isWorkflowKey("disc:x:member:y")).toBe(false);
  });
  it("isRuntimeReady", () => {
    expect(isRuntimeReady("…› ", "codex")).toBe(true);
    expect(isRuntimeReady("❯ ", "claude")).toBe(true);
    expect(isRuntimeReady("loading", "codex")).toBe(false);
  });
});

describe("ensureSession + typeInto", () => {
  it("拉起会话并用括号粘贴包裹注入，再单独回车", async () => {
    const { spawn, terms } = makeFakeSpawn();
    const mgr = createRoleSessionPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    mgr.ensureSession({ runId: "r1", execSessionId: "s1", runtime: "codex", model: "gpt-5-codex", cwd: "/repo" });
    const ok = await mgr.typeInto(execKey("r1", "s1"), "开发任务一", "codex");
    expect(ok).toBe(true);
    expect(terms[0].writes).toEqual([`${PASTE_START}开发任务一${PASTE_END}`, "\r"]);
  });

  it("幂等：同 key 重复 ensure 不重复 spawn", () => {
    const { spawn, terms } = makeFakeSpawn();
    const mgr = createRoleSessionPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    mgr.ensureSession({ runId: "r1", execSessionId: "s1", runtime: "codex", cwd: "/repo" });
    mgr.ensureSession({ runId: "r1", execSessionId: "s1", runtime: "codex", cwd: "/repo" });
    expect(terms).toHaveLength(1);
  });

  it("命令包含 runtime + model", () => {
    const { spawn, terms } = makeFakeSpawn();
    const mgr = createRoleSessionPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    mgr.ensureSession({ runId: "r1", execSessionId: "s1", runtime: "claude", model: "opus", cwd: "/repo" });
    const joined = terms[0].args.join(" ");
    expect(joined).toContain("claude --dangerously-skip-permissions --model opus");
  });

  it("只读角色（reviewer/tester）用只读沙箱参数取代 bypass（PRD §12）", () => {
    const { spawn, terms } = makeFakeSpawn();
    const mgr = createRoleSessionPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    // 只读权限：既不可写也不可提交。
    const ro = { canWriteCode: false, canCommit: false };
    mgr.ensureSession({ runId: "r1", execSessionId: "rev", runtime: "claude", model: "opus", cwd: "/repo", permissions: ro });
    const joined = terms[0].args.join(" ");
    expect(joined).toContain("claude --permission-mode plan --model opus");
    expect(joined).not.toContain("--dangerously-skip-permissions");
  });

  it("可写角色（developer/integrator）仍用 bypass 参数", () => {
    const { spawn, terms } = makeFakeSpawn();
    const mgr = createRoleSessionPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    const rw = { canWriteCode: true, canCommit: true };
    mgr.ensureSession({ runId: "r1", execSessionId: "dev", runtime: "codex", cwd: "/repo", permissions: rw });
    const joined = terms[0].args.join(" ");
    expect(joined).toContain("codex --yolo");
    expect(joined).not.toContain("--sandbox read-only");
  });

  it("isReadOnlyRole 判定", () => {
    expect(isReadOnlyRole({ canWriteCode: false, canCommit: false })).toBe(true);
    expect(isReadOnlyRole({ canWriteCode: false, canCommit: true })).toBe(false);
    expect(isReadOnlyRole({ canWriteCode: true, canCommit: false })).toBe(false);
    expect(isReadOnlyRole(null)).toBe(false);
  });

  it("死会话 typeInto 返回 false", async () => {
    const { spawn, terms } = makeFakeSpawn();
    const mgr = createRoleSessionPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    mgr.ensureSession({ runId: "r1", execSessionId: "s1", runtime: "codex", cwd: "/repo" });
    terms[0]._onExit();
    expect(mgr.has(execKey("r1", "s1"))).toBe(false);
    expect(await mgr.typeInto(execKey("r1", "s1"), "x", "codex")).toBe(false);
  });
});

describe("closeSession / closeRun", () => {
  it("closeSession kill 单会话", () => {
    const { spawn, terms } = makeFakeSpawn();
    const mgr = createRoleSessionPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    mgr.ensureSession({ runId: "r1", execSessionId: "s1", runtime: "codex", cwd: "/repo" });
    expect(mgr.closeSession("r1", "s1")).toBe(1);
    expect(terms[0].killed).toBe(true);
    expect(mgr.has(execKey("r1", "s1"))).toBe(false);
  });
  it("closeRun kill 运行下全部会话", () => {
    const { spawn, terms } = makeFakeSpawn();
    const mgr = createRoleSessionPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    mgr.ensureSession({ runId: "r1", execSessionId: "s1", runtime: "codex", cwd: "/repo" });
    mgr.ensureSession({ runId: "r1", execSessionId: "s2", runtime: "codex", cwd: "/repo" });
    mgr.ensureSession({ runId: "r2", execSessionId: "s3", runtime: "codex", cwd: "/repo" });
    expect(mgr.closeRun("r1")).toBe(2);
    expect(mgr.has(execKey("r2", "s3"))).toBe(true);
  });
});
