import { describe, it, expect } from "vitest";
import { parseAcgArgs, parseStageArgs, parseRunArgs, readIdentityFromEnv } from "../server/cli-args.mjs";

describe("parseAcgArgs", () => {
  it("say --next X \"内容\"", () => {
    const r = parseAcgArgs(["say", "--next", "李四", "我的发言"]);
    expect(r).toEqual({ cmd: "say", next: "李四", content: "我的发言" });
  });

  it("say --next=X 形式", () => {
    const r = parseAcgArgs(["say", "--next=李四", "内容"]);
    expect(r.next).toBe("李四");
    expect(r.content).toBe("内容");
  });

  it("say 无 positional 内容时 content 为 undefined（调用方走 stdin）", () => {
    const r = parseAcgArgs(["say", "--next", "李四"]);
    expect(r.cmd).toBe("say");
    expect(r.next).toBe("李四");
    expect(r.content).toBeUndefined();
  });

  it("say 缺少 --next 报错", () => {
    const r = parseAcgArgs(["say", "随便说"]);
    expect(r.error).toMatch(/next/);
  });

  it("end 带内容", () => {
    expect(parseAcgArgs(["end", "收尾"])).toEqual({ cmd: "end", content: "收尾" });
  });

  it("end 不带内容", () => {
    expect(parseAcgArgs(["end"])).toEqual({ cmd: "end", content: undefined });
  });

  it("serve / whoami / recap", () => {
    expect(parseAcgArgs(["serve"]).cmd).toBe("serve");
    expect(parseAcgArgs(["whoami"]).cmd).toBe("whoami");
    expect(parseAcgArgs(["recap"]).cmd).toBe("recap");
  });

  it("未知子命令报错", () => {
    expect(parseAcgArgs(["bogus"]).error).toMatch(/未知/);
  });

  it("缺少子命令报错", () => {
    expect(parseAcgArgs([]).error).toMatch(/缺少/);
  });

  it("多段 positional 合并为内容", () => {
    const r = parseAcgArgs(["say", "--next", "X", "一", "二", "三"]);
    expect(r.content).toBe("一 二 三");
  });

  it("stage / run 走专用解析", () => {
    expect(parseAcgArgs(["stage", "submit", "--type", "dev"])).toEqual({ cmd: "stage", sub: "submit", type: "dev" });
    expect(parseAcgArgs(["run", "status"])).toEqual({ cmd: "run", sub: "status" });
  });
});

describe("parseStageArgs", () => {
  it("submit --type dev --json -", () => {
    const r = parseStageArgs(["submit", "--type", "dev", "--json", "-"]);
    expect(r).toEqual({ cmd: "stage", sub: "submit", type: "dev", json: "-" });
  });
  it("submit 带 task/role/json 文件", () => {
    const r = parseStageArgs(["submit", "--type=review", "--task=a", "--role=reviewer", "--json=r.json"]);
    expect(r.type).toBe("review");
    expect(r.task).toBe("a");
    expect(r.role).toBe("reviewer");
    expect(r.json).toBe("r.json");
  });
  it("context 子命令", () => {
    expect(parseStageArgs(["context"])).toEqual({ cmd: "stage", sub: "context" });
  });
  it("缺 --type 报错", () => {
    expect(parseStageArgs(["submit"]).error).toMatch(/type/);
  });
  it("非法 type 报错", () => {
    expect(parseStageArgs(["submit", "--type", "bogus"]).error).toMatch(/未知阶段类型/);
  });
  it("未知 stage 子命令报错", () => {
    expect(parseStageArgs(["bogus"]).error).toMatch(/未知/);
  });
});

describe("parseRunArgs", () => {
  it("status/pause/resume/attention", () => {
    expect(parseRunArgs(["status"]).sub).toBe("status");
    expect(parseRunArgs(["pause"]).sub).toBe("pause");
    expect(parseRunArgs(["attention"]).sub).toBe("attention");
  });
  it("非法子命令报错", () => {
    expect(parseRunArgs(["bogus"]).error).toMatch(/用法/);
  });
});

describe("readIdentityFromEnv", () => {
  it("读取注入的讨论身份变量", () => {
    const id = readIdentityFromEnv({
      AGENT_CONSOLE_SESSION_ID: "s1",
      AGENT_CONSOLE_GROUP_ID: "g1",
      AGENT_CONSOLE_MEMBER_ID: "m1",
      AGENT_CONSOLE_API: "http://127.0.0.1:6000",
    });
    expect(id.sessionId).toBe("s1");
    expect(id.groupId).toBe("g1");
    expect(id.memberId).toBe("m1");
    expect(id.api).toBe("http://127.0.0.1:6000");
  });

  it("读取流程运行身份变量", () => {
    const id = readIdentityFromEnv({
      AGENT_CONSOLE_RUN_ID: "r1",
      AGENT_CONSOLE_TASK_ID: "t1",
      AGENT_CONSOLE_STAGE_ID: "development",
      AGENT_CONSOLE_ROLE_ID: "developer",
      AGENT_CONSOLE_EXEC_SESSION_ID: "es1",
    });
    expect(id.runId).toBe("r1");
    expect(id.taskId).toBe("t1");
    expect(id.stageId).toBe("development");
    expect(id.roleId).toBe("developer");
    expect(id.execSessionId).toBe("es1");
  });

  it("缺失时 api 有默认值", () => {
    const id = readIdentityFromEnv({});
    expect(id.api).toBe("http://127.0.0.1:5173");
    expect(id.sessionId).toBe("");
    expect(id.runId).toBe("");
  });
});
