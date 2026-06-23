import { describe, it, expect } from "vitest";
import {
  parseCodexModels,
  parseClaudeModels,
  mergeRuntimeModels,
  discoverCodexModels,
  discoverClaudeModels,
  createModelDiscovery,
} from "../server/model-discovery.mjs";

const baseMeta = {
  codex: { label: "Codex", command: "codex", yoloArgs: ["--yolo"], defaultModel: "gpt-5-codex", models: [{ value: "gpt-5-codex", label: "GPT-5 Codex" }] },
  claude: { label: "Claude", command: "claude", yoloArgs: ["--dangerously-skip-permissions"], defaultModel: "sonnet", models: [{ value: "sonnet", label: "Sonnet" }] },
};

describe("parseCodexModels", () => {
  it("从 data 数组抽 value/label/isDefault，过滤 hidden", () => {
    const out = parseCodexModels({
      data: [
        { id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true },
        { id: "gpt-5.4", displayName: "GPT-5.4" },
        { id: "secret", displayName: "Secret", hidden: true },
      ],
    });
    expect(out).toEqual([
      { value: "gpt-5.5", label: "GPT-5.5", isDefault: true },
      { value: "gpt-5.4", label: "GPT-5.4", isDefault: false },
    ]);
  });

  it("兼容 models 字段与缺失 displayName", () => {
    const out = parseCodexModels({ models: [{ model: "o4" }] });
    expect(out).toEqual([{ value: "o4", label: "o4", isDefault: false }]);
  });

  it("空结果返回 null", () => {
    expect(parseCodexModels({ data: [] })).toBeNull();
    expect(parseCodexModels(null)).toBeNull();
  });
});

describe("parseClaudeModels", () => {
  it("第一个标记为默认，displayName 缺失回退 value", () => {
    const out = parseClaudeModels([
      { value: "default", displayName: "Default (recommended)" },
      { value: "opus" },
    ]);
    expect(out).toEqual([
      { value: "default", label: "Default (recommended)", isDefault: true },
      { value: "opus", label: "opus", isDefault: false },
    ]);
  });

  it("非数组/空返回 null", () => {
    expect(parseClaudeModels(undefined)).toBeNull();
    expect(parseClaudeModels([])).toBeNull();
  });
});

describe("mergeRuntimeModels", () => {
  it("有探测结果时覆盖 models + defaultModel（取 isDefault）", () => {
    const merged = mergeRuntimeModels(baseMeta.codex, [
      { value: "gpt-5.4", label: "GPT-5.4", isDefault: false },
      { value: "gpt-5.5", label: "GPT-5.5", isDefault: true },
    ]);
    expect(merged.models).toEqual([
      { value: "gpt-5.4", label: "GPT-5.4" },
      { value: "gpt-5.5", label: "GPT-5.5" },
    ]);
    expect(merged.defaultModel).toBe("gpt-5.5");
    expect(merged.command).toBe("codex"); // 其它字段保留
  });

  it("无 isDefault 时取首个", () => {
    const merged = mergeRuntimeModels(baseMeta.claude, [{ value: "a", label: "A" }, { value: "b", label: "B" }]);
    expect(merged.defaultModel).toBe("a");
  });

  it("探测为空则原样保留 base", () => {
    expect(mergeRuntimeModels(baseMeta.codex, null)).toEqual(baseMeta.codex);
    expect(mergeRuntimeModels(baseMeta.codex, [])).toEqual(baseMeta.codex);
  });
});

// ——— fake codex app-server：模拟 JSON-RPC over stdio ———
function makeFakeCodexSpawn(modelListResult, { failSpawn = false } = {}) {
  const calls = [];
  const spawn = () => {
    if (failSpawn) throw new Error("ENOENT");
    let dataCb = null;
    const child = {
      killed: false,
      stdin: {
        write(line) {
          calls.push(line.trim());
          const msg = JSON.parse(line);
          // 模拟 server 应答：initialize→id1 result；model/list→id2 result
          if (msg.id === 1) queueMicrotask(() => dataCb?.(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`));
          if (msg.method === "model/list") queueMicrotask(() => dataCb?.(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: modelListResult })}\n`));
        },
      },
      stdout: { on: (ev, cb) => { if (ev === "data") dataCb = cb; } },
      stderr: { on: () => {} },
      on: () => {},
      kill() { this.killed = true; },
    };
    return child;
  };
  return { spawn, calls };
}

