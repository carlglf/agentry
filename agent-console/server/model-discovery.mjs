// 实时探测各 runtime 的可用模型列表（独立于交互式 PTY）。
//   codex：spawn `codex app-server`，走 JSON-RPC 2.0 over stdio，initialize → model/list。
//   claude：用 @anthropic-ai/claude-agent-sdk 的 query().supportedModels()。
// 探测失败一律回退到写死的 baseMeta，绝不抛错阻断启动。
// spawn / claudeQuery 通过注入传入，便于在测试中用 fake 替身（无需真实 codex/claude）。

import { spawn as nodeSpawn } from "node:child_process";

/** 从 codex app-server `model/list` 的结果里抽出 [{value,label,isDefault}]（纯函数）。 */
export function parseCodexModels(result) {
  const arr = (result && (result.data || result.models)) || [];
  const out = arr
    .filter((m) => m && (m.id || m.model) && !m.hidden)
    .map((m) => ({
      value: m.id || m.model,
      label: m.displayName || m.name || m.id || m.model,
      isDefault: !!m.isDefault,
    }));
  return out.length ? out : null;
}

/** 从 claude SDK supportedModels() 的结果里抽出 [{value,label,isDefault}]（纯函数）。 */
export function parseClaudeModels(models) {
  const arr = Array.isArray(models) ? models : [];
  const out = arr
    .filter((m) => m && m.value)
    .map((m, index) => ({
      value: m.value,
      label: m.displayName || m.value,
      isDefault: index === 0,
    }));
  return out.length ? out : null;
}

/**
 * 起一个临时 `codex app-server` 进程,做 JSON-RPC 握手后调 model/list,拿到列表即 kill。
 * 任意异常/超时都 resolve(null),交由上层回退。
 * @returns {Promise<Array<{value,label,isDefault}>|null>}
 */
export function discoverCodexModels({ spawn = nodeSpawn, timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return resolve(null);
    }

    let buf = "";
    let idc = 0;
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      resolve(val);
    };
    const req = (method, params) => {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++idc, method, params: params || {} })}\n`); } catch { /* ignore */ }
    };
    const notify = (method, params) => {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: params || {} })}\n`); } catch { /* ignore */ }
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.stderr?.on?.("data", () => { /* drain to avoid backpressure */ });
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          // initialize 应答 → 发 initialized 通知,再请求 model/list
          notify("initialized");
          req("model/list", {});
        } else if (msg.id === 2) {
          finish(parseCodexModels(msg.result));
        }
      }
    });

    req("initialize", { clientInfo: { name: "agent-console", title: "Agent Console", version: "0.0.0" } });
  });
}

/**
 * 用 claude SDK 拿 supportedModels()。未注入 query 时动态 import SDK（缺失则 resolve null）。
 * @returns {Promise<Array<{value,label,isDefault}>|null>}
 */
export async function discoverClaudeModels({ query, timeoutMs = 15000 } = {}) {
  let q = query;
  if (!q) {
    try {
      ({ query: q } = await import("@anthropic-ai/claude-agent-sdk"));
    } catch {
      return null;
    }
  }
  let instance;
  try {
    instance = q({
      prompt: "",
      options: { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
    });
    const models = await Promise.race([
      instance.supportedModels(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return parseClaudeModels(models);
  } catch {
    return null;
  } finally {
    try { instance?.close?.(); } catch { /* ignore */ }
  }
}

/** 把探测到的模型合并进某个 runtime 的 meta（探测为空则保留 base）。 */
export function mergeRuntimeModels(baseEntry, discovered) {
  if (!discovered || !discovered.length) return { ...baseEntry };
  const models = discovered.map(({ value, label }) => ({ value, label }));
  const defaultEntry = discovered.find((m) => m.isDefault) || discovered[0];
  return { ...baseEntry, models, defaultModel: defaultEntry.value };
}

/**
 * 创建带缓存的模型发现器。getRuntimeMeta() 返回合并了实时模型的 runtimeMeta 副本;
 * 探测在后台进行,失败回退到 baseMeta。
 * @param {object} opts
 * @param {object} opts.baseMeta     写死的 runtimeMeta（回退用）
 * @param {Function} [opts.spawn]    注入 node child_process spawn
 * @param {Function} [opts.claudeQuery] 注入 claude SDK query（测试用）
 * @param {number}  [opts.ttlMs]     缓存有效期,默认 5 分钟
 * @param {Function} [opts.now]      注入时钟,默认 Date.now
 */
export function createModelDiscovery({ baseMeta, spawn, claudeQuery, ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  let cache = null; // { codex, claude } —— 探测结果（可为 null）
  let cachedAt = 0;
  let inflight = null;

  async function probe() {
    const [codex, claude] = await Promise.all([
      discoverCodexModels({ spawn }).catch(() => null),
      discoverClaudeModels({ query: claudeQuery }).catch(() => null),
    ]);
    cache = { codex, claude };
    cachedAt = now();
    return cache;
  }

  function refresh() {
    if (!inflight) {
      inflight = probe().finally(() => { inflight = null; });
    }
    return inflight;
  }

  function merged() {
    const out = {};
    for (const key of Object.keys(baseMeta)) {
      const discovered = cache ? cache[key] : null;
      out[key] = mergeRuntimeModels(baseMeta[key], discovered);
    }
    return out;
  }

  /** 返回合并后的 runtimeMeta;缓存过期则触发后台刷新(本次仍返回旧值/回退,不阻塞)。 */
  async function getRuntimeMeta({ wait = false } = {}) {
    const stale = !cache || now() - cachedAt > ttlMs;
    if (stale) {
      const p = refresh();
      if (wait) await p;
    }
    return merged();
  }

  return { getRuntimeMeta, refresh, merged };
}
