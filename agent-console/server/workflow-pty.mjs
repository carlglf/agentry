// 角色执行会话 PTY 生命周期（PRD §5.7）。与 discussion-pty.mjs 同构：唯一接触 node-pty 的流程模块；
// spawn / makeTimer 注入以便测试。会话 key 形如 run:<runId>:exec:<execSessionId>。

import process from "node:process";

const MAX_TRANSCRIPT_CHARS = 240_000;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export function execKey(runId, execSessionId) {
  return `run:${runId}:exec:${execSessionId}`;
}

export function isWorkflowKey(key) {
  return typeof key === "string" && key.startsWith("run:");
}

/** 只读角色：既不可写代码也不可提交（如 reviewer/tester）。 */
export function isReadOnlyRole(permissions) {
  if (!permissions) return false;
  return !permissions.canWriteCode && !permissions.canCommit;
}

function stripAnsi(s) {
  return String(s)
    .replace(/\][^]*(?:|\\)/g, "")
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[@-Z\\-_]/g, "");
}

const READY_MARKERS = {
  codex: [/›/, /\bReady\b[\s\S]{0,200}\b\d+% left\b/],
  claude: [/❯/, /\? for shortcuts/],
};

export function isRuntimeReady(text, runtime) {
  if (!text) return false;
  const clean = stripAnsi(text);
  const markers = READY_MARKERS[runtime] || READY_MARKERS.codex;
  return markers.some((re) => re.test(clean));
}

/**
 * @param {object} opts
 * @param {Function} opts.spawn       node-pty 的 spawn（测试中替换为 fake）
 * @param {object}   opts.runtimeMeta runtime → { command, yoloArgs, ... }
 * @param {Function} [opts.makeTimer] (fn, ms) => void，默认 setTimeout
 */