describe("discoverCodexModels", () => {
  it("跑通 initialize→initialized→model/list 并解析结果", async () => {
    const { spawn, calls } = makeFakeCodexSpawn({ data: [{ id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }] });
    const out = await discoverCodexModels({ spawn });
    expect(out).toEqual([{ value: "gpt-5.5", label: "GPT-5.5", isDefault: true }]);
    // 发过 initialize / initialized / model/list
    const methods = calls.map((c) => JSON.parse(c).method).filter(Boolean);
    expect(methods).toContain("initialized");
    expect(methods).toContain("model/list");
  });

  it("spawn 抛错返回 null（不崩）", async () => {
    const { spawn } = makeFakeCodexSpawn({}, { failSpawn: true });
    expect(await discoverCodexModels({ spawn })).toBeNull();
  });

  it("超时返回 null", async () => {
    const spawn = () => ({ stdin: { write() {} }, stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {} });
    expect(await discoverCodexModels({ spawn, timeoutMs: 30 })).toBeNull();
  });
});

describe("discoverClaudeModels", () => {
  it("用注入 query 拿 supportedModels", async () => {
    let closed = false;
    const query = () => ({
      supportedModels: async () => [{ value: "default", displayName: "Default" }, { value: "opus" }],
      close: () => { closed = true; },
    });
    const out = await discoverClaudeModels({ query });
    expect(out).toEqual([
      { value: "default", label: "Default", isDefault: true },
      { value: "opus", label: "opus", isDefault: false },
    ]);
    expect(closed).toBe(true);
  });

  it("supportedModels 抛错返回 null", async () => {
    const query = () => ({ supportedModels: async () => { throw new Error("auth"); }, close() {} });
    expect(await discoverClaudeModels({ query })).toBeNull();
  });
});

describe("createModelDiscovery", () => {
  it("合并探测结果到 runtimeMeta；探测失败回退 base", async () => {
    const { spawn } = makeFakeCodexSpawn({ data: [{ id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }] });
    const claudeQuery = () => ({ supportedModels: async () => [{ value: "opus", displayName: "Opus" }], close() {} });
    const d = createModelDiscovery({ baseMeta, spawn, claudeQuery });
    const meta = await d.getRuntimeMeta({ wait: true });
    expect(meta.codex.defaultModel).toBe("gpt-5.5");
    expect(meta.codex.models).toEqual([{ value: "gpt-5.5", label: "GPT-5.5" }]);
    expect(meta.claude.models).toEqual([{ value: "opus", label: "Opus" }]);
  });

  it("两端探测都失败时完全回退到 base", async () => {
    const spawn = () => { throw new Error("ENOENT"); };
    const claudeQuery = () => ({ supportedModels: async () => { throw new Error("x"); }, close() {} });
    const d = createModelDiscovery({ baseMeta, spawn, claudeQuery });
    const meta = await d.getRuntimeMeta({ wait: true });
    expect(meta.codex).toEqual(baseMeta.codex);
    expect(meta.claude).toEqual(baseMeta.claude);
  });

  it("ttl 内复用缓存，不重复探测", async () => {
    let codexCalls = 0;
    const spawn = () => {
      codexCalls += 1;
      let dataCb = null;
      return {
        stdin: { write(line) {
          const msg = JSON.parse(line);
          if (msg.id === 1) queueMicrotask(() => dataCb?.(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`));
          if (msg.method === "model/list") queueMicrotask(() => dataCb?.(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { data: [{ id: "m" }] } })}\n`));
        } },
        stdout: { on: (ev, cb) => { if (ev === "data") dataCb = cb; } },
        stderr: { on: () => {} },
        on: () => {},
        kill() {},
      };
    };
    let t = 1000;
    const d = createModelDiscovery({ baseMeta, spawn, claudeQuery: () => ({ supportedModels: async () => null, close() {} }), ttlMs: 5000, now: () => t });
    await d.getRuntimeMeta({ wait: true });
    await d.getRuntimeMeta({ wait: true }); // 仍在 ttl 内
    expect(codexCalls).toBe(1);
    t = 7000; // 过期
    await d.getRuntimeMeta({ wait: true });
    expect(codexCalls).toBe(2);
  });
});
