// acg CLI 参数解析（纯函数，不读 stdin / env，便于单测）。

const COMMANDS = new Set(["serve", "say", "end", "whoami", "recap", "stage", "run"]);
const STAGE_TYPES = new Set(["plan", "dev", "review", "test", "doc", "integration"]);

/**
 * 解析 acg 的命令行参数（不含 node / 脚本路径，即 process.argv.slice(2)）。
 * - acg serve
 * - acg say --next <成员名> "内容"        // 无 positional 内容时由调用方走 stdin（content 为 undefined）
 * - acg say --next <成员名> < message.txt
 * - acg end ["收尾内容"]
 * - acg whoami | acg recap
 * @returns {{ cmd?: string, next?: string, content?: string, error?: string }}
 */
export function parseAcgArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const cmd = args.shift();

  if (!cmd) {
    return { error: "缺少子命令。用法：acg <serve|say|end|whoami|recap>" };
  }
  if (!COMMANDS.has(cmd)) {
    return { error: `未知子命令：${cmd}` };
  }

  // 流程运行命令（acg stage / acg run）单独解析。
  if (cmd === "stage") return parseStageArgs(args);
  if (cmd === "run") return parseRunArgs(args);

  let next;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--next" || token === "-n") {
      next = args[i + 1];
      if (next === undefined) {
        return { cmd, error: "--next 缺少成员名参数" };
      }
      i += 1;
    } else if (token.startsWith("--next=")) {
      next = token.slice("--next=".length);
    } else {
      positional.push(token);
    }
  }

  const content = positional.length > 0 ? positional.join(" ") : undefined;

  if (cmd === "say") {
    if (!next) {
      return { cmd, error: "say 必须用 --next 提名下一位发言人" };
    }
    return { cmd, next, content };
  }

  if (cmd === "end") {
    return { cmd, content };
  }

  // serve / whoami / recap：无额外参数
  return { cmd };
}

/**
 * 解析 acg stage 子命令（流程运行结构化阶段交接）：
 *   acg stage submit --type <plan|dev|review|test|doc|integration> [--task <id>] [--role <id>] [--json <file>|-]
 *   acg stage context
 * @returns {{ cmd:'stage', sub?:string, type?:string, task?:string, role?:string, json?:string, error?:string }}
 */
export function parseStageArgs(args) {
  const sub = args.shift();
  if (!sub) return { cmd: "stage", error: "用法：acg stage <submit|context> ..." };
  if (sub === "context") return { cmd: "stage", sub: "context" };
  if (sub !== "submit") return { cmd: "stage", error: `未知 stage 子命令：${sub}` };

  const out = { cmd: "stage", sub: "submit" };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const take = () => {
      const v = args[i + 1];
      i += 1;
      return v;
    };
    if (token === "--type") out.type = take();
    else if (token.startsWith("--type=")) out.type = token.slice("--type=".length);
    else if (token === "--task") out.task = take();
    else if (token.startsWith("--task=")) out.task = token.slice("--task=".length);
    else if (token === "--role") out.role = take();
    else if (token.startsWith("--role=")) out.role = token.slice("--role=".length);
    else if (token === "--json") out.json = take() ?? "-";
    else if (token.startsWith("--json=")) out.json = token.slice("--json=".length);
  }
  if (!out.type) return { cmd: "stage", error: "stage submit 必须用 --type 指定阶段类型" };
  if (!STAGE_TYPES.has(out.type)) {
    return { cmd: "stage", error: `未知阶段类型：${out.type}（可选 ${[...STAGE_TYPES].join("/")}）` };
  }
  return out;
}

/**
 * 解析 acg run 子命令：
 *   acg run status | acg run pause | acg run attention
 * @returns {{ cmd:'run', sub?:string, error?:string }}
 */
export function parseRunArgs(args) {
  const sub = args.shift();
  const allowed = new Set(["status", "pause", "attention", "resume"]);
  if (!sub || !allowed.has(sub)) {
    return { cmd: "run", error: "用法：acg run <status|pause|resume|attention>" };
  }
  return { cmd: "run", sub };
}

/** 从环境变量读取身份（讨论组成员 / 流程运行角色执行会话；由 server 启动 PTY 时注入）。 */
export function readIdentityFromEnv(env = {}) {
  return {
    sessionId: env.AGENT_CONSOLE_SESSION_ID || "",
    groupId: env.AGENT_CONSOLE_GROUP_ID || "",
    memberId: env.AGENT_CONSOLE_MEMBER_ID || "",
    api: env.AGENT_CONSOLE_API || "http://127.0.0.1:5173",
    // 流程运行身份（PRD §5.7）。
    runId: env.AGENT_CONSOLE_RUN_ID || "",
    taskId: env.AGENT_CONSOLE_TASK_ID || "",
    stageId: env.AGENT_CONSOLE_STAGE_ID || "",
    roleId: env.AGENT_CONSOLE_ROLE_ID || "",
    execSessionId: env.AGENT_CONSOLE_EXEC_SESSION_ID || "",
  };
}