export function createRoleSessionPtyManager({ spawn, runtimeMeta, makeTimer }) {
  const sessions = new Map(); // key -> { key, runId, execSessionId, term, clients, transcript, dead }
  const timer = makeTimer || ((fn, ms) => setTimeout(fn, ms));

  function buildCommand({ runtime, model, permissions }) {
    const rt = runtimeMeta[runtime] ? runtime : "codex";
    const meta = runtimeMeta[rt];
    const m = model ? ` --model ${model}` : "";
    // 只读角色（reviewer/tester：!canWriteCode && !canCommit）改用运行时只读沙箱参数取代 bypass，
    // 从运行时层强制其不可写/不可提交，而非仅靠提示词约束（PRD §12）。
    const readonly = isReadOnlyRole(permissions);
    const args = (readonly && Array.isArray(meta.readonlyArgs) ? meta.readonlyArgs : meta.yoloArgs) || [];
    return `${meta.command} ${args.join(" ")}${m}`.trim();
  }

  function append(session, data) {
    session.transcript += data;
    if (session.transcript.length > MAX_TRANSCRIPT_CHARS) {
      session.transcript = session.transcript.slice(-MAX_TRANSCRIPT_CHARS);
    }
    for (const client of session.clients) {
      if (client.readyState === 1) client.send(data);
    }
  }

  function buildShellArgs(command, shell) {
    if (process.platform === "win32") return ["/d", "/s", "/k", command];
    return [
      "-lc",
      `${command}
agent_console_status=$?
printf '\\r\\n[agent-console] command exited: code=%s\\r\\n' "$agent_console_status"
exec "${shell}" -l`,
    ];
  }

  /**
   * 拉起角色执行会话 PTY（幂等：已存在且存活则复用）。
   * @param {object} a { runId, execSessionId, runtime, model, label, cwd, cols, rows, env }
   */
  function ensureSession({ runId, execSessionId, runtime, model, label, cwd, cols, rows, env, permissions }) {
    const key = execKey(runId, execSessionId);
    const existing = sessions.get(key);
    if (existing && existing.term && !existing.dead) return existing;

    const command = buildCommand({ runtime, model, permissions });
    const session = existing || {
      key,
      runId,
      execSessionId,
      term: null,
      clients: new Set(),
      transcript: "",
      dead: false,
    };
    session.dead = false;
    sessions.set(key, session);
    append(session, `\r\n[agent-console] ${label || execSessionId} -> ${command}\r\n`);

    const shell = process.env.SHELL || "/bin/bash";
    const term = spawn(shell, buildShellArgs(command, shell), {
      name: "xterm-256color",
      cols: Number(cols || 120),
      rows: Number(rows || 34),
      cwd,
      env: { ...process.env, ...env },
    });
    session.term = term;
    term.onData((data) => append(session, data));
    term.onExit(() => {
      session.dead = true;
      for (const client of session.clients) client.close();
    });
    return session;
  }

  function waitForQuiet(key, { quietMs = 300, pollMs = 100, maxWaitMs = 4000 } = {}) {
    const session = sessions.get(key);
    if (!session || !session.term || session.dead) return Promise.resolve(false);
    const maxAttempts = Math.max(1, Math.ceil(maxWaitMs / pollMs));
    const quietNeeded = Math.max(1, Math.ceil(quietMs / pollMs));
    return new Promise((resolve) => {
      let attempts = 0;
      let quietRun = 0;
      let lastLen = session.transcript.length;
      const tick = () => {
        const s = sessions.get(key);
        if (!s || !s.term || s.dead) return resolve(false);
        if (s.transcript.length === lastLen) {
          quietRun += 1;
          if (quietRun >= quietNeeded) return resolve(true);
        } else {
          quietRun = 0;
          lastLen = s.transcript.length;
        }
        attempts += 1;
        if (attempts >= maxAttempts) return resolve(true);
        timer(tick, pollMs);
      };
      timer(tick, pollMs);
    });
  }

  /** 括号粘贴包裹注入，再单独发回车提交（与讨论组同一套修复，见 discussion-pty 说明）。 */
  function typeInto(key, text, _runtime) {
    const session = sessions.get(key);
    if (!session || !session.term || session.dead) return Promise.resolve(false);
    session.term.write(`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`);
    return waitForQuiet(key).then(() => {
      const s = sessions.get(key);
      if (!s || !s.term || s.dead) return false;
      s.term.write("\r");
      return true;
    });
  }

  function waitForReady(key, runtime, { timeoutMs = 20000, pollMs = 400 } = {}) {
    const session = sessions.get(key);
    if (!session || !session.term || session.dead) return Promise.resolve(false);
    if (isRuntimeReady(session.transcript, runtime)) return Promise.resolve(true);
    const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
    return new Promise((resolve) => {
      let attempts = 0;
      const tick = () => {
        const s = sessions.get(key);
        if (!s || !s.term || s.dead) return resolve(false);
        if (isRuntimeReady(s.transcript, runtime)) return resolve(true);
        attempts += 1;
        if (attempts >= maxAttempts) return resolve(false);
        timer(tick, pollMs);
      };
      timer(tick, pollMs);
    });
  }

  function attachClient(key, ws) {
    const session = sessions.get(key);
    if (!session) {
      ws.send("\r\n[agent-console] 该角色执行会话不存在或已关闭。\r\n");
      ws.close(1008, "no workflow exec session");
      return;
    }
    session.clients.add(ws);
    if (session.transcript) ws.send(session.transcript);
    ws.on("message", (payload) => {
      const raw = payload.toString();
      try {
        const event = JSON.parse(raw);
        if (event.type === "input") session.term?.write(event.data || "");
        if (event.type === "resize" && session.term) {
          session.term.resize(Number(event.cols || 120), Number(event.rows || 34));
        }
      } catch {
        session.term?.write(raw);
      }
    });
    ws.on("close", () => session.clients.delete(ws));
  }

  function transcriptFor(key) {
    return sessions.get(key)?.transcript || "";
  }

  function has(key) {
    const s = sessions.get(key);
    return !!(s && s.term && !s.dead);
  }

  function get(key) {
    return sessions.get(key) || null;
  }

  /** 关闭单个执行会话（任务通过提交后关闭其开发会话，PRD §7.6）。 */
  function closeSession(runId, execSessionId) {
    const key = execKey(runId, execSessionId);
    const session = sessions.get(key);
    if (!session) return 0;
    session.term?.kill();
    for (const client of session.clients) client.close();
    sessions.delete(key);
    return 1;
  }

  /** 关闭整个运行下的全部执行会话（终止运行时）。 */
  function closeRun(runId) {
    const prefix = `run:${runId}:exec:`;
    let killed = 0;
    for (const [key, session] of sessions) {
      if (!key.startsWith(prefix)) continue;
      session.term?.kill();
      for (const client of session.clients) client.close();
      sessions.delete(key);
      killed += 1;
    }
    return killed;
  }

  return {
    ensureSession,
    typeInto,
    waitForReady,
    waitForQuiet,
    attachClient,
    transcriptFor,
    has,
    get,
    closeSession,
    closeRun,
    execKey,
  };
}
