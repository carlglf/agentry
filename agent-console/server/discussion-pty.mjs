// 讨论组成员 PTY 生命周期管理。唯一接触 node-pty 的模块；
// spawn / makeTimer 通过注入传入，便于在测试中用 fake 替身，无需真实 codex/claude。

import process from "node:process";

const MAX_TRANSCRIPT_CHARS = 240_000;

// 括号粘贴(bracketed paste)标记：包裹注入内容，让 codex/claude 的 TUI 把它当成「一段完整粘贴」，
// 从而其后单独发送的回车才会被识别为提交而非被并入粘贴块。见 typeInto 的说明。
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export function memberKey(sessionId, memberId) {
  return `disc:${sessionId}:member:${memberId}`;
}

export function isDiscussionKey(key) {
  return typeof key === "string" && key.startsWith("disc:");
}

// 去掉 ANSI/控制序列，便于在原始 transcript 上做就绪判定。
function stripAnsi(s) {
  return String(s)
    .replace(/\][^]*(?:|\\)/g, "") // OSC
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/[@-Z\\-_]/g, ""); // 其它单字符 escape
}

// 各 runtime 的 TUI「就绪可接收输入」标志（移植自前端 isReadyTail 的关键标记）。
// codex 就绪后显示 `›` 输入框；claude 显示 `❯` 提示符或 "? for shortcuts"。
const READY_MARKERS = {
  codex: [/›/, /\bReady\b[\s\S]{0,200}\b\d+% left\b/],
  claude: [/❯/, /\? for shortcuts/],
};

/** 从 PTY transcript 粗判某 runtime 的 TUI 是否已就绪可接收输入。 */
export function isRuntimeReady(text, runtime) {
  if (!text) return false;
  const clean = stripAnsi(text);
  const markers = READY_MARKERS[runtime] || READY_MARKERS.codex;
  return markers.some((re) => re.test(clean));
}

/**
 * @param {object} opts
 * @param {Function} opts.spawn         node-pty 的 spawn（测试中替换为 fake）
 * @param {object}   opts.runtimeMeta   runtime → {command, yoloArgs, ...}
 * @param {Function} [opts.makeTimer]   (fn, ms) => void，默认 setTimeout；测试可注入同步执行
 */
export function createMemberPtyManager({ spawn, runtimeMeta, makeTimer }) {
  const sessions = new Map(); // key -> { key, sessionId, memberId, term, clients:Set, transcript }
  const timer = makeTimer || ((fn, ms) => setTimeout(fn, ms));

  function buildMemberCommand(member) {
    const runtime = runtimeMeta[member.runtime] ? member.runtime : "codex";
    const meta = runtimeMeta[runtime];
    const model = member.model ? ` --model ${member.model}` : "";
    return `${meta.command} ${meta.yoloArgs.join(" ")}${model}`.trim();
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

  /** 拉起成员专属 PTY（若已存在且存活则复用，幂等）。 */
  function ensureMember({ sessionId, member, cwd, cols, rows, env }) {
    const key = memberKey(sessionId, member.id);
    const existing = sessions.get(key);
    if (existing && existing.term && !existing.dead) return existing;

    const command = buildMemberCommand(member);
    const session = existing || {
      key,
      sessionId,
      memberId: member.id,
      term: null,
      clients: new Set(),
      transcript: "",
      dead: false,
    };
    session.dead = false;
    sessions.set(key, session);
    append(session, `\r\n[agent-console] ${member.name} -> ${command}\r\n`);

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

  /**
   * 轮询等待某成员 PTY 输出「静默」（transcript 在 quietMs 内不再增长），用于判断 TUI 已把刚写入的
   * 多行内容渲染完毕。到 maxWaitMs 仍未静默也放行（best-effort），避免卡死。
   * @returns {Promise<boolean>} true=已静默或到上限放行；false=会话已死
   */
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

  /**
   * 把文本输入注入成员 PTY：用「括号粘贴(bracketed paste)」包裹内容，等 TUI 渲染静默后再单独发回车提交。
   *
   * 根因（经真实 codex/claude 实验复现）：codex 的 TUI 对「大段多行原始输入」会触发粘贴突发检测，
   * 把紧随其后的回车也并入「粘贴块」，于是 Enter 不触发提交、内容停在输入框——
   * 这正是「除主理人开场(内容短、不触发检测)外的交接(增量提示词大、携带别人长发言)都没发出去」的原因。
   *
   * 修复用括号粘贴标记 ESC[200~ ... ESC[201~ 显式声明「这是一段完整粘贴」，
   * 其后单独发送的 \r 才会被 TUI 当成真正的回车提交。codex / claude 同一套（两端均已验证可提交）。
   * @returns {Promise<boolean>} 是否成功送达（PTY 不存在/已死返回 false → 上层据此报丢轮）
   */
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

  /**
   * 轮询等待某成员 TUI 就绪可接收输入。刚 spawn 的 codex/claude TUI 需数秒启动，
   * 过早注入会被吞掉（开场丢失）。就绪或超时后 resolve；超时返回 false（上层仍可best-effort注入）。
   * @returns {Promise<boolean>}
   */
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

  /** 浏览器终端标签页连上某成员 PTY：复用 transcript 重放 + resize/input。 */
  function attachClient(key, ws) {
    const session = sessions.get(key);
    if (!session) {
      ws.send("\r\n[agent-console] 该成员会话不存在或已关闭。\r\n");
      ws.close(1008, "no discussion member session");
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

  /** session 内成员是否都已存活（用于 reopen / restart 后判断是否需重拉）。 */
  function sessionMembersAlive(sessionId, memberIds) {
    return memberIds.every((mid) => has(memberKey(sessionId, mid)));
  }

  /** 显式关闭会话：kill 该 session 全部成员 PTY、释放资源（决策8）。 */
  function closeSession(sessionId) {
    const prefix = `disc:${sessionId}:member:`;
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
    ensureMember,
    typeInto,
    waitForReady,
    attachClient,
    transcriptFor,
    has,
    get,
    sessionMembersAlive,
    closeSession,
    memberKey,
  };
}
