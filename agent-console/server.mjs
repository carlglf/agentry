import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import { WebSocketServer } from "ws";
import { createStore } from "./server/discussion-store.mjs";
import { createMemberPtyManager, isDiscussionKey } from "./server/discussion-pty.mjs";
import { handleDiscussionApi } from "./server/discussion-routes.mjs";
import { createModelDiscovery } from "./server/model-discovery.mjs";
import { createWorkflowStore } from "./server/workflow-store.mjs";
import { createRoleSessionPtyManager, isWorkflowKey } from "./server/workflow-pty.mjs";
import { createGitRunner } from "./server/workflow-git.mjs";
import { handleWorkflowApi, recoverRuns } from "./server/workflow-routes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "127.0.0.1";
const runtimeConfigs = new Map();
const sessions = new Map();
const MAX_TRANSCRIPT_CHARS = 240_000;

const runtimeMeta = {
  codex: {
    label: "Codex",
    command: "codex",
    yoloArgs: ["--yolo"],
    // 只读角色（reviewer/tester）改用运行时只读沙箱（best-effort，按已安装 CLI 版本可微调）。
    readonlyArgs: ["--sandbox", "read-only"],
    defaultModel: "gpt-5-codex",
    models: [
      { value: "gpt-5-codex", label: "GPT-5 Codex" },
      { value: "gpt-5", label: "GPT-5" },
      { value: "gpt-5-mini", label: "GPT-5 mini" },
      { value: "o3", label: "o3" },
    ],
  },
  claude: {
    label: "Claude",
    command: "claude",
    yoloArgs: ["--dangerously-skip-permissions"],
    // 只读角色（reviewer/tester）改用 plan 权限模式（只读，best-effort）。
    readonlyArgs: ["--permission-mode", "plan"],
    defaultModel: "sonnet",
    models: [
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
      { value: "fable", label: "Fable" },
      { value: "claude-fable-5", label: "Claude Fable 5" },
    ],
  },
};

// 讨论组：server 端 JSON 持久化 + 成员 PTY 管理（独立于上面按 agentId 的 sessions map）。
const discStore = createStore({
  dataDir: process.env.AGENT_CONSOLE_DATA_DIR || path.join(__dirname, ".data"),
});
await discStore.load();
const ptyMgr = createMemberPtyManager({ spawn: pty.spawn, runtimeMeta });

// 自动开发编排（流程运行）：独立的 store / 角色执行会话 PTY 管理 / git 抽象层。
const wfStore = createWorkflowStore({
  dataDir: process.env.AGENT_CONSOLE_DATA_DIR || path.join(__dirname, ".data"),
});
await wfStore.load();
const roleSessionPtyMgr = createRoleSessionPtyManager({ spawn: pty.spawn, runtimeMeta });
// 生产用 execFile 包装为统一的 (file, args, {cwd}) => {code, stdout, stderr}。
const gitRunner = createGitRunner({
  exec: (file, args, opts = {}) =>
    new Promise((resolve) => {
      execFile(file, args, { cwd: opts.cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: stdout || "", stderr: stderr || "" });
      });
    }),
});

// 实时模型发现：codex app-server `model/list` + claude SDK supportedModels()，
// 失败回退到上面写死的 runtimeMeta。启动时后台预热一次，避免首屏等待。
const modelDiscovery = createModelDiscovery({ baseMeta: runtimeMeta });
modelDiscovery.refresh().catch(() => undefined);

// 服务重启恢复：对进行中的运行（running/integrating）从持久化状态 + 交接产物重建当前阶段
// 执行会话并重注入提示词（PRD §7.6/§10.2）。失败不影响服务启动。
recoverRuns({ wfStore, ptyMgr: roleSessionPtyMgr, gitRunner, runtimeMeta, host, port }).catch(() => undefined);

let vite;

