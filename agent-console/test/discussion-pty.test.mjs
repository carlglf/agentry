import { describe, it, expect } from "vitest";
import { createMemberPtyManager, memberKey, isRuntimeReady } from "../server/discussion-pty.mjs";

const ESC = String.fromCharCode(27);

const runtimeMeta = {
  codex: { command: "codex", yoloArgs: ["--yolo"], defaultModel: "gpt-5-codex" },
  claude: { command: "claude", yoloArgs: ["--dangerously-skip-permissions"], defaultModel: "sonnet" },
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

// 同步执行的 timer，便于断言 codex 的延时回车
const syncTimer = (fn) => fn();

const member = (over = {}) => ({
  id: over.id || "m1",
  name: over.name || "张三",
  runtime: over.runtime || "codex",
  model: over.model || "gpt-5-codex",
  ...over,
});

describe("memberKey", () => {
  it("格式为 disc:<sid>:member:<mid>", () => {
    expect(memberKey("s1", "m1")).toBe("disc:s1:member:m1");
  });
});

describe("ensureMember", () => {
  it("拉起成员并使用正确命令；幂等不重复 spawn", () => {
    const { spawn, terms } = makeFakeSpawn();
    const mgr = createMemberPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    const m = member({ runtime: "codex", model: "gpt-5" });
    mgr.ensureMember({ sessionId: "s1", member: m, cwd: "/tmp" });
    mgr.ensureMember({ sessionId: "s1", member: m, cwd: "/tmp" });
    expect(terms).toHaveLength(1);
    // 命令出现在 transcript 头部
    expect(mgr.transcriptFor(memberKey("s1", "m1"))).toContain("codex --yolo --model gpt-5");
    expect(mgr.has(memberKey("s1", "m1"))).toBe(true);
  });

  it("注入的 env 传给 spawn", () => {
    const { spawn, terms } = makeFakeSpawn();
    const mgr = createMemberPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    mgr.ensureMember({
      sessionId: "s1",
      member: member(),
      cwd: "/tmp",
      env: { AGENT_CONSOLE_SESSION_ID: "s1", AGENT_CONSOLE_MEMBER_ID: "m1" },
    });
    expect(terms[0].opts.env.AGENT_CONSOLE_SESSION_ID).toBe("s1");
    expect(terms[0].opts.env.AGENT_CONSOLE_MEMBER_ID).toBe("m1");
  });
});

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

describe("typeInto", () => {
  it("codex：内容用括号粘贴包裹写入，再单独写回车（大段多行才能提交）", async () => {
    const { spawn, terms } = makeFakeSpawn();
    const mgr = createMemberPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    mgr.ensureMember({ sessionId: "s1", member: member({ runtime: "codex" }), cwd: "/tmp" });
    const ok = await mgr.typeInto(memberKey("s1", "m1"), "你好", "codex");
    expect(ok).toBe(true);
    expect(terms[0].writes).toEqual([`${PASTE_START}你好${PASTE_END}`, "\r"]);
  });

  it("claude：同样用括号粘贴包裹，再单独写回车", async () => {
    const { spawn, terms } = makeFakeSpawn();
    const mgr = createMemberPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    mgr.ensureMember({
      sessionId: "s1",
      member: member({ id: "m2", runtime: "claude", model: "sonnet" }),
      cwd: "/tmp",
    });
    const ok = await mgr.typeInto(memberKey("s1", "m2"), "hi", "claude");
    expect(ok).toBe(true);
    expect(terms[0].writes).toEqual([`${PASTE_START}hi${PASTE_END}`, "\r"]);
  });

  it("目标不存在返回 false（丢轮信号）", async () => {
    const { spawn } = makeFakeSpawn();
    const mgr = createMemberPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    expect(await mgr.typeInto(memberKey("s1", "nope"), "x", "codex")).toBe(false);
  });
});

describe("isRuntimeReady", () => {
  it("codex：出现输入框 › 视为就绪", () => {
    expect(isRuntimeReady(`${ESC}[2J  Ready\n› `, "codex")).toBe(true);
  });
  it("claude：出现 ❯ 或 ? for shortcuts 视为就绪", () => {
    expect(isRuntimeReady(`${ESC}[0m❯ `, "claude")).toBe(true);
    expect(isRuntimeReady("? for shortcuts", "claude")).toBe(true);
  });
  it("仅启动噪声不算就绪", () => {
    expect(isRuntimeReady(`${ESC}[2J loading codex...`, "codex")).toBe(false);
    expect(isRuntimeReady("starting up", "claude")).toBe(false);
    expect(isRuntimeReady("", "codex")).toBe(false);
  });
});

describe("waitForReady", () => {
  it("transcript 已就绪时立即 resolve true", async () => {
    const { spawn, terms } = makeFakeSpawn();
    const mgr = createMemberPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    mgr.ensureMember({ sessionId: "s1", member: member({ runtime: "codex" }), cwd: "/tmp" });
    terms[0]._onData(`${ESC}[2J Ready\n› `);
    expect(await mgr.waitForReady(memberKey("s1", "m1"), "codex")).toBe(true);
  });

  it("一直不就绪则超时 resolve false（不卡死）", async () => {
    const { spawn } = makeFakeSpawn();
    const mgr = createMemberPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    mgr.ensureMember({ sessionId: "s1", member: member({ runtime: "codex" }), cwd: "/tmp" });
    expect(await mgr.waitForReady(memberKey("s1", "m1"), "codex", { timeoutMs: 800, pollMs: 200 })).toBe(false);
  });

  it("目标不存在直接返回 false", async () => {
    const { spawn } = makeFakeSpawn();
    const mgr = createMemberPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    expect(await mgr.waitForReady(memberKey("s1", "nope"), "codex")).toBe(false);
  });
});

describe("closeSession", () => {
  it("只 kill 指定 session 的成员", () => {
    const { spawn } = makeFakeSpawn();
    const mgr = createMemberPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    mgr.ensureMember({ sessionId: "s1", member: member({ id: "a" }), cwd: "/tmp" });
    mgr.ensureMember({ sessionId: "s1", member: member({ id: "b" }), cwd: "/tmp" });
    mgr.ensureMember({ sessionId: "s2", member: member({ id: "c" }), cwd: "/tmp" });

    const killed = mgr.closeSession("s1");
    expect(killed).toBe(2);
    expect(mgr.has(memberKey("s1", "a"))).toBe(false);
    expect(mgr.has(memberKey("s1", "b"))).toBe(false);
    expect(mgr.has(memberKey("s2", "c"))).toBe(true);
  });
});

describe("sessionMembersAlive", () => {
  it("全部存活才为 true", () => {
    const { spawn } = makeFakeSpawn();
    const mgr = createMemberPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    mgr.ensureMember({ sessionId: "s1", member: member({ id: "a" }), cwd: "/tmp" });
    expect(mgr.sessionMembersAlive("s1", ["a"])).toBe(true);
    expect(mgr.sessionMembersAlive("s1", ["a", "b"])).toBe(false);
  });
});

describe("attachClient", () => {
  it("重放 transcript 给新接入的客户端", () => {
    const { spawn } = makeFakeSpawn();
    const mgr = createMemberPtyManager({ spawn, runtimeMeta, makeTimer: syncTimer });
    mgr.ensureMember({ sessionId: "s1", member: member(), cwd: "/tmp" });
    const sent = [];
    const ws = {
      readyState: 1,
      send: (d) => sent.push(d),
      on: () => {},
      close: () => {},
    };
    mgr.attachClient(memberKey("s1", "m1"), ws);
    expect(sent.join("")).toContain("codex --yolo");
  });
});