const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }

    if (!isProduction) {
      vite.middlewares(req, res);
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Internal server error" });
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host}`);
  if (!requestUrl.pathname.startsWith("/api/tty/")) {
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host}`);
  const agentId = decodeURIComponent(requestUrl.pathname.replace("/api/tty/", ""));

  // 讨论组成员终端：key 形如 disc:<sessionId>:member:<memberId>，由 ptyMgr 托管。
  if (isDiscussionKey(agentId)) {
    ptyMgr.attachClient(agentId, ws);
    return;
  }

  // 流程运行角色执行会话终端：key 形如 run:<runId>:exec:<execSessionId>。
  if (isWorkflowKey(agentId)) {
    roleSessionPtyMgr.attachClient(agentId, ws);
    return;
  }

  const config = runtimeConfigs.get(agentId);

  if (!config) {
    ws.send("\r\n[agent-console] Missing runtime config. Save or select this Agent again.\r\n");
    ws.close(1008, "missing runtime config");
    return;
  }

  startPtySession(agentId, config, ws);
});

if (!isProduction) {
  // vite 仅开发态需要；动态导入，使生产独立包无需打包 vite。
  const { createServer: createViteServer } = await import("vite");
  vite = await createViteServer({
    appType: "spa",
    server: {
      hmr: { server, host, clientPort: port, protocol: "ws" },
      middlewareMode: true,
    },
  });
}

server.listen(port, host, () => {
  console.log(`Agent Console running at http://${host}:${port}/`);
});

async function handleApi(req, res) {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "GET" && requestUrl.pathname === "/api/runtime-meta") {
    sendJson(res, 200, await modelDiscovery.getRuntimeMeta());
    return;
  }

  const runtimeMatch = requestUrl.pathname.match(/^\/api\/agents\/([^/]+)\/runtime$/);
  if (runtimeMatch && req.method === "POST") {
    const body = await readJson(req);
    const agentId = decodeURIComponent(runtimeMatch[1]);
    runtimeConfigs.set(agentId, body);
    sendJson(res, 200, {
      ok: true,
      command: buildCommandPreview(body.agent, body.project),
    });
    return;
  }

  const inputMatch = requestUrl.pathname.match(/^\/api\/agents\/([^/]+)\/input$/);
  if (inputMatch && req.method === "POST") {
    const body = await readJson(req);
    const agentId = decodeURIComponent(inputMatch[1]);
    const session = sessions.get(agentId);
    if (!session?.term) {
      sendJson(res, 409, { error: "TTY session is not running" });
      return;
    }

    session.term.write(String(body.data || ""));
    sendJson(res, 200, { ok: true });
    return;
  }

  const stopMatch = requestUrl.pathname.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (stopMatch && req.method === "POST") {
    const agentId = decodeURIComponent(stopMatch[1]);
    stopSession(agentId);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (
    await handleWorkflowApi(req, res, {
      wfStore,
      discStore,
      ptyMgr: roleSessionPtyMgr,
      gitRunner,
      runtimeMeta,
      host,
      port,
      readJson,
      sendJson,
    })
  ) {
    return;
  }

  if (
    await handleDiscussionApi(req, res, {
      store: discStore,
      ptyMgr,
      runtimeMeta,
      host,
      port,
      readJson,
      sendJson,
    })
  ) {
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function startPtySession(agentId, config, ws) {
  const existing = sessions.get(agentId);
  if (existing) {
    existing.config = config;
    attachClient(existing, ws);
    return;
  }

  const { agent, project } = config;
  const command = buildCommandPreview(agent, project);
  const session = {
    agentId,
    config,
    term: null,
    clients: new Set(),
    transcript: "",
  };
  sessions.set(agentId, session);
  attachClient(session, ws);

  appendSessionOutput(session, `\r\n[agent-console] ${agent.name} -> ${command}\r\n`);

  resolveWorkingDirectory(agent, project)
    .then(({ cwd, requestedCwd }) => {
      if (sessions.get(agentId) !== session) return;
      if (cwd !== requestedCwd) {
        appendSessionOutput(session, `[agent-console] requested cwd unavailable: ${requestedCwd}\r\n`);
        appendSessionOutput(session, `[agent-console] using fallback cwd: ${cwd}\r\n\r\n`);
      } else {
        appendSessionOutput(session, `[agent-console] cwd: ${cwd}\r\n\r\n`);
      }

      const shell = process.env.SHELL || "/bin/bash";
      const shellArgs =
        process.platform === "win32"
          ? ["/d", "/s", "/k", command]
          : [
              "-lc",
              `${command}
agent_console_status=$?
printf '\\r\\n[agent-console] command exited: code=%s\\r\\n' "$agent_console_status"
exec "${shell}" -l`,
            ];
      const term = pty.spawn(shell, shellArgs, {
        name: "xterm-256color",
        cols: Number(config.cols || 120),
        rows: Number(config.rows || 34),
        cwd,
        env: {
          ...process.env,
          AGENT_CONSOLE: "1",
          AGENT_CONSOLE_YOLO: "1",
          FORCE_COLOR: "1",
        },
      });

      session.term = term;
      term.onData((data) => {
        appendSessionOutput(session, data);
      });
      term.onExit(({ exitCode, signal }) => {
        appendSessionOutput(session, `\r\n[agent-console] shell exited: code=${exitCode} signal=${signal ?? "none"}\r\n`);
        for (const client of session.clients) client.close();
        if (sessions.get(agentId) === session) sessions.delete(agentId);
      });
    })
    .catch((error) => {
      if (sessions.get(agentId) !== session) return;
      appendSessionOutput(session, `[agent-console] failed to resolve cwd: ${error instanceof Error ? error.message : String(error)}\r\n`);
      for (const client of session.clients) client.close(1008, "invalid cwd");
      if (sessions.get(agentId) === session) sessions.delete(agentId);
    });
}

function attachClient(session, ws) {
  session.clients.add(ws);
  if (session.transcript) ws.send(session.transcript);

  ws.on("message", (payload) => {
    const text = payload.toString();
    try {
      const event = JSON.parse(text);
      if (event.type === "input") {
        session.term?.write(event.data || "");
      }
      if (event.type === "resize" && session.term) {
        session.term.resize(Number(event.cols || 120), Number(event.rows || 34));
      }
    } catch {
      session.term?.write(text);
    }
  });

  ws.on("close", () => {
    session.clients.delete(ws);
  });
}

function appendSessionOutput(session, data) {
  session.transcript += data;
  if (session.transcript.length > MAX_TRANSCRIPT_CHARS) {
    session.transcript = session.transcript.slice(-MAX_TRANSCRIPT_CHARS);
  }
  for (const client of session.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

async function resolveWorkingDirectory(agent, project) {
  const requestedCwd = path.resolve(String(agent.workdir || project.rootPath || process.cwd()));
  const candidates = [requestedCwd, project.rootPath, process.cwd()]
    .filter(Boolean)
    .map((candidate) => path.resolve(String(candidate)));
  const uniqueCandidates = [...new Set(candidates)];

  for (const candidate of uniqueCandidates) {
    try {
      await fs.access(candidate);
      return { cwd: candidate, requestedCwd };
    } catch {
      // Try the next configured fallback.
    }
  }

  throw new Error(uniqueCandidates.join(", "));
}

function stopSession(agentId) {
  const session = sessions.get(agentId);
  if (session) {
    session.term?.kill();
    for (const client of session.clients) client.close();
    sessions.delete(agentId);
  }
}

function buildCommandPreview(agent, project) {
  const runtime = runtimeMeta[agent.runtime] ? agent.runtime : "codex";
  const meta = runtimeMeta[runtime];
  const fallback = `${meta.command} ${meta.yoloArgs.join(" ")}${agent.model ? ` --model ${agent.model}` : ""}`;
  return String(agent.startCommand || fallback).trim();
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url || "/", "http://local").pathname);
  const distDir = path.join(__dirname, "dist");
  const requested = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const filePath = path.normalize(path.join(distDir, requested));

  if (!filePath.startsWith(distDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    const target = stat.isDirectory() ? path.join(filePath, "index.html") : filePath;
    const body = await fs.readFile(target);
    res.writeHead(200, { "content-type": contentType(target) });
    res.end(body);
  } catch {
    const body = await fs.readFile(path.join(distDir, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  }
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}
