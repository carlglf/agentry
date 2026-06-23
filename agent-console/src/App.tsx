import {
  Activity,
  Archive,
  BarChart3,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Code2,
  Copy,
  Crown,
  Edit3,
  Eraser,
  ExternalLink,
  Image as ImageIcon,
  Maximize2,
  Menu,
  MessageSquare,
  Minimize2,
  MoreVertical,
  Paperclip,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  Send,
  Settings,
  Shield,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  Users,
  X,
  Play,
  Pause,
  GitBranch,
  CheckCircle2,
  AlertTriangle,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { FormEvent, KeyboardEvent, ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type AgentStatus = "online" | "offline" | "running" | "error" | "paused";
type AgentRuntime = "codex" | "claude";
type CommandScope = "global" | "project" | "agent";
type CommandAction = "insert" | "send";
type MessageRole = "user" | "agent" | "system";
type MessageType = "text" | "command" | "file" | "code";
type MessageStatus = "sending" | "success" | "failed";
type LogLevel = "info" | "warn" | "error";

type Project = {
  id: string;
  name: string;
  key: string;
  description: string;
  rootPath: string;
  icon: string;
  sort: number;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type Agent = {
  id: string;
  projectId: string;
  name: string;
  key: string;
  runtime: AgentRuntime;
  model: string;
  description: string;
  status: AgentStatus;
  workdir: string;
  startCommand: string;
  env: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

type Command = {
  id: string;
  name: string;
  content: string;
  description: string;
  scope: CommandScope;
  projectId?: string;
  agentId?: string;
  actionType: CommandAction;
  sort: number;
  createdAt: string;
  updatedAt: string;
};

type Message = {
  id: string;
  projectId: string;
  agentId: string;
  role: MessageRole;
  content: string;
  messageType: MessageType;
  status: MessageStatus;
  createdAt: string;
};

type TerminalLog = {
  id: string;
  projectId: string;
  agentId: string;
  content: string;
  level: LogLevel;
  createdAt: string;
};

type TtyBridge = {
  send: (content: string) => Promise<boolean>;
};

type TtyResponse = {
  projectId: string;
  agentId: string;
  content: string;
};

// ---- 讨论组（Discussion Group）类型 ----
// 注意：讨论数据由 server 端 JSON 持久化，前端经 REST API 读取，不进 zustand persist。
type DiscussionStatus = "idle" | "running" | "ended";

type DiscussionMember = {
  id: string;
  groupId: string;
  name: string;
  runtime: AgentRuntime;
  model: string;
  persona: string;
  duty: string;
  isHost: boolean;
};

type DiscussionGroup = {
  id: string;
  projectId: string;
  name: string;
  rule: string;
  createdAt: string;
  updatedAt: string;
  members: DiscussionMember[];
};

type DiscussionRevisionMode = "revise" | "restart";

type DiscussionSession = {
  id: string;
  groupId: string;
  topic: string;
  status: DiscussionStatus;
  maxRounds: number;
  currentMemberId: string;
  round: number;
  createdAt: string;
  updatedAt: string;
  parentSessionId?: string;
  revisionNo?: number;
  reopenMode?: DiscussionRevisionMode;
  userFeedbackMessageId?: string;
  previousConclusionSnapshot?: string;
};

type DiscussionMessageType = "member_message" | "user_feedback";

type DiscussionMessage = {
  id: string;
  sessionId: string;
  memberId: string | null;
  type?: DiscussionMessageType;
  seq: number;
  content: string;
  createdAt: string;
};

type DiscussionDetail = {
  session: DiscussionSession;
  members: DiscussionMember[];
  messages: DiscussionMessage[];
};

type DiscussionMemberForm = {
  id?: string;
  name: string;
  runtime: AgentRuntime;
  model: string;
  persona: string;
  duty: string;
  isHost: boolean;
};

type DiscussionGroupForm = {
  name: string;
  rule: string;
  members: DiscussionMemberForm[];
};

const CAPTURE_READY_FLUSH_MS = 0;
const CAPTURE_IDLE_FLUSH_MS = 900;
const CAPTURE_EMPTY_RETRY_MS = 1200;
const CAPTURE_EMPTY_MAX_MS = 12000;
const NO_OUTPUT_COMMANDS = new Set(["/clear"]);

type ProjectForm = {
  name: string;
  key: string;
  description: string;
  rootPath: string;
  icon: string;
  defaultAgent: boolean;
};

type AgentForm = {
  name: string;
  key: string;
  runtime: AgentRuntime;
  model: string;
  description: string;
  workdir: string;
  startCommand: string;
  status: AgentStatus;
};

type CommandForm = {
  name: string;
  content: string;
  description: string;
  scope: CommandScope;
  actionType: CommandAction;
};

type ConsoleStore = {
  projects: Project[];
  agents: Agent[];
  commands: Command[];
  messages: Message[];
  terminalLogs: TerminalLog[];
  expandedProjectIds: string[];
  selectedProjectId: string;
  selectedAgentId: string;
  selectProject: (projectId: string) => void;
  selectAgent: (agentId: string) => void;
  toggleProject: (projectId: string) => void;
  addProject: (form: ProjectForm) => void;
  updateProject: (projectId: string, form: ProjectForm) => void;
  deleteProject: (projectId: string) => void;
  addAgent: (projectId: string, form: AgentForm) => void;
  updateAgent: (agentId: string, form: AgentForm) => void;
  deleteAgent: (agentId: string) => void;
  addCommand: (form: CommandForm) => void;
  deleteCommand: (commandId: string) => void;
  addMessage: (message: Omit<Message, "id" | "createdAt">) => void;
  clearMessages: (agentId: string) => void;
  addTerminalLog: (log: Omit<TerminalLog, "id" | "createdAt">) => void;
  clearTerminal: (agentId: string) => void;
};

const now = () => new Date().toISOString();
const id = (prefix: string) =>
  `${prefix}_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
const defaultRootPath = "/mnt/h/ai/orchestration";

const agentRuntimeOptions: Record<AgentRuntime, { label: string; defaultModel: string; models: Array<{ value: string; label: string }> }> = {
  codex: {
    label: "Codex",
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
    defaultModel: "sonnet",
    models: [
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
      { value: "fable", label: "Fable" },
      { value: "claude-fable-5", label: "Claude Fable 5" },
    ],
  },
};

// 运行时模型列表实时从后端 /api/runtime-meta 拉取（codex app-server / claude SDK 探测），
// 拉取失败则保留上面写死的 agentRuntimeOptions 作为回退。
type RuntimeOptionsMap = Record<AgentRuntime, { label: string; defaultModel: string; models: Array<{ value: string; label: string }> }>;

function mergeRuntimeOptions(base: RuntimeOptionsMap, data: unknown): RuntimeOptionsMap {
  if (!data || typeof data !== "object") return base;
  const incoming = data as Record<string, { models?: Array<{ value?: unknown; label?: unknown }>; defaultModel?: unknown }>;
  const out = {} as RuntimeOptionsMap;
  (Object.keys(base) as AgentRuntime[]).forEach((rt) => {
    const entry = incoming[rt];
    const models = Array.isArray(entry?.models) && entry.models.length
      ? entry.models
          .filter((m) => m && m.value != null)
          .map((m) => ({ value: String(m.value), label: String(m.label ?? m.value) }))
      : base[rt].models;
    const defaultModel = typeof entry?.defaultModel === "string" && entry.defaultModel
      ? entry.defaultModel
      : base[rt].defaultModel;
    out[rt] = { label: base[rt].label, defaultModel, models };
  });
  return out;
}

interface RuntimeMetaStore {
  options: RuntimeOptionsMap;
  loaded: boolean;
  load: () => Promise<void>;
}

const useRuntimeMetaStore = create<RuntimeMetaStore>((set) => ({
  options: agentRuntimeOptions,
  loaded: false,
  load: async () => {
    try {
      const res = await fetch("/api/runtime-meta");
      if (!res.ok) return;
      const data = await res.json();
      set({ options: mergeRuntimeOptions(agentRuntimeOptions, data), loaded: true });
    } catch {
      // 保留写死回退
    }
  },
}));

const getRuntimeOptions = (): RuntimeOptionsMap => useRuntimeMetaStore.getState().options;

function defaultStartCommand(runtime: AgentRuntime, model: string) {
  if (runtime === "claude") {
    return `claude --dangerously-skip-permissions --model ${model}`;
  }
  return `codex --yolo --model ${model}`;
}

function normalizeStartCommand(command: string, runtime: AgentRuntime, model: string) {
  const trimmed = command.trim();
  const oldCodexDefault = trimmed.startsWith("codex --dangerously-bypass-approvals-and-sandbox");
  const oldClaudeDefault =
    trimmed.startsWith("claude --dangerously-skip-permissions") && trimmed.includes("--permission-mode bypassPermissions");

  if (oldCodexDefault || oldClaudeDefault || !trimmed) {
    return defaultStartCommand(runtime, model);
  }

  return trimmed;
}

function nextStartCommand(current: AgentForm, runtime: AgentRuntime, model: string) {
  const normalizedCurrent = normalizeStartCommand(current.startCommand, current.runtime, current.model);
  const currentIsDefault = normalizedCurrent === defaultStartCommand(current.runtime, current.model);
  return currentIsDefault ? defaultStartCommand(runtime, model) : current.startCommand;
}

const projectsSeed: Project[] = [
  {
    id: "project_ecommerce",
    name: "E-Commerce",
    key: "ecommerce",
    description: "订单、库存和支付 Agent 协作项目",
    rootPath: defaultRootPath,
    icon: "store",
    sort: 1,
    status: "active",
    createdAt: "2026-06-19T02:00:00.000Z",
    updatedAt: "2026-06-19T02:00:00.000Z",
  },
  {
    id: "project_analytics",
    name: "Data Analytics",
    key: "analytics",
    description: "查询、图表和指标诊断 Agent",
    rootPath: defaultRootPath,
    icon: "chart",
    sort: 2,
    status: "active",
    createdAt: "2026-06-19T02:00:00.000Z",
    updatedAt: "2026-06-19T02:00:00.000Z",
  },
  {
    id: "project_devops",
    name: "DevOps",
    key: "devops",
    description: "部署、监控和故障处理 Agent",
    rootPath: defaultRootPath,
    icon: "infinity",
    sort: 3,
    status: "active",
    createdAt: "2026-06-19T02:00:00.000Z",
    updatedAt: "2026-06-19T02:00:00.000Z",
  },
  {
    id: "project_support",
    name: "Customer Support",
    key: "support",
    description: "工单、知识库和客服辅助 Agent",
    rootPath: defaultRootPath,
    icon: "support",
    sort: 4,
    status: "active",
    createdAt: "2026-06-19T02:00:00.000Z",
    updatedAt: "2026-06-19T02:00:00.000Z",
  },
];

const agentsSeed: Agent[] = [
  {
    id: "agent_order",
    projectId: "project_ecommerce",
    name: "OrderAgent",
    key: "order-agent",
    runtime: "codex",
    model: "gpt-5-codex",
    description: "处理订单查询、物流追踪和售后状态",
    status: "online",
    workdir: defaultRootPath,
    startCommand: defaultStartCommand("codex", "gpt-5-codex"),
    env: { NODE_ENV: "production" },
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "agent_inventory",
    projectId: "project_ecommerce",
    name: "InventoryAgent",
    key: "inventory-agent",
    runtime: "claude",
    model: "sonnet",
    description: "库存同步和仓储分析",
    status: "online",
    workdir: defaultRootPath,
    startCommand: defaultStartCommand("claude", "sonnet"),
    env: { NODE_ENV: "production" },
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "agent_payment",
    projectId: "project_ecommerce",
    name: "PaymentAgent",
    key: "payment-agent",
    runtime: "codex",
    model: "gpt-5",
    description: "支付链路和退款处理",
    status: "online",
    workdir: defaultRootPath,
    startCommand: defaultStartCommand("codex", "gpt-5"),
    env: { NODE_ENV: "production" },
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "agent_query",
    projectId: "project_analytics",
    name: "QueryAgent",
    key: "query-agent",
    runtime: "claude",
    model: "opus",
    description: "自然语言转 SQL 和查询分析",
    status: "online",
    workdir: defaultRootPath,
    startCommand: defaultStartCommand("claude", "opus"),
    env: { NODE_ENV: "production" },
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "agent_chart",
    projectId: "project_analytics",
    name: "ChartAgent",
    key: "chart-agent",
    runtime: "codex",
    model: "o3",
    description: "图表生成和报表解释",
    status: "running",
    workdir: defaultRootPath,
    startCommand: defaultStartCommand("codex", "o3"),
    env: { NODE_ENV: "production" },
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "agent_deploy",
    projectId: "project_devops",
    name: "DeployAgent",
    key: "deploy-agent",
    runtime: "codex",
    model: "gpt-5-codex",
    description: "发布校验、部署执行和回滚建议",
    status: "online",
    workdir: defaultRootPath,
    startCommand: defaultStartCommand("codex", "gpt-5-codex"),
    env: { NODE_ENV: "production" },
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "agent_monitor",
    projectId: "project_devops",
    name: "MonitorAgent",
    key: "monitor-agent",
    runtime: "claude",
    model: "sonnet",
    description: "监控、告警和日志摘要",
    status: "error",
    workdir: defaultRootPath,
    startCommand: defaultStartCommand("claude", "sonnet"),
    env: { NODE_ENV: "production" },
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "agent_ticket",
    projectId: "project_support",
    name: "TicketAgent",
    key: "ticket-agent",
    runtime: "claude",
    model: "fable",
    description: "工单归因和优先级判断",
    status: "online",
    workdir: defaultRootPath,
    startCommand: defaultStartCommand("claude", "fable"),
    env: { NODE_ENV: "production" },
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "agent_knowledge",
    projectId: "project_support",
    name: "KnowledgeAgent",
    key: "knowledge-agent",
    runtime: "codex",
    model: "gpt-5-mini",
    description: "知识库检索和回答生成",
    status: "online",
    workdir: defaultRootPath,
    startCommand: defaultStartCommand("codex", "gpt-5-mini"),
    env: { NODE_ENV: "production" },
    createdAt: now(),
    updatedAt: now(),
  },
];

const commandsSeed: Command[] = [
  {
    id: "cmd_clear",
    name: "/clear",
    content: "/clear",
    description: "清空当前 Agent 会话",
    scope: "global",
    actionType: "insert",
    sort: 1,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "cmd_compact",
    name: "/compact",
    content: "/compact",
    description: "压缩当前上下文",
    scope: "global",
    actionType: "insert",
    sort: 2,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "cmd_help",
    name: "/help",
    content: "/help",
    description: "查看 Agent 支持的命令",
    scope: "global",
    actionType: "insert",
    sort: 3,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "cmd_retry",
    name: "/retry",
    content: "/retry",
    description: "重试上一次任务",
    scope: "global",
    actionType: "insert",
    sort: 4,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "cmd_summarize",
    name: "/summarize",
    content: "/summarize",
    description: "总结当前会话",
    scope: "global",
    actionType: "insert",
    sort: 5,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: "cmd_status",
    name: "/status",
    content: "/status",
    description: "查看当前 Agent 状态",
    scope: "agent",
    agentId: "agent_order",
    actionType: "send",
    sort: 6,
    createdAt: now(),
    updatedAt: now(),
  },
];

const messagesSeed: Message[] = [
  {
    id: "msg_1",
    projectId: "project_ecommerce",
    agentId: "agent_order",
    role: "user",
    content: "帮我查询一下订单 ID 为 12345 的订单详情",
    messageType: "text",
    status: "success",
    createdAt: "2026-06-19T02:30:21.000Z",
  },
  {
    id: "msg_2",
    projectId: "project_ecommerce",
    agentId: "agent_order",
    role: "agent",
    content: "好的，我正在查询订单 ID 为 12345 的详情，请稍候...",
    messageType: "text",
    status: "success",
    createdAt: "2026-06-19T02:30:22.000Z",
  },
  {
    id: "msg_3",
    projectId: "project_ecommerce",
    agentId: "agent_order",
    role: "agent",
    content:
      "订单详情如下：\n- 订单 ID：12345\n- 状态：已发货\n- 创建时间：2026-06-18 14:32:10\n- 客户：张三\n- 金额：¥1,299.00\n- 商品：无线耳机 x1、机械键盘 x1\n- 物流单号：SF1234567890123\n- 预计送达：2026-06-21",
    messageType: "text",
    status: "success",
    createdAt: "2026-06-19T02:30:24.000Z",
  },
  {
    id: "msg_4",
    projectId: "project_ecommerce",
    agentId: "agent_order",
    role: "user",
    content: "这个订单的物流轨迹呢？",
    messageType: "text",
    status: "success",
    createdAt: "2026-06-19T02:31:02.000Z",
  },
  {
    id: "msg_5",
    projectId: "project_ecommerce",
    agentId: "agent_order",
    role: "agent",
    content:
      "物流轨迹：\n\n| 时间 | 地点 | 状态 |\n| --- | --- | --- |\n| 2026-06-18 16:45 | 深圳市南山区 | 已揽件 |\n| 2026-06-18 20:18 | 深圳转运中心 | 已发出 |\n| 2026-06-19 08:30 | 广州市转运中心 | 已到达 |\n| 2026-06-19 14:22 | 广州市番禺区 | 派送中 |",
    messageType: "text",
    status: "success",
    createdAt: "2026-06-19T02:31:06.000Z",
  },
];

const logsSeed: TerminalLog[] = [
  {
    id: "log_1",
    projectId: "project_ecommerce",
    agentId: "agent_order",
    level: "info",
    content:
      "Welcome to Node TTY. Type 'help' for available commands.\n\nnode@order-agent:~$ npm start\n\n> order-agent@1.0.0 start\n> node server.js\n\n[INFO] 2026-06-19 10:29:58 Server starting on port 3000\n[INFO] 2026-06-19 10:29:58 Connecting to database...\n[INFO] 2026-06-19 10:29:58 Database connected\n[INFO] 2026-06-19 10:29:58 OrderAgent is ready.",
    createdAt: "2026-06-19T02:29:58.000Z",
  },
  {
    id: "log_2",
    projectId: "project_ecommerce",
    agentId: "agent_order",
    level: "info",
    content:
      "node@order-agent:~$ tail -f logs/app.log\n\n2026-06-19 10:30:22 [INFO] Received message from user\n2026-06-19 10:30:22 [INFO] Querying order by ID: 12345\n2026-06-19 10:30:22 [INFO] Order found: 12345\n2026-06-19 10:30:24 [INFO] Response sent to user\n2026-06-19 10:31:03 [INFO] Querying logistics for order: 12345\n2026-06-19 10:31:04 [INFO] Logistics data retrieved",
    createdAt: "2026-06-19T02:31:05.000Z",
  },
  {
    id: "log_3",
    projectId: "project_ecommerce",
    agentId: "agent_order",
    level: "info",
    content:
      "node@order-agent:~$ pm2 status\n\n┌────┬──────────────┬────────┬────────┬─────┬────────┬────────┐\n│ id │ name         │ mode   │ status │ cpu │ memory │ uptime │\n├────┼──────────────┼────────┼────────┼─────┼────────┼────────┤\n│ 0  │ order-agent  │ fork   │ online │ 1%  │ 48.3mb │ 2m     │\n└────┴──────────────┴────────┴────────┴─────┴────────┴────────┘",
    createdAt: "2026-06-19T02:31:20.000Z",
  },
];

const useConsoleStore = create<ConsoleStore>()(
  persist(
    (set, get) => ({
      projects: projectsSeed,
      agents: agentsSeed,
      commands: commandsSeed,
      messages: messagesSeed,
      terminalLogs: logsSeed,
      expandedProjectIds: ["project_ecommerce", "project_analytics", "project_devops", "project_support"],
      selectedProjectId: "project_ecommerce",
      selectedAgentId: "agent_order",
      selectProject: (projectId) => {
        const agent = get().agents.find((item) => item.projectId === projectId);
        set((state) => ({
          selectedProjectId: projectId,
          selectedAgentId: agent?.id ?? state.selectedAgentId,
          expandedProjectIds: state.expandedProjectIds.includes(projectId)
            ? state.expandedProjectIds
            : [...state.expandedProjectIds, projectId],
        }));
      },
      selectAgent: (agentId) => {
        const agent = get().agents.find((item) => item.id === agentId);
        if (!agent) return;
        set({
          selectedAgentId: agentId,
          selectedProjectId: agent.projectId,
        });
      },
      toggleProject: (projectId) =>
        set((state) => ({
          expandedProjectIds: state.expandedProjectIds.includes(projectId)
            ? state.expandedProjectIds.filter((idValue) => idValue !== projectId)
            : [...state.expandedProjectIds, projectId],
        })),
      addProject: (form) =>
        set((state) => {
          const projectId = id("project");
          const createdProject: Project = {
            id: projectId,
            name: form.name.trim(),
            key: form.key.trim(),
            description: form.description.trim(),
            rootPath: form.rootPath.trim() || defaultRootPath,
            icon: form.icon,
            sort: state.projects.length + 1,
            status: "active",
            createdAt: now(),
            updatedAt: now(),
          };
          const defaultAgent: Agent | null = form.defaultAgent
            ? {
                id: id("agent"),
                projectId,
                name: "DefaultAgent",
                key: `${form.key.trim()}-default-agent`,
                runtime: "codex",
                model: getRuntimeOptions().codex.defaultModel,
                description: "默认 Agent",
                status: "offline",
                workdir: form.rootPath.trim() || defaultRootPath,
                startCommand: defaultStartCommand("codex", getRuntimeOptions().codex.defaultModel),
                env: {},
                createdAt: now(),
                updatedAt: now(),
              }
            : null;
          return {
            projects: [...state.projects, createdProject],
            agents: defaultAgent ? [...state.agents, defaultAgent] : state.agents,
            selectedProjectId: projectId,
            selectedAgentId: defaultAgent?.id ?? state.selectedAgentId,
            expandedProjectIds: [...state.expandedProjectIds, projectId],
          };
        }),
      updateProject: (projectId, form) =>
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  name: form.name.trim(),
                  key: form.key.trim(),
                  description: form.description.trim(),
                  rootPath: form.rootPath.trim() || defaultRootPath,
                  icon: form.icon,
                  updatedAt: now(),
                }
              : project,
          ),
        })),
      deleteProject: (projectId) =>
        set((state) => {
          const removedAgentIds = state.agents
            .filter((agent) => agent.projectId === projectId)
            .map((agent) => agent.id);
          const projects = state.projects.filter((project) => project.id !== projectId);
          const agents = state.agents.filter((agent) => agent.projectId !== projectId);
          const nextProject = projects[0];
          const nextAgent = agents.find((agent) => agent.projectId === nextProject?.id) ?? agents[0];
          return {
            projects,
            agents,
            commands: state.commands.filter(
              (command) =>
                command.projectId !== projectId &&
                (!command.agentId || !removedAgentIds.includes(command.agentId)),
            ),
            messages: state.messages.filter((message) => message.projectId !== projectId),
            terminalLogs: state.terminalLogs.filter((log) => log.projectId !== projectId),
            expandedProjectIds: state.expandedProjectIds.filter((idValue) => idValue !== projectId),
            selectedProjectId: nextAgent?.projectId ?? nextProject?.id ?? "",
            selectedAgentId: nextAgent?.id ?? "",
          };
        }),
      addAgent: (projectId, form) =>
        set((state) => {
          const agentId = id("agent");
          const project = state.projects.find((item) => item.id === projectId);
          return {
            agents: [
              ...state.agents,
              {
                id: agentId,
                projectId,
                name: form.name.trim(),
                key: form.key.trim(),
                runtime: form.runtime,
                model: form.model,
                description: form.description.trim(),
                status: form.status,
                workdir: form.workdir.trim() || project?.rootPath || defaultRootPath,
                startCommand: form.startCommand.trim(),
                env: {},
                createdAt: now(),
                updatedAt: now(),
              },
            ],
            selectedProjectId: projectId,
            selectedAgentId: agentId,
            expandedProjectIds: state.expandedProjectIds.includes(projectId)
              ? state.expandedProjectIds
              : [...state.expandedProjectIds, projectId],
          };
        }),
      updateAgent: (agentId, form) =>
        set((state) => ({
          agents: state.agents.map((agent) =>
            agent.id === agentId
              ? {
                  ...agent,
                  name: form.name.trim(),
                  key: form.key.trim(),
                  runtime: form.runtime,
                  model: form.model,
                  description: form.description.trim(),
                  status: form.status,
                  workdir: form.workdir.trim() || defaultRootPath,
                  startCommand: form.startCommand.trim(),
                  updatedAt: now(),
                }
              : agent,
          ),
        })),
      deleteAgent: (agentId) =>
        set((state) => {
          const removed = state.agents.find((agent) => agent.id === agentId);
          const agents = state.agents.filter((agent) => agent.id !== agentId);
          const projectAgent = agents.find((agent) => agent.projectId === removed?.projectId);
          const nextAgent = projectAgent ?? agents[0];
          return {
            agents,
            commands: state.commands.filter((command) => command.agentId !== agentId),
            messages: state.messages.filter((message) => message.agentId !== agentId),
            terminalLogs: state.terminalLogs.filter((log) => log.agentId !== agentId),
            selectedProjectId: nextAgent?.projectId ?? state.selectedProjectId,
            selectedAgentId: nextAgent?.id ?? "",
          };
        }),
      addCommand: (form) =>
        set((state) => ({
          commands: [
            ...state.commands,
            {
              id: id("cmd"),
              name: form.name.trim(),
              content: form.content.trim(),
              description: form.description.trim(),
              scope: form.scope,
              projectId: form.scope === "project" ? state.selectedProjectId : undefined,
              agentId: form.scope === "agent" ? state.selectedAgentId : undefined,
              actionType: form.actionType,
              sort: state.commands.length + 1,
              createdAt: now(),
              updatedAt: now(),
            },
          ],
        })),
      deleteCommand: (commandId) =>
        set((state) => ({
          commands: state.commands.filter((command) => command.id !== commandId),
        })),
      addMessage: (message) =>
        set((state) => ({
          messages: [...state.messages, { ...message, id: id("msg"), createdAt: now() }],
        })),
      clearMessages: (agentId) =>
        set((state) => ({
          messages: state.messages.filter((message) => message.agentId !== agentId),
        })),
      addTerminalLog: (log) =>
        set((state) => ({
          terminalLogs: [...state.terminalLogs, { ...log, id: id("log"), createdAt: now() }],
        })),
      clearTerminal: (agentId) =>
        set((state) => ({
          terminalLogs: state.terminalLogs.filter((log) => log.agentId !== agentId),
        })),
    }),
    {
      name: "agent-console-mvp",
      version: 5,
      migrate: (persisted) => {
        const state = persisted as Partial<ConsoleStore> | undefined;
        if (!state?.agents) return persisted;
        const projectRootById = new Map((state.projects || []).map((project) => [project.id, project.rootPath || defaultRootPath]));
        return {
          ...state,
          agents: state.agents.map((agent) => {
            const runtime = agent.runtime && agentRuntimeOptions[agent.runtime] ? agent.runtime : "codex";
            const model = agent.model || agentRuntimeOptions[runtime].defaultModel;
            const projectRoot = projectRootById.get(agent.projectId) || defaultRootPath;
            const workdir = !agent.workdir?.trim() || agent.workdir.startsWith("/apps/") ? projectRoot : agent.workdir;
            return {
              ...agent,
              runtime,
              model,
              workdir,
              startCommand: normalizeStartCommand(agent.startCommand, runtime, model),
            };
          }),
        };
      },
    },
  ),
);

const emptyProjectForm: ProjectForm = {
  name: "",
  key: "",
  description: "",
  rootPath: defaultRootPath,
  icon: "store",
  defaultAgent: false,
};

const emptyAgentForm: AgentForm = {
  name: "",
  key: "",
  runtime: "codex",
  model: agentRuntimeOptions.codex.defaultModel,
  description: "",
  workdir: defaultRootPath,
  startCommand: defaultStartCommand("codex", agentRuntimeOptions.codex.defaultModel),
  status: "offline",
};

const emptyCommandForm: CommandForm = {
  name: "",
  content: "",
  description: "",
  scope: "agent",
  actionType: "send",
};

function emptyDiscussionMemberForm(isHost = false): DiscussionMemberForm {
  return {
    name: "",
    runtime: "codex",
    model: getRuntimeOptions().codex.defaultModel,
    persona: "",
    duty: "",
    isHost,
  };
}

const emptyDiscussionGroupForm: DiscussionGroupForm = {
  name: "",
  rule: "",
  members: [emptyDiscussionMemberForm(true), emptyDiscussionMemberForm(false)],
};

// 讨论组配色：按成员序号循环，用于会话流着色与终端标签。
const memberPalette = ["#2b85ff", "#55d76c", "#f2bf42", "#ff7ad9", "#35c5ff", "#ff8f5c", "#b388ff", "#46d6c0"];
function memberColor(members: DiscussionMember[], memberId: string) {
  const index = members.findIndex((m) => m.id === memberId);
  return memberPalette[(index < 0 ? 0 : index) % memberPalette.length];
}

async function discussionApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  const text = await response.text();
  let payload: unknown = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }
  if (!response.ok) {
    const data = payload as { error?: string; errors?: string[] };
    throw new Error(data.errors?.join("；") || data.error || `请求失败（${response.status}）`);
  }
  return payload as T;
}

type DiscussionStore = {
  groups: DiscussionGroup[];
  sessionsByGroup: Record<string, DiscussionSession[]>;
  selectedSessionId: string;
  detail: DiscussionDetail | null;
  loadGroups: () => Promise<void>;
  loadSessions: (groupId: string) => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  refreshDetail: () => Promise<void>;
  createGroup: (projectId: string, form: DiscussionGroupForm) => Promise<void>;
  updateGroup: (groupId: string, form: DiscussionGroupForm) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  createSession: (groupId: string, topic: string, maxRounds: number) => Promise<DiscussionSession>;
  startSession: (sessionId: string, cwd: string) => Promise<void>;
  stopSession: (sessionId: string) => Promise<void>;
  reopenSession: (sessionId: string, cwd: string) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  createRevision: (
    sessionId: string,
    feedback: string,
    mode: DiscussionRevisionMode,
    cwd: string,
  ) => Promise<DiscussionSession>;
};

const useDiscussionStore = create<DiscussionStore>((set, get) => ({
  groups: [],
  sessionsByGroup: {},
  selectedSessionId: "",
  detail: null,
  loadGroups: async () => {
    const data = await discussionApi<{ groups: DiscussionGroup[] }>("/groups");
    set({ groups: data.groups });
  },
  loadSessions: async (groupId) => {
    const data = await discussionApi<{ sessions: DiscussionSession[] }>(`/groups/${groupId}/sessions`);
    set((state) => ({ sessionsByGroup: { ...state.sessionsByGroup, [groupId]: data.sessions } }));
  },
  selectSession: async (sessionId) => {
    set({ selectedSessionId: sessionId });
    if (!sessionId) {
      set({ detail: null });
      return;
    }
    await get().refreshDetail();
  },
  refreshDetail: async () => {
    const sessionId = get().selectedSessionId;
    if (!sessionId) return;
    const detail = await discussionApi<DiscussionDetail>(`/sessions/${sessionId}`);
    if (get().selectedSessionId !== sessionId) return;
    set({ detail });
    set((state) => ({
      sessionsByGroup: {
        ...state.sessionsByGroup,
        [detail.session.groupId]: (state.sessionsByGroup[detail.session.groupId] || []).map((s) =>
          s.id === detail.session.id ? detail.session : s,
        ),
      },
    }));
  },
  createGroup: async (projectId, form) => {
    await discussionApi("/groups", {
      method: "POST",
      body: JSON.stringify({ projectId, name: form.name, rule: form.rule, members: form.members }),
    });
    await get().loadGroups();
  },
  updateGroup: async (groupId, form) => {
    await discussionApi(`/groups/${groupId}`, {
      method: "PUT",
      body: JSON.stringify({ name: form.name, rule: form.rule, members: form.members }),
    });
    await get().loadGroups();
  },
  deleteGroup: async (groupId) => {
    await discussionApi(`/groups/${groupId}`, { method: "DELETE" });
    await get().loadGroups();
    set((state) => {
      const next = { ...state.sessionsByGroup };
      delete next[groupId];
      return { sessionsByGroup: next };
    });
  },
  createSession: async (groupId, topic, maxRounds) => {
    const data = await discussionApi<{ session: DiscussionSession }>(`/groups/${groupId}/sessions`, {
      method: "POST",
      body: JSON.stringify({ topic, maxRounds }),
    });
    await get().loadSessions(groupId);
    return data.session;
  },
  startSession: async (sessionId, cwd) => {
    await discussionApi(`/sessions/${sessionId}/start`, { method: "POST", body: JSON.stringify({ cwd }) });
    await get().refreshDetail();
  },
  stopSession: async (sessionId) => {
    await discussionApi(`/sessions/${sessionId}/stop`, { method: "POST" });
    await get().refreshDetail();
  },
  reopenSession: async (sessionId, cwd) => {
    await discussionApi(`/sessions/${sessionId}/reopen`, { method: "POST", body: JSON.stringify({ cwd }) });
    await get().refreshDetail();
  },
  closeSession: async (sessionId) => {
    await discussionApi(`/sessions/${sessionId}/close`, { method: "POST" });
    await get().refreshDetail();
  },
  createRevision: async (sessionId, feedback, mode, cwd) => {
    const data = await discussionApi<{ session: DiscussionSession }>(`/sessions/${sessionId}/revisions`, {
      method: "POST",
      body: JSON.stringify({ feedback, mode, cwd }),
    });
    await get().loadSessions(data.session.groupId);
    await get().selectSession(data.session.id);
    return data.session;
  },
}));

// ====== 自动开发编排（流程运行）======

type WorkflowRunStatus =
  | "draft"
  | "planning"
  | "awaiting_plan_approval"
  | "running"
  | "paused"
  | "needs_attention"
  | "integrating"
  | "completed"
  | "failed"
  | "terminated";

type WorkflowTaskStatus =
  | "pending"
  | "developing"
  | "reviewing"
  | "testing"
  | "documenting"
  | "approved"
  | "committed"
  | "blocked"
  | "skipped"
  | "failed";

type WorkflowRun = {
  id: string;
  projectId: string;
  goal: string;
  repositoryPath: string;
  baseBranch: string;
  integrationMode: "pull_request" | "direct_merge";
  status: WorkflowRunStatus;
  currentStageId: string;
  currentTaskId: string | null;
  workflowTemplateId: string;
  integrationBaseline: string;
  createdAt: string;
  updatedAt: string;
  workflowSnapshot?: {
    workflow: { id: string; name: string; taskStages: Array<{ id: string; kind: string; roleId: string }>; settings: { maxReviewRounds: number; integrationMode: string } };
    sources: Array<{ kind: string; id: string; source: string; relativePath: string | null; version: number; contentHash: string }>;
  };
};

type WorkflowTaskItem = {
  id: string;
  runId: string;
  order: number;
  title: string;
  objective: string;
  status: WorkflowTaskStatus;
  stage: string | null;
  dependencies: string[];
  acceptanceCriteria: string[];
  scope: string[];
  forbiddenChanges: string[];
  suggestedTests: string[];
  expectedFiles: string[];
  reviewRounds: number;
  branch: string;
  worktreePath: string;
  commitSha: string;
};

type WorkflowRoleSession = {
  id: string;
  runId: string;
  roleId: string;
  taskId: string | null;
  stageId: string;
  status: string;
};

type WorkflowHandoff = {
  id: string;
  taskId: string;
  commitSha: string;
  changeSummary: string;
  changedInterfaces: string[];
  decisions: string[];
};

type WorkflowAudit = { id: string; kind: string; detail: Record<string, unknown>; createdAt: string };

type WorkflowDetail = {
  run: WorkflowRun;
  tasks: WorkflowTaskItem[];
  roleSessions: WorkflowRoleSession[];
  handoffs: WorkflowHandoff[];
  stageResults: Array<{ id: string; type: string; taskId: string | null; payload: Record<string, unknown> }>;
  audit: WorkflowAudit[];
};

type WorkflowTemplateSummary = {
  id: string;
  name: string;
  description: string;
  version: number;
  settings: { maxReviewRounds: number; integrationMode: "pull_request" | "direct_merge" };
  taskStages: Array<{ id: string; kind: string; roleId: string }>;
  planningRoleId?: string;
  integrationRoleId?: string;
  source: string;
  relativePath: string | null;
};

const WORKFLOW_ROLE_LABEL: Record<string, string> = {
  planner: "规划",
  developer: "开发",
  reviewer: "Review",
  tester: "测试",
  integrator: "集成",
  doc: "文档",
};

type RoleBinding = { memberId: string; runtime?: string; model?: string; persona?: string; duty?: string };

type CreateRunPayload = {
  projectId: string;
  goal: string;
  repositoryPath: string;
  baseBranch: string;
  integrationMode: "pull_request" | "direct_merge";
  workflowTemplateId: string;
  groupId?: string;
  settings?: { roleBindings?: Record<string, RoleBinding> };
  overrides: { maxReviewRounds?: number; enableTesting?: boolean; enableDoc?: boolean; integrationMode?: "pull_request" | "direct_merge" };
};

const WORKFLOW_RUN_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  draft: "草稿",
  planning: "规划中",
  awaiting_plan_approval: "待确认计划",
  running: "运行中",
  paused: "已暂停",
  needs_attention: "需人工处理",
  integrating: "集成中",
  completed: "已完成",
  failed: "失败",
  terminated: "已终止",
};

const WORKFLOW_TASK_STATUS_LABEL: Record<WorkflowTaskStatus, string> = {
  pending: "待开始",
  developing: "开发中",
  reviewing: "Review 中",
  testing: "测试中",
  documenting: "文档中",
  approved: "待提交",
  committed: "已提交",
  blocked: "需人工",
  skipped: "已跳过",
  failed: "失败",
};

const WORKFLOW_ACTIVE_STATUSES: WorkflowRunStatus[] = [
  "planning",
  "awaiting_plan_approval",
  "running",
  "integrating",
  "needs_attention",
];

type WorkflowStore = {
  runsByProject: Record<string, WorkflowRun[]>;
  selectedRunId: string;
  creatingForProjectId: string;
  detail: WorkflowDetail | null;
  templates: WorkflowTemplateSummary[];
  templateErrors: string[];
  loadRuns: (projectId: string) => Promise<void>;
  loadTemplates: (repoPath: string) => Promise<void>;
  startCreate: (projectId: string) => void;
  cancelCreate: () => void;
  createRun: (payload: CreateRunPayload) => Promise<WorkflowRun>;
  selectRun: (runId: string) => Promise<void>;
  closeWorkflow: () => void;
  refreshDetail: () => Promise<void>;
  submitPlan: (runId: string, tasks: unknown[]) => Promise<void>;
  approvePlan: (runId: string, tasks?: unknown[]) => Promise<void>;
  pauseRun: (runId: string) => Promise<void>;
  resumeRun: (runId: string) => Promise<void>;
  terminateRun: (runId: string) => Promise<void>;
  skipTask: (runId: string, taskId: string) => Promise<void>;
  retryStage: (runId: string) => Promise<void>;
  rewindDev: (runId: string, taskId: string) => Promise<void>;
  raiseRetryLimit: (runId: string) => Promise<void>;
  integrateRun: (runId: string, body: { confirm?: boolean; fullTestResult?: { passed: boolean } }) => Promise<{ blockers?: string[]; result?: { url?: string; degraded?: boolean; message?: string } }>;
};

const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  runsByProject: {},
  selectedRunId: "",
  creatingForProjectId: "",
  detail: null,
  templates: [],
  templateErrors: [],
  loadRuns: async (projectId) => {
    const data = await discussionApi<{ runs: WorkflowRun[] }>(`/workflow/runs?projectId=${encodeURIComponent(projectId)}`);
    set((state) => ({ runsByProject: { ...state.runsByProject, [projectId]: data.runs } }));
  },
  loadTemplates: async (repoPath) => {
    const data = await discussionApi<{ workflows: WorkflowTemplateSummary[]; errors: string[] }>(
      `/workflow/templates?repoPath=${encodeURIComponent(repoPath || "")}`,
    );
    set({ templates: data.workflows, templateErrors: data.errors || [] });
  },
  startCreate: (projectId) => set({ creatingForProjectId: projectId, selectedRunId: "", detail: null }),
  cancelCreate: () => set({ creatingForProjectId: "" }),
  createRun: async (payload) => {
    const data = await discussionApi<{ run: WorkflowRun }>("/workflow/runs", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    set({ creatingForProjectId: "" });
    await get().loadRuns(payload.projectId);
    await get().selectRun(data.run.id);
    return data.run;
  },
  selectRun: async (runId) => {
    set({ selectedRunId: runId, creatingForProjectId: "" });
    useDiscussionStore.getState().selectSession("");
    if (!runId) {
      set({ detail: null });
      return;
    }
    await get().refreshDetail();
  },
  closeWorkflow: () => set({ selectedRunId: "", creatingForProjectId: "", detail: null }),
  refreshDetail: async () => {
    const runId = get().selectedRunId;
    if (!runId) return;
    const detail = await discussionApi<WorkflowDetail>(`/workflow/runs/${runId}`);
    if (get().selectedRunId !== runId) return;
    set({ detail });
    set((state) => ({
      runsByProject: {
        ...state.runsByProject,
        [detail.run.projectId]: (state.runsByProject[detail.run.projectId] || []).map((r) =>
          r.id === detail.run.id ? detail.run : r,
        ),
      },
    }));
  },
  submitPlan: async (runId, tasks) => {
    await discussionApi(`/workflow/runs/${runId}/plan`, { method: "POST", body: JSON.stringify({ tasks }) });
    await get().refreshDetail();
  },
  approvePlan: async (runId, tasks) => {
    await discussionApi(`/workflow/runs/${runId}/plan/approve`, {
      method: "POST",
      body: JSON.stringify(tasks ? { tasks } : {}),
    });
    await get().refreshDetail();
  },
  pauseRun: async (runId) => {
    await discussionApi(`/workflow/runs/${runId}/pause`, { method: "POST" });
    await get().refreshDetail();
  },
  resumeRun: async (runId) => {
    await discussionApi(`/workflow/runs/${runId}/resume`, { method: "POST" });
    await get().refreshDetail();
  },
  terminateRun: async (runId) => {
    await discussionApi(`/workflow/runs/${runId}/terminate`, { method: "POST" });
    await get().refreshDetail();
  },
  skipTask: async (runId, taskId) => {
    await discussionApi(`/workflow/runs/${runId}/tasks/${taskId}/skip`, { method: "POST" });
    await get().refreshDetail();
  },
  retryStage: async (runId) => {
    await discussionApi(`/workflow/runs/${runId}/retry`, { method: "POST" });
    await get().refreshDetail();
  },
  rewindDev: async (runId, taskId) => {
    await discussionApi(`/workflow/runs/${runId}/tasks/${taskId}/rewind-dev`, { method: "POST", body: JSON.stringify({}) });
    await get().refreshDetail();
  },
  raiseRetryLimit: async (runId) => {
    await discussionApi(`/workflow/runs/${runId}/raise-retry-limit`, { method: "POST", body: JSON.stringify({}) });
    await get().refreshDetail();
  },
  integrateRun: async (runId, body) => {
    try {
      const data = await discussionApi<{ result?: { url?: string; degraded?: boolean; message?: string } }>(
        `/workflow/runs/${runId}/integrate`,
        { method: "POST", body: JSON.stringify(body) },
      );
      await get().refreshDetail();
      return data;
    } catch (err) {
      await get().refreshDetail();
      // 阻断项以 message 形式抛出（discussionApi 已拼接 error）。
      throw err;
    }
  },
}));

export function App() {
  const projects = useConsoleStore((state) => state.projects);
  const agents = useConsoleStore((state) => state.agents);
  const commands = useConsoleStore((state) => state.commands);
  const messages = useConsoleStore((state) => state.messages);
  const terminalLogs = useConsoleStore((state) => state.terminalLogs);
  const selectedProjectId = useConsoleStore((state) => state.selectedProjectId);
  const selectedAgentId = useConsoleStore((state) => state.selectedAgentId);
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const agentMessages = messages.filter((message) => message.agentId === selectedAgent?.id);
  const agentLogs = terminalLogs.filter((log) => log.agentId === selectedAgent?.id);
  const visibleCommands = useMemo(
    () =>
      commands
        .filter((command) => {
          if (command.scope === "global") return true;
          if (command.scope === "project") return command.projectId === selectedProject?.id;
          return command.agentId === selectedAgent?.id;
        })
        .sort((a, b) => {
          const priority: Record<CommandScope, number> = { agent: 0, project: 1, global: 2 };
          return priority[a.scope] - priority[b.scope] || a.sort - b.sort;
        }),
    [commands, selectedAgent?.id, selectedProject?.id],
  );

  const [input, setInput] = useState("");
  const [modal, setModal] = useState<ModalState>(null);
  const [terminalExpanded, setTerminalExpanded] = useState(false);
  const [processing, setProcessing] = useState(false);
  const processingRef = useRef(false);
  const ttyBridgeRef = useRef<TtyBridge | null>(null);

  const selectedSessionId = useDiscussionStore((state) => state.selectedSessionId);
  const selectedRunId = useWorkflowStore((state) => state.selectedRunId);
  const creatingForProjectId = useWorkflowStore((state) => state.creatingForProjectId);
  const loadGroups = useDiscussionStore((state) => state.loadGroups);
  const loadRuntimeMeta = useRuntimeMetaStore((state) => state.load);
  useEffect(() => {
    void loadGroups().catch(() => undefined);
  }, [loadGroups]);
  useEffect(() => {
    void loadRuntimeMeta().catch(() => undefined);
  }, [loadRuntimeMeta]);

  const addMessage = useConsoleStore((state) => state.addMessage);
  const addTerminalLog = useConsoleStore((state) => state.addTerminalLog);
  const clearMessages = useConsoleStore((state) => state.clearMessages);

  const registerTtyBridge = useCallback((bridge: TtyBridge | null) => {
    ttyBridgeRef.current = bridge;
  }, []);

  const handleTtyResponse = useCallback(
    (response: TtyResponse) => {
      const content = normalizeMessageContent(response.content);
      if (content) {
        addMessage({
          projectId: response.projectId,
          agentId: response.agentId,
          role: "agent",
          content,
          messageType: "text",
          status: "success",
        });
        addTerminalLog({
          projectId: response.projectId,
          agentId: response.agentId,
          level: "info",
          content,
        });
      }
      processingRef.current = false;
      setProcessing(false);
    },
    [addMessage, addTerminalLog],
  );

  async function sendMessage(raw = input) {
    const content = raw.trim();
    if (!content || !selectedProject || !selectedAgent) return;
    if (processingRef.current) return;

    const messageType: MessageType = content.startsWith("/") ? "command" : "text";
    addMessage({
      projectId: selectedProject.id,
      agentId: selectedAgent.id,
      role: "user",
      content,
      messageType,
      status: "success",
    });
    setInput("");
    processingRef.current = true;
    setProcessing(true);

    const sent = (await ttyBridgeRef.current?.send(content)) ?? false;
    if (!sent) {
      addMessage({
        projectId: selectedProject.id,
        agentId: selectedAgent.id,
        role: "system",
        content: "TTY 尚未连接或已断开，请等待右侧 Agent TTY 进入 running 状态后再发送。",
        messageType: "text",
        status: "failed",
      });
      processingRef.current = false;
      setProcessing(false);
    }
  }

  function onCommandClick(command: Command) {
    void sendMessage(command.content);
  }

  function copyTerminal() {
    void navigator.clipboard?.writeText(agentLogs.map((log) => log.content).join("\n\n"));
  }

  return (
    <main className={terminalExpanded ? "app terminal-mode" : "app"}>
      <Sidebar openModal={setModal} />
      <section className="workspace">
        {creatingForProjectId ? (
          <CreateRunWizard projectId={creatingForProjectId} />
        ) : selectedRunId ? (
          <WorkflowWorkspace />
        ) : selectedSessionId ? (
          <DiscussionWorkspace selectedProject={selectedProject} openModal={setModal} />
        ) : (
          <>
            <Topbar
              selectedProject={selectedProject}
              selectedAgent={selectedAgent}
              onNewAgent={() => setModal({ type: "agent", mode: "create", projectId: selectedProject?.id })}
              onEditAgent={() => selectedAgent && setModal({ type: "agent", mode: "edit", agent: selectedAgent })}
              onDeleteAgent={() => selectedAgent && setModal({ type: "confirm-delete-agent", agent: selectedAgent })}
            />
            <div className="content-grid">
              <ChatPanel
                selectedAgent={selectedAgent}
                selectedProject={selectedProject}
                messages={agentMessages}
                commands={visibleCommands}
                input={input}
                processing={processing}
                onInputChange={setInput}
                onSend={() => void sendMessage()}
                onCommandClick={onCommandClick}
                onDeleteCommand={(command) => setModal({ type: "confirm-delete-command", command })}
                onAddCommand={() => setModal({ type: "command" })}
                onClear={() => selectedAgent && clearMessages(selectedAgent.id)}
              />
              <TerminalPanel
                selectedAgent={selectedAgent}
                selectedProject={selectedProject}
                expanded={terminalExpanded}
                onToggleExpanded={() => setTerminalExpanded((value) => !value)}
                onBridgeChange={registerTtyBridge}
                onTtyResponse={handleTtyResponse}
              />
            </div>
          </>
        )}
      </section>
      <ModalHost modal={modal} close={() => setModal(null)} />
    </main>
  );
}

type ModalState =
  | null
  | { type: "project"; mode: "create" | "edit"; project?: Project }
  | { type: "agent"; mode: "create" | "edit"; projectId?: string; agent?: Agent }
  | { type: "command" }
  | { type: "confirm-delete-project"; project: Project }
  | { type: "confirm-delete-agent"; agent: Agent }
  | { type: "confirm-delete-command"; command: Command }
  | { type: "discussion-group"; mode: "create" | "edit"; projectId?: string; group?: DiscussionGroup }
  | { type: "discussion-topic"; group: DiscussionGroup; projectCwd: string }
  | { type: "confirm-delete-group"; group: DiscussionGroup };

function Sidebar({ openModal }: { openModal: (modal: ModalState) => void }) {
  const projects = useConsoleStore((state) => state.projects);
  const agents = useConsoleStore((state) => state.agents);
  const selectedAgentId = useConsoleStore((state) => state.selectedAgentId);
  const expandedProjectIds = useConsoleStore((state) => state.expandedProjectIds);
  const selectProject = useConsoleStore((state) => state.selectProject);
  const selectAgent = useConsoleStore((state) => state.selectAgent);
  const toggleProject = useConsoleStore((state) => state.toggleProject);
  const selectedSessionId = useDiscussionStore((state) => state.selectedSessionId);
  const selectSession = useDiscussionStore((state) => state.selectSession);

  return (
    <aside className="sidebar">
      <header className="brand">
        <span className="brand-mark">
          <Bot size={20} />
        </span>
        <strong>Agent Console</strong>
        <button className="icon-button ghost pushed" title="折叠菜单" type="button">
          <Menu size={17} />
        </button>
      </header>

      <div className="sidebar-title">
        <span>项目 / Agent</span>
      </div>

      <div className="sidebar-actions">
        <button className="primary-button" type="button" onClick={() => openModal({ type: "project", mode: "create" })}>
          <Plus size={16} />
          新建项目
        </button>
        <button className="icon-button" title="刷新" type="button">
          <RefreshCcw size={16} />
        </button>
      </div>

      <nav className="project-tree" aria-label="项目和 Agent">
        {projects.map((project) => {
          const projectAgents = agents.filter((agent) => agent.projectId === project.id);
          const expanded = expandedProjectIds.includes(project.id);
          return (
            <div className="project-group" key={project.id}>
              <div className="project-row" onClick={() => selectProject(project.id)}>
                <button
                  className="tree-toggle"
                  type="button"
                  title={expanded ? "收起" : "展开"}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleProject(project.id);
                  }}
                >
                  {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <ProjectIcon project={project} />
                <span>{project.name}</span>
                <button
                  className="mini-action"
                  title="新增 Agent"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    openModal({ type: "agent", mode: "create", projectId: project.id });
                  }}
                >
                  <Plus size={15} />
                </button>
                <button
                  className="mini-action"
                  title="项目操作"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    openModal({ type: "project", mode: "edit", project });
                  }}
                >
                  <MoreVertical size={15} />
                </button>
              </div>
              {expanded && (
                <div className="agent-list">
                  {projectAgents.length === 0 ? (
                    <button
                      className="empty-agent"
                      type="button"
                      onClick={() => openModal({ type: "agent", mode: "create", projectId: project.id })}
                    >
                      创建 Agent
                    </button>
                  ) : (
                    projectAgents.map((agent) => (
                      <div
                        className={agent.id === selectedAgentId && !selectedSessionId ? "agent-row active" : "agent-row"}
                        key={agent.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          void selectSession("");
                          useWorkflowStore.getState().closeWorkflow();
                          selectAgent(agent.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            void selectSession("");
                            useWorkflowStore.getState().closeWorkflow();
                            selectAgent(agent.id);
                          }
                        }}
                      >
                        <StatusDot status={agent.status} />
                        <span>{agent.name}</span>
                        <button
                          className="mini-action"
                          title="编辑 Agent"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openModal({ type: "agent", mode: "edit", agent });
                          }}
                        >
                          <Edit3 size={13} />
                        </button>
                      </div>
                    ))
                  )}
                  <DiscussionTree project={project} openModal={openModal} />
                  <WorkflowTree project={project} />
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <button className="trash-link" type="button">
        <Archive size={16} />
        回收站
      </button>
    </aside>
  );
}

function DiscussionTree({
  project,
  openModal,
}: {
  project: Project;
  openModal: (modal: ModalState) => void;
}) {
  const groups = useDiscussionStore((state) => state.groups);
  const sessionsByGroup = useDiscussionStore((state) => state.sessionsByGroup);
  const loadSessions = useDiscussionStore((state) => state.loadSessions);
  const selectedSessionId = useDiscussionStore((state) => state.selectedSessionId);
  const selectSession = useDiscussionStore((state) => state.selectSession);
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const projectGroups = groups.filter((group) => group.projectId === project.id);

  function toggleGroup(groupId: string) {
    setExpandedGroups((prev) =>
      prev.includes(groupId) ? prev.filter((x) => x !== groupId) : [...prev, groupId],
    );
    if (!sessionsByGroup[groupId]) void loadSessions(groupId).catch(() => undefined);
  }

  return (
    <div className="discussion-tree">
      <div className="discussion-tree-head">
        <span>讨论组</span>
        <button
          className="mini-action"
          title="新建讨论组"
          type="button"
          onClick={() => openModal({ type: "discussion-group", mode: "create", projectId: project.id })}
        >
          <Plus size={14} />
        </button>
      </div>
      {projectGroups.length === 0 ? (
        <button
          className="empty-agent"
          type="button"
          onClick={() => openModal({ type: "discussion-group", mode: "create", projectId: project.id })}
        >
          创建讨论组
        </button>
      ) : (
        projectGroups.map((group) => {
          const open = expandedGroups.includes(group.id);
          const sessions = sessionsByGroup[group.id] || [];
          return (
            <div className="discussion-group-node" key={group.id}>
              <div className="discussion-group-row">
                <button className="tree-toggle" type="button" onClick={() => toggleGroup(group.id)}>
                  {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <Sparkles size={13} />
                <span className="discussion-group-name">{group.name}</span>
                <button
                  className="mini-action"
                  title="发起话题"
                  type="button"
                  onClick={() =>
                    openModal({ type: "discussion-topic", group, projectCwd: project.rootPath || defaultRootPath })
                  }
                >
                  <Send size={12} />
                </button>
                <button
                  className="mini-action"
                  title="编辑讨论组"
                  type="button"
                  onClick={() =>
                    openModal({ type: "discussion-group", mode: "edit", group, projectId: project.id })
                  }
                >
                  <Edit3 size={12} />
                </button>
                <button
                  className="mini-action"
                  title="删除讨论组"
                  type="button"
                  onClick={() => openModal({ type: "confirm-delete-group", group })}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {open && (
                <div className="discussion-session-list">
                  {sessions.length === 0 ? (
                    <span className="discussion-empty">暂无话题，点上方发送图标发起</span>
                  ) : (
                    sessions.map((session) => (
                      <div
                        key={session.id}
                        className={
                          session.id === selectedSessionId
                            ? "discussion-session-row active"
                            : "discussion-session-row"
                        }
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          useWorkflowStore.getState().closeWorkflow();
                          void selectSession(session.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            useWorkflowStore.getState().closeWorkflow();
                            void selectSession(session.id);
                          }
                        }}
                      >
                        <span className={`disc-status-dot ${session.status}`} />
                        <span className="discussion-session-topic">{session.topic || "未命名话题"}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function DiscussionWorkspace({
  selectedProject,
  openModal,
}: {
  selectedProject?: Project;
  openModal: (modal: ModalState) => void;
}) {
  const detail = useDiscussionStore((state) => state.detail);
  const groups = useDiscussionStore((state) => state.groups);
  const refreshDetail = useDiscussionStore((state) => state.refreshDetail);
  const selectSession = useDiscussionStore((state) => state.selectSession);
  const startSession = useDiscussionStore((state) => state.startSession);
  const stopSession = useDiscussionStore((state) => state.stopSession);
  const reopenSession = useDiscussionStore((state) => state.reopenSession);
  const closeSession = useDiscussionStore((state) => state.closeSession);
  const createRevision = useDiscussionStore((state) => state.createRevision);
  const [activeMemberId, setActiveMemberId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const status = detail?.session.status;
  const sessionId = detail?.session.id;
  useEffect(() => {
    if (status !== "running") return;
    const timer = window.setInterval(() => {
      void refreshDetail().catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [status, sessionId, refreshDetail]);

  useEffect(() => {
    if (detail && detail.members.length && !detail.members.some((m) => m.id === activeMemberId)) {
      setActiveMemberId(detail.session.currentMemberId || detail.members[0].id);
    }
  }, [detail, activeMemberId]);

  if (!detail) {
    return <div className="discussion-loading">加载话题讨论…</div>;
  }

  const { session, members } = detail;
  const group = groups.find((g) => g.id === session.groupId);
  const cwd = selectedProject?.rootPath || defaultRootPath;

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <div className="breadcrumb">
          <span>讨论组：</span>
          <strong>{group?.name ?? "—"}</strong>
          <span>/</span>
          <span>话题：</span>
          <strong>{session.topic || "未命名"}</strong>
          <span className={`tty-state ${session.status}`}>{session.status}</span>
          <span className="runtime-pill model">
            第 {session.round}/{session.maxRounds} 次发言
          </span>
          <button
            className="mini-action"
            title="返回（取消选中话题）"
            type="button"
            onClick={() => void selectSession("")}
          >
            <X size={14} />
          </button>
        </div>
        <div className="topbar-actions">
          {session.status === "idle" && (
            <button
              className="primary-button compact"
              type="button"
              disabled={busy}
              onClick={() => void act(() => startSession(session.id, cwd))}
            >
              <Send size={15} />
              开始讨论
            </button>
          )}
          {session.status === "running" && (
            <>
              <button
                className="icon-button"
                title="恢复讨论（异常中断/服务重启后重连成员会话）"
                type="button"
                disabled={busy}
                onClick={() => void act(() => reopenSession(session.id, cwd))}
              >
                <RotateCcw size={16} />
              </button>
              <button
                className="icon-button danger"
                title="强制结束（会话保留）"
                type="button"
                disabled={busy}
                onClick={() => void act(() => stopSession(session.id))}
              >
                <Square size={16} />
              </button>
            </>
          )}
          <button className="icon-button" title="刷新" type="button" onClick={() => void refreshDetail()}>
            <RefreshCcw size={16} />
          </button>
          <button
            className="icon-button danger"
            title="关闭会话（结束并 kill 全部成员 PTY）"
            type="button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await closeSession(session.id);
                openModal(null);
              })
            }
          >
            <Trash2 size={16} />
          </button>
        </div>
      </header>
      {error && <div className="discussion-error workspace-error">{error}</div>}
      <div className="content-grid">
        <DiscussionFlow
          detail={detail}
          onCreateRevision={(feedback, mode) => createRevision(session.id, feedback, mode, cwd)}
        />
        <MemberTerminalTabs
          session={session}
          members={members}
          activeMemberId={activeMemberId}
          onSelectMember={setActiveMemberId}
        />
      </div>
    </>
  );
}

function DiscussionFlow({
  detail,
  onCreateRevision,
}: {
  detail: DiscussionDetail;
  onCreateRevision: (feedback: string, mode: DiscussionRevisionMode) => Promise<unknown>;
}) {
  const { session, members, messages } = detail;
  const memberById = useMemo(() => {
    const map: Record<string, DiscussionMember> = {};
    for (const m of members) map[m.id] = m;
    return map;
  }, [members]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [priorOpen, setPriorOpen] = useState(false);
  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const current = memberById[session.currentMemberId];
  const isRevision = Boolean(session.parentSessionId);
  const priorRound = (session.revisionNo || 2) - 1;

  return (
    <section className="chat-panel discussion-flow">
      <header className="panel-header">
        <div className="panel-title">
          <span className="panel-icon">
            <Sparkles size={18} />
          </span>
          <strong>讨论会话流</strong>
          {isRevision && <span className="disc-round-pill">第 {session.revisionNo} 轮</span>}
        </div>
      </header>
      <div className="chat-scroll discussion-scroll">
        {isRevision && (
          <div className="disc-prior">
            <button
              type="button"
              className="disc-prior-toggle"
              onClick={() => setPriorOpen((v) => !v)}
            >
              {priorOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              第 {priorRound} 轮结论
            </button>
            {priorOpen && (
              <div className="disc-prior-body">
                {session.previousConclusionSnapshot?.trim() || "（上一轮无可用结论）"}
              </div>
            )}
          </div>
        )}
        {messages.length === 0 ? (
          <div className="empty-state">
            <p>还没有发言。{session.status === "idle" ? "点右上角「开始讨论」让主理人开场。" : "等待主理人开场…"}</p>
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.type === "user_feedback") {
              return (
                <div className="disc-msg disc-feedback-msg" key={msg.id}>
                  <div className="disc-msg-head">
                    <span className="disc-avatar disc-avatar-me">
                      <MessageSquare size={14} />
                    </span>
                    <strong>我的意见</strong>
                    <span className="disc-seq">#{msg.seq}</span>
                  </div>
                  <div className="disc-msg-body">{msg.content}</div>
                </div>
              );
            }
            const m = msg.memberId ? memberById[msg.memberId] : undefined;
            const color = memberColor(members, msg.memberId || "");
            return (
              <div className="disc-msg" key={msg.id}>
                <div className="disc-msg-head">
                  <span className="disc-avatar" style={{ background: color }}>
                    {(m?.name || "?").slice(0, 1)}
                  </span>
                  <strong>{m?.name || msg.memberId}</strong>
                  {m?.isHost && <span className="disc-host-tag">主理人</span>}
                  {m?.persona && <span className="disc-persona">{m.persona}</span>}
                  <span className="disc-seq">#{msg.seq}</span>
                </div>
                <div className="disc-msg-body">{msg.content}</div>
              </div>
            );
          })
        )}
        {session.status === "ended" && (
          <RevisionFeedbackBox onCreateRevision={onCreateRevision} />
        )}
        <div ref={bottomRef} />
      </div>
      <footer className="discussion-flow-foot">
        当前发言人：<strong style={{ color: current ? memberColor(members, current.id) : undefined }}>{current?.name || "—"}</strong>
        {session.status === "running"
          ? " （等待其通过 acg say 发言…）"
          : session.status === "ended"
            ? " （讨论已结束）"
            : " （尚未开始）"}
      </footer>
    </section>
  );
}

function RevisionFeedbackBox({
  onCreateRevision,
}: {
  onCreateRevision: (feedback: string, mode: DiscussionRevisionMode) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [mode, setMode] = useState<DiscussionRevisionMode>("revise");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!feedback.trim()) {
      setError("请填写你的意见");
      textareaRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await onCreateRevision(feedback.trim(), mode);
      // 成功后会切到新一轮 session，本组件随之卸载，无需手动清理。
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="disc-revision-entry">
        <button type="button" className="primary-button compact" onClick={() => setOpen(true)}>
          <MessageSquare size={15} />
          我有不同意见
        </button>
      </div>
    );
  }

  return (
    <form className="disc-revision-form" onSubmit={submit}>
      <label className="disc-revision-label">你希望这一轮重点解决什么？</label>
      <textarea
        ref={textareaRef}
        className="disc-revision-textarea"
        value={feedback}
        rows={3}
        placeholder="你希望这一轮重点解决什么？"
        onChange={(e) => setFeedback(e.target.value)}
        disabled={busy}
      />
      <div className="disc-revision-modes">
        <label className={mode === "revise" ? "active" : undefined}>
          <input
            type="radio"
            name="revision-mode"
            checked={mode === "revise"}
            onChange={() => setMode("revise")}
            disabled={busy}
          />
          基于现有结论修订
        </label>
        <label className={mode === "restart" ? "active" : undefined}>
          <input
            type="radio"
            name="revision-mode"
            checked={mode === "restart"}
            onChange={() => setMode("restart")}
            disabled={busy}
          />
          不沿用上轮结论，从头讨论
        </label>
      </div>
      {error && <div className="disc-revision-error">{error}</div>}
      <div className="disc-revision-actions">
        <button type="button" className="secondary-button compact" onClick={() => setOpen(false)} disabled={busy}>
          取消
        </button>
        <button type="submit" className="primary-button compact" disabled={busy}>
          <Send size={15} />
          发起新一轮
        </button>
      </div>
    </form>
  );
}

function MemberTerminalTabs({
  session,
  members,
  activeMemberId,
  onSelectMember,
}: {
  session: DiscussionSession;
  members: DiscussionMember[];
  activeMemberId: string;
  onSelectMember: (memberId: string) => void;
}) {
  return (
    <section className="terminal-panel">
      <header className="panel-header terminal-header">
        <div className="terminal-title">
          <span className="terminal-icon">
            <TerminalSquare size={18} />
          </span>
          <strong>成员终端</strong>
        </div>
        <div className="discussion-tabs">
          {members.map((m) => {
            const isCurrent = m.id === session.currentMemberId && session.status === "running";
            return (
              <button
                key={m.id}
                type="button"
                className={m.id === activeMemberId ? "discussion-tab active" : "discussion-tab"}
                onClick={() => onSelectMember(m.id)}
                title={isCurrent ? "当前发言人" : undefined}
              >
                <span className="disc-tab-dot" style={{ background: memberColor(members, m.id) }} />
                {m.name}
                {isCurrent && <span className="disc-tab-current">●</span>}
              </button>
            );
          })}
        </div>
      </header>
      <div className="terminal-body xterm-shell">
        {members.length === 0 || !activeMemberId ? (
          <pre>无成员</pre>
        ) : session.status === "idle" ? (
          <pre>尚未开始讨论；点「开始讨论」后成员终端将连接。</pre>
        ) : (
          <MemberTerminal
            key={`disc:${session.id}:member:${activeMemberId}:${session.status}`}
            ttyKey={`disc:${session.id}:member:${activeMemberId}`}
            readOnly={session.status === "ended"}
          />
        )}
      </div>
    </section>
  );
}

function MemberTerminal({ ttyKey, readOnly = false }: { ttyKey: string; readOnly?: boolean }) {
  const hostEl = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = hostEl.current;
    if (!element) return;
    let disposed = false;
    let terminal: Terminal | null = null;
    let fit: FitAddon | null = null;
    let socket: WebSocket | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let frame = 0;

    function start(attempt = 0) {
      if (disposed || !element) return;
      const box = element.getBoundingClientRect();
      if ((box.width < 20 || box.height < 20) && attempt < 60) {
        frame = window.requestAnimationFrame(() => start(attempt + 1));
        return;
      }
      terminal = new Terminal({
        convertEol: true,
        disableStdin: readOnly,
        cursorBlink: false,
        fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, Liberation Mono, monospace",
        fontSize: 12,
        lineHeight: 1.45,
        theme: {
          background: "#010202",
          foreground: "#c7cbd0",
          cursor: "#28e760",
          selectionBackground: "#264761",
          black: "#080c11",
          blue: "#2b85ff",
          cyan: "#35c5ff",
          green: "#55d76c",
          red: "#ff5c5c",
          white: "#d7e0ea",
          yellow: "#f2bf42",
        },
      });
      fit = new FitAddon();
      terminal.loadAddon(fit);
      try {
        terminal.open(element);
        fit.fit();
      } catch {
        terminal.dispose();
        terminal = null;
        return;
      }
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/api/tty/${encodeURIComponent(ttyKey)}`);
      socket.addEventListener("open", () => {
        socket?.send(JSON.stringify({ type: "resize", cols: terminal?.cols ?? 120, rows: terminal?.rows ?? 34 }));
      });
      socket.addEventListener("message", (event) => {
        const data = typeof event.data === "string" ? event.data : String(event.data);
        terminal?.write(data);
      });
      socket.addEventListener("close", () => {
        if (!disposed) terminal?.writeln("\r\n[agent-console] 成员终端已断开");
      });
      if (readOnly) {
        terminal.writeln("\r\n[agent-console] 讨论已结束，成员终端为只读。如需继续，请用「我有不同意见」发起新一轮。");
      }
      terminal.onData((data) => {
        if (readOnly) return;
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
      });
      terminal.onResize(({ cols, rows }) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows }));
      });
      resizeObserver = new ResizeObserver(() => {
        window.requestAnimationFrame(() => {
          if (!disposed) fit?.fit();
        });
      });
      resizeObserver.observe(element);
    }

    frame = window.requestAnimationFrame(() => start());
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      socket?.close();
      terminal?.dispose();
    };
  }, [ttyKey, readOnly]);

  return <div className="xterm-host" ref={hostEl} />;
}

// ====== 自动开发编排 UI ======

function WorkflowTree({ project }: { project: Project }) {
  const runs = useWorkflowStore((state) => state.runsByProject[project.id] || []);
  const selectedRunId = useWorkflowStore((state) => state.selectedRunId);
  const loadRuns = useWorkflowStore((state) => state.loadRuns);
  const selectRun = useWorkflowStore((state) => state.selectRun);
  const startCreate = useWorkflowStore((state) => state.startCreate);

  useEffect(() => {
    void loadRuns(project.id).catch(() => undefined);
  }, [loadRuns, project.id]);

  return (
    <div className="wf-tree">
      <div className="wf-tree-head">
        <WorkflowIcon size={13} />
        <span>自动开发</span>
        <button
          className="mini-action"
          title="新建自动开发运行"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            startCreate(project.id);
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      {runs.length === 0 ? (
        <div className="wf-tree-empty">暂无运行，点上方 + 新建</div>
      ) : (
        runs.map((run) => (
          <div
            key={run.id}
            className={run.id === selectedRunId ? "wf-run-row active" : "wf-run-row"}
            role="button"
            tabIndex={0}
            onClick={() => void selectRun(run.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void selectRun(run.id);
              }
            }}
          >
            <span className={`wf-status-dot ${run.status}`} />
            <span className="wf-run-goal">{run.goal || "未命名运行"}</span>
            <span className="wf-run-status">{WORKFLOW_RUN_STATUS_LABEL[run.status]}</span>
          </div>
        ))
      )}
    </div>
  );
}

function CreateRunWizard({ projectId }: { projectId: string }) {
  const project = useConsoleStore((state) => state.projects.find((p) => p.id === projectId));
  const templates = useWorkflowStore((state) => state.templates);
  const templateErrors = useWorkflowStore((state) => state.templateErrors);
  const loadTemplates = useWorkflowStore((state) => state.loadTemplates);
  const createRun = useWorkflowStore((state) => state.createRun);
  const cancelCreate = useWorkflowStore((state) => state.cancelCreate);
  const allGroups = useDiscussionStore((state) => state.groups);
  const loadGroups = useDiscussionStore((state) => state.loadGroups);
  const groups = useMemo(() => allGroups.filter((g) => g.projectId === projectId), [allGroups, projectId]);

  const [goal, setGoal] = useState("");
  const [repoPath, setRepoPath] = useState(project?.rootPath || "");
  const [baseBranch, setBaseBranch] = useState("main");
  const [integrationMode, setIntegrationMode] = useState<"pull_request" | "direct_merge">("pull_request");
  const [templateId, setTemplateId] = useState("");
  const [maxReviewRounds, setMaxReviewRounds] = useState(3);
  const [enableTesting, setEnableTesting] = useState(true);
  const [enableDoc, setEnableDoc] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [groupId, setGroupId] = useState("");
  // 角色 → 讨论组成员id 的绑定（roleId -> memberId）。
  const [roleMap, setRoleMap] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadTemplates(repoPath).catch(() => undefined);
  }, [loadTemplates, repoPath]);

  useEffect(() => {
    void loadGroups().catch(() => undefined);
  }, [loadGroups]);

  useEffect(() => {
    if (templates.length && !templateId) {
      const std = templates.find((t) => t.id === "standard-dev") || templates[0];
      setTemplateId(std.id);
      setEnableTesting(std.taskStages.some((s) => s.kind === "testing"));
    }
  }, [templates, templateId]);

  const selectedTemplate = templates.find((t) => t.id === templateId);
  const selectedGroup = groups.find((g) => g.id === groupId);

  // 当前模板涉及的角色（规划 + 各任务阶段 + 集成），去重。
  const roleIds = useMemo(() => {
    if (!selectedTemplate) return [] as string[];
    const ids = [
      selectedTemplate.planningRoleId,
      ...selectedTemplate.taskStages.map((s) => s.roleId),
      selectedTemplate.integrationRoleId,
    ].filter((x): x is string => !!x);
    return Array.from(new Set(ids));
  }, [selectedTemplate]);

  // 选组后按成员 duty/name 与 roleId 做初步自动匹配（可手改）。
  useEffect(() => {
    if (!selectedGroup || !roleIds.length) {
      setRoleMap({});
      return;
    }
    const members = selectedGroup.members;
    const next: Record<string, string> = {};
    for (const roleId of roleIds) {
      const label = WORKFLOW_ROLE_LABEL[roleId] || roleId;
      const hit =
        members.find((m) => `${m.duty}${m.name}`.toLowerCase().includes(roleId.toLowerCase())) ||
        members.find((m) => `${m.duty}${m.name}`.includes(label));
      next[roleId] = hit ? hit.id : members[0]?.id || "";
    }
    setRoleMap(next);
  }, [selectedGroup, roleIds]);

  async function submit() {
    setError("");
    if (!goal.trim()) {
      setError("请填写开发目标");
      return;
    }
    if (!repoPath.trim()) {
      setError("请填写仓库路径");
      return;
    }
    if (!templateId) {
      setError("请选择运行方式");
      return;
    }
    setBusy(true);
    try {
      // 由所选讨论组成员组装角色绑定（runtime/model/persona/duty 复用成员名册）。
      let roleBindings: Record<string, RoleBinding> | undefined;
      if (selectedGroup && roleIds.length) {
        roleBindings = {};
        for (const roleId of roleIds) {
          const memberId = roleMap[roleId];
          const member = selectedGroup.members.find((m) => m.id === memberId);
          if (member) {
            roleBindings[roleId] = {
              memberId: member.id,
              runtime: member.runtime,
              model: member.model,
              persona: member.persona,
              duty: member.duty,
            };
          }
        }
      }
      await createRun({
        projectId,
        goal: goal.trim(),
        repositoryPath: repoPath.trim(),
        baseBranch: baseBranch.trim(),
        integrationMode,
        workflowTemplateId: templateId,
        groupId: selectedGroup ? selectedGroup.id : undefined,
        settings: roleBindings ? { roleBindings } : undefined,
        overrides: { maxReviewRounds, enableTesting, enableDoc, integrationMode },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wf-workspace">
      <div className="wf-header">
        <div>
          <h2>新建自动开发运行</h2>
          <p className="wf-sub">说明目标、选择仓库与运行方式即可启动</p>
        </div>
        <button className="icon-button" type="button" title="取消" onClick={cancelCreate}>
          <X size={16} />
        </button>
      </div>

      <div className="wf-wizard">
        <label className="wf-field">
          <span>开发目标</span>
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} placeholder="例如：为登录模块增加双因素认证" />
        </label>
        <div className="wf-field-row">
          <label className="wf-field">
            <span>仓库路径</span>
            <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="/path/to/repo" />
          </label>
          <label className="wf-field">
            <span>目标分支</span>
            <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="main" />
          </label>
          <label className="wf-field">
            <span>最终方式</span>
            <select value={integrationMode} onChange={(e) => setIntegrationMode(e.target.value as "pull_request" | "direct_merge")}>
              <option value="pull_request">创建 PR</option>
              <option value="direct_merge">直接合并</option>
            </select>
          </label>
        </div>

        <div className="wf-field">
          <span>运行方式</span>
          <div className="wf-template-cards">
            {templates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                className={tpl.id === templateId ? "wf-template-card active" : "wf-template-card"}
                onClick={() => {
                  setTemplateId(tpl.id);
                  setEnableTesting(tpl.taskStages.some((s) => s.kind === "testing"));
                }}
              >
                <div className="wf-template-name">
                  {tpl.name}
                  <span className={`wf-source-tag ${tpl.source === "内置" ? "builtin" : "project"}`}>{tpl.source}</span>
                </div>
                <div className="wf-template-desc">{tpl.description}</div>
                <div className="wf-template-meta">
                  阶段：{tpl.taskStages.map((s) => s.kind).join(" → ")} · 最大重试 {tpl.settings.maxReviewRounds}
                </div>
              </button>
            ))}
          </div>
        </div>

        {templateErrors.length > 0 && (
          <div className="wf-error">
            项目 .acg 模板存在问题：
            <ul>
              {templateErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="wf-field">
          <span>讨论组（可选，复用成员作为执行角色）</span>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">不复用讨论组（使用内置默认角色）</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}（{g.members.length} 名成员）
              </option>
            ))}
          </select>
        </div>

        {selectedGroup && roleIds.length > 0 && (
          <div className="wf-field">
            <span>角色 → 成员映射</span>
            <div className="wf-role-map">
              {roleIds.map((roleId) => (
                <label className="wf-field-row-item" key={roleId}>
                  <span className="wf-role-name">{WORKFLOW_ROLE_LABEL[roleId] || roleId}</span>
                  <select
                    value={roleMap[roleId] || ""}
                    onChange={(e) => setRoleMap((prev) => ({ ...prev, [roleId]: e.target.value }))}
                  >
                    {selectedGroup.members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}（{m.runtime}
                        {m.model ? ` · ${m.model}` : ""}）
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>
        )}

        <button type="button" className="wf-advanced-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
          {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 高级设置
        </button>
        {advancedOpen && (
          <div className="wf-advanced">
            <label className="wf-field">
              <span>最大 Review/修改轮次</span>
              <input
                type="number"
                min={1}
                value={maxReviewRounds}
                onChange={(e) => setMaxReviewRounds(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <label className="wf-check">
              <input type="checkbox" checked={enableTesting} onChange={(e) => setEnableTesting(e.target.checked)} />
              启用独立测试角色
            </label>
            <label className="wf-check">
              <input type="checkbox" checked={enableDoc} onChange={(e) => setEnableDoc(e.target.checked)} />
              启用文档角色
            </label>
          </div>
        )}

        {selectedTemplate && (
          <div className="wf-summary">
            最终流程：规划 →{" "}
            {(enableDoc ? [...filterStages(selectedTemplate, enableTesting), "doc"] : filterStages(selectedTemplate, enableTesting)).join(" → ")}{" "}
            → 提交 → 集成（{integrationMode === "pull_request" ? "PR" : "直接合并"}）
          </div>
        )}

        {error && <div className="wf-error">{error}</div>}

        <div className="wf-actions">
          <button className="ghost-button" type="button" onClick={cancelCreate} disabled={busy}>
            取消
          </button>
          <button className="primary-button" type="button" onClick={() => void submit()} disabled={busy}>
            <Play size={15} /> {busy ? "启动中…" : "启动运行"}
          </button>
        </div>
      </div>
    </div>
  );
}

function filterStages(tpl: WorkflowTemplateSummary, enableTesting: boolean): string[] {
  return tpl.taskStages.map((s) => s.kind).filter((k) => (enableTesting ? true : k !== "testing"));
}

function WorkflowWorkspace() {
  const detail = useWorkflowStore((state) => state.detail);
  const refreshDetail = useWorkflowStore((state) => state.refreshDetail);
  const pauseRun = useWorkflowStore((state) => state.pauseRun);
  const resumeRun = useWorkflowStore((state) => state.resumeRun);
  const terminateRun = useWorkflowStore((state) => state.terminateRun);
  const retryStage = useWorkflowStore((state) => state.retryStage);
  const rewindDev = useWorkflowStore((state) => state.rewindDev);
  const raiseRetryLimit = useWorkflowStore((state) => state.raiseRetryLimit);
  const closeWorkflow = useWorkflowStore((state) => state.closeWorkflow);

  const status = detail?.run.status;
  const runId = detail?.run.id;
  useEffect(() => {
    if (!status || !WORKFLOW_ACTIVE_STATUSES.includes(status)) return;
    const timer = window.setInterval(() => {
      void refreshDetail().catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [status, runId, refreshDetail]);

  if (!detail) {
    return (
      <div className="wf-workspace">
        <div className="wf-header">
          <h2>加载运行…</h2>
        </div>
      </div>
    );
  }

  const { run, tasks, roleSessions } = detail;
  const snapshotSource = run.workflowSnapshot?.sources?.find((s) => s.kind === "workflow");
  const committed = tasks.filter((t) => t.status === "committed").length;
  const currentTask = tasks.find((t) => t.id === run.currentTaskId);
  const activeSessions = roleSessions.filter((s) => s.status === "starting" || s.status === "running");

  return (
    <div className="wf-workspace">
      <div className="wf-header">
        <div>
          <h2>
            {run.goal} <span className={`wf-badge ${run.status}`}>{WORKFLOW_RUN_STATUS_LABEL[run.status]}</span>
          </h2>
          <p className="wf-sub">
            {run.repositoryPath} · 目标分支 {run.baseBranch} · {run.integrationMode === "pull_request" ? "PR" : "直接合并"} ·
            模板 {run.workflowTemplateId}
            {snapshotSource ? ` (${snapshotSource.source} v${snapshotSource.version})` : ""}
          </p>
        </div>
        <div className="wf-controls">
          <button className="icon-button" type="button" title="刷新" onClick={() => void refreshDetail()}>
            <RefreshCcw size={15} />
          </button>
          {run.status === "running" || run.status === "integrating" ? (
            <button className="ghost-button" type="button" onClick={() => void pauseRun(run.id)}>
              <Pause size={14} /> 暂停
            </button>
          ) : run.status === "paused" || run.status === "needs_attention" ? (
            <button className="ghost-button" type="button" onClick={() => void resumeRun(run.id)}>
              <Play size={14} /> 恢复
            </button>
          ) : null}
          {run.status === "needs_attention" && (
            <>
              <button className="ghost-button" type="button" title="重新进入当前阶段并重注入提示词" onClick={() => void retryStage(run.id)}>
                <RefreshCcw size={14} /> 重试当前阶段
              </button>
              {currentTask && (
                <button className="ghost-button" type="button" title="退回到开发阶段继续修改" onClick={() => void rewindDev(run.id, currentTask.id)}>
                  <ChevronLeft size={14} /> 退回开发
                </button>
              )}
              <button className="ghost-button" type="button" title="提升 Review/修改重试上限后继续" onClick={() => void raiseRetryLimit(run.id)}>
                <Plus size={14} /> 提升重试上限
              </button>
            </>
          )}
          {!["completed", "terminated", "failed"].includes(run.status) && (
            <button className="ghost-button danger" type="button" onClick={() => void terminateRun(run.id)}>
              <Square size={13} /> 终止
            </button>
          )}
          <button className="icon-button" type="button" title="关闭" onClick={closeWorkflow}>
            <X size={15} />
          </button>
        </div>
      </div>

      {run.status === "awaiting_plan_approval" ? (
        <PlanConfirm detail={detail} />
      ) : (
        <div className="wf-body">
          <div className="wf-overview">
            <div className="wf-progress">
              <span>
                进度 {committed}/{tasks.length} 任务已提交
              </span>
              {currentTask && (
                <span>
                  当前：{currentTask.title}（{WORKFLOW_TASK_STATUS_LABEL[currentTask.status]}
                  {currentTask.reviewRounds ? ` · 第 ${currentTask.reviewRounds} 轮修改` : ""}）
                </span>
              )}
            </div>
            <div className="wf-task-list">
              {tasks.map((task) => (
                <div key={task.id} className={`wf-task-card ${task.status}`}>
                  <div className="wf-task-top">
                    <span className="wf-task-title">{task.title}</span>
                    <span className={`wf-task-status ${task.status}`}>{WORKFLOW_TASK_STATUS_LABEL[task.status]}</span>
                  </div>
                  {task.objective && <div className="wf-task-obj">{task.objective}</div>}
                  <div className="wf-task-meta">
                    {task.branch && (
                      <span>
                        <GitBranch size={11} /> {task.branch}
                      </span>
                    )}
                    {task.commitSha && <span>commit {task.commitSha.slice(0, 8)}</span>}
                    {task.dependencies.length > 0 && <span>依赖：{task.dependencies.join(", ")}</span>}
                  </div>
                </div>
              ))}
            </div>

            {run.status === "integrating" && <IntegrationPanel detail={detail} />}
            {run.status === "needs_attention" && (
              <div className="wf-attention">
                <AlertTriangle size={15} /> 当前运行需要人工处理。可恢复、调整后继续或终止。
              </div>
            )}
          </div>

          <div className="wf-terminals">
            <div className="wf-terminals-head">角色执行会话</div>
            {activeSessions.length === 0 ? (
              <div className="wf-tree-empty">暂无活动角色会话</div>
            ) : (
              activeSessions.map((session) => (
                <div className="wf-terminal-block" key={session.id}>
                  <div className="wf-terminal-label">
                    {session.roleId}
                    {session.taskId ? ` · ${session.taskId}` : ""} · {session.stageId}
                  </div>
                  <MemberTerminal ttyKey={`run:${run.id}:exec:${session.id}`} />
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PlanConfirm({ detail }: { detail: WorkflowDetail }) {
  const approvePlan = useWorkflowStore((state) => state.approvePlan);
  const [tasks, setTasks] = useState(detail.tasks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function updateTitle(id: string, title: string) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
  }
  function removeTask(id: string) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  async function approve() {
    setBusy(true);
    setError("");
    try {
      await approvePlan(
        detail.run.id,
        tasks.map((t) => ({
          id: t.id,
          title: t.title,
          objective: t.objective,
          dependencies: t.dependencies.filter((d) => tasks.some((x) => x.id === d)),
          acceptanceCriteria: t.acceptanceCriteria,
          scope: t.scope,
          forbiddenChanges: t.forbiddenChanges,
          suggestedTests: t.suggestedTests,
          expectedFiles: t.expectedFiles,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wf-body">
      <div className="wf-plan">
        <div className="wf-plan-head">
          <h3>计划确认</h3>
          <p className="wf-sub">确认或调整子任务后开始执行。依赖与顺序将决定串行执行计划。</p>
        </div>
        {tasks.length === 0 ? (
          <div className="wf-tree-empty">规划尚未产出子任务，请稍候或在右侧规划终端中查看。</div>
        ) : (
          tasks.map((task, idx) => (
            <div className="wf-plan-card" key={task.id}>
              <div className="wf-plan-top">
                <span className="wf-plan-idx">{idx + 1}</span>
                <input value={task.title} onChange={(e) => updateTitle(task.id, e.target.value)} />
                <button className="mini-action" type="button" title="删除任务" onClick={() => removeTask(task.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
              {task.objective && <div className="wf-plan-obj">{task.objective}</div>}
              {task.dependencies.length > 0 && <div className="wf-plan-dep">依赖：{task.dependencies.join(", ")}</div>}
              {task.acceptanceCriteria.length > 0 && (
                <ul className="wf-plan-acc">
                  {task.acceptanceCriteria.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
        {error && <div className="wf-error">{error}</div>}
        <div className="wf-actions">
          <button className="primary-button" type="button" disabled={busy || tasks.length === 0} onClick={() => void approve()}>
            <CheckCircle2 size={15} /> {busy ? "启动中…" : "确认计划并开始"}
          </button>
        </div>
      </div>
    </div>
  );
}

function IntegrationPanel({ detail }: { detail: WorkflowDetail }) {
  const integrateRun = useWorkflowStore((state) => state.integrateRun);
  const [confirm, setConfirm] = useState(false);
  const [testsPassed, setTestsPassed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [result, setResult] = useState<{ url?: string; degraded?: boolean; message?: string } | null>(null);
  const [error, setError] = useState("");

  const isDirect = detail.run.integrationMode === "direct_merge";

  // 集成角色 Agent 上报的全量测试结果（acg stage submit --type integration）。优先以它为准；
  // 没有上报时（手动模式）才用下方勾选框作人工覆盖（PRD §7.7）。
  const reportedIntegration = [...(detail.stageResults || [])].reverse().find((r) => r.type === "integration");
  const reportedFullTest = reportedIntegration?.payload?.fullTest as { passed?: boolean; summary?: string } | undefined;
  const hasReported = !!reportedFullTest;

  async function integrate() {
    setBusy(true);
    setBlockers([]);
    setError("");
    setResult(null);
    try {
      // 有 Agent 上报则不传 fullTestResult，让后端采用上报值；否则用人工勾选覆盖。
      const data = await integrateRun(detail.run.id, hasReported ? { confirm } : { confirm, fullTestResult: { passed: testsPassed } });
      setResult(data.result || null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 阻断信息来自后端 blockers，最近一次审计里也会记录；这里直接展示 message。
      setError(message);
      const fresh = useWorkflowStore.getState().detail;
      const lastBlock = fresh?.audit?.filter((a) => a.kind === "integration_blocked").slice(-1)[0];
      if (lastBlock && Array.isArray((lastBlock.detail as { blockers?: string[] }).blockers)) {
        setBlockers((lastBlock.detail as { blockers: string[] }).blockers);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wf-integration">
      <h3>最终集成</h3>
      <p className="wf-sub">
        集成前将检查全量测试、未关闭问题、提交链完整性与目标分支漂移。方式：
        {isDirect ? "直接合并（受保护分支会被拒绝）" : "创建 Pull Request"}。
      </p>
      {hasReported ? (
        <div className={reportedFullTest?.passed ? "wf-ok" : "wf-error"}>
          集成角色已执行全量测试：{reportedFullTest?.passed ? "通过" : "未通过"}
          {reportedFullTest?.summary ? `（${reportedFullTest.summary}）` : ""}
        </div>
      ) : (
        <label className="wf-check">
          <input type="checkbox" checked={testsPassed} onChange={(e) => setTestsPassed(e.target.checked)} />
          全量测试已通过（人工覆盖：集成角色尚未上报测试结果）
        </label>
      )}
      {isDirect && (
        <label className="wf-check">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          我已确认直接合并（二次确认）
        </label>
      )}
      {blockers.length > 0 && (
        <div className="wf-error">
          集成被阻止：
          <ul>
            {blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}
      {error && blockers.length === 0 && <div className="wf-error">{error}</div>}
      {result && (
        <div className="wf-ok">
          {result.url ? (
            <>
              已创建 PR：<a href={result.url} target="_blank" rel="noreferrer">{result.url}</a>
            </>
          ) : result.degraded ? (
            result.message
          ) : (
            "集成完成。"
          )}
        </div>
      )}
      <div className="wf-actions">
        <button className="primary-button" type="button" disabled={busy || (isDirect && !confirm)} onClick={() => void integrate()}>
          {isDirect ? "确认并直接合并" : "创建 PR"}
        </button>
      </div>
    </div>
  );
}

function Topbar({
  selectedProject,
  selectedAgent,
  onNewAgent,
  onEditAgent,
  onDeleteAgent,
}: {
  selectedProject?: Project;
  selectedAgent?: Agent;
  onNewAgent: () => void;
  onEditAgent: () => void;
  onDeleteAgent: () => void;
}) {
  return (
    <header className="topbar">
      <div className="breadcrumb">
        <span>当前项目：</span>
        <strong>{selectedProject?.name ?? "未选择项目"}</strong>
        <span>/</span>
        <span>Agent：</span>
        <strong>{selectedAgent?.name ?? "未选择 Agent"}</strong>
        {selectedAgent && <span className="runtime-pill">{agentRuntimeOptions[selectedAgent.runtime].label}</span>}
        {selectedAgent && <span className="runtime-pill model">{selectedAgent.model}</span>}
        <ChevronDown size={15} />
      </div>
      <div className="topbar-actions">
        <button className="primary-button compact" type="button" onClick={onNewAgent}>
          <Plus size={16} />
          新建 Agent
        </button>
        <button className="icon-button" title="编辑" type="button" onClick={onEditAgent}>
          <Edit3 size={16} />
        </button>
        <button className="icon-button danger" title="删除" type="button" onClick={onDeleteAgent}>
          <Trash2 size={16} />
        </button>
      </div>
    </header>
  );
}

function ChatPanel({
  selectedProject,
  selectedAgent,
  messages,
  commands,
  input,
  processing,
  onInputChange,
  onSend,
  onCommandClick,
  onDeleteCommand,
  onAddCommand,
  onClear,
}: {
  selectedProject?: Project;
  selectedAgent?: Agent;
  messages: Message[];
  commands: Command[];
  input: string;
  processing: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onCommandClick: (command: Command) => void;
  onDeleteCommand: (command: Command) => void;
  onAddCommand: () => void;
  onClear: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastMessageId = messages.at(-1)?.id ?? "";

  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lastMessageId, processing, selectedAgent?.id]);

  return (
    <section className="chat-panel">
      <header className="panel-header chat-header">
        <div className="agent-identity">
          <span className="agent-avatar">
            <Bot size={22} />
          </span>
          <div>
            <strong>{selectedAgent?.name ?? "No Agent"}</strong>
            <span>
              <StatusDot status={selectedAgent?.status ?? "offline"} /> {statusLabel(selectedAgent?.status)}
            </span>
          </div>
        </div>
        <div className="panel-tools">
          <button className="icon-button ghost" title="清空会话" type="button" onClick={onClear}>
            <RotateCcw size={16} />
          </button>
          <button className="icon-button ghost" title="搜索历史" type="button">
            <Search size={16} />
          </button>
          <button className="icon-button ghost" title="更多" type="button">
            <MoreVertical size={16} />
          </button>
        </div>
      </header>

      <div className="message-list">
        {!selectedAgent ? (
          <EmptyState title="未选择 Agent" description="从左侧项目树选择或创建一个 Agent。" />
        ) : messages.length === 0 ? (
          <EmptyState title="开始新的会话" description={`${selectedProject?.name ?? ""} / ${selectedAgent.name}`} />
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} agent={selectedAgent} />)
        )}
        {processing && selectedAgent && (
          <div className="message-row agent-message">
            <span className="small-avatar">
              <Bot size={18} />
            </span>
            <div className="bubble pending">
              <strong>{selectedAgent.name}</strong>
              <p>正在处理请求，请稍候...</p>
            </div>
          </div>
        )}
        <div className="message-list-end" ref={bottomRef} aria-hidden="true" />
      </div>

      <footer className="composer">
        <div className="command-bar">
          <span className="command-title">常用命令</span>
          {commands.map((command) => (
            <button
              className="command-chip"
              key={command.id}
              type="button"
              title={command.description}
              disabled={processing}
              onClick={() => onCommandClick(command)}
            >
              <span>{command.name}</span>
              <X
                size={13}
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteCommand(command);
                }}
              />
            </button>
          ))}
          <button className="command-chip add" type="button" disabled={processing} onClick={onAddCommand}>
            <Plus size={14} />
            添加命令
          </button>
        </div>

        <div className="input-shell">
          <textarea
            value={input}
            placeholder="输入消息..."
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (processing) return;
                onSend();
              }
            }}
          />
          <div className="input-toolbar">
            <button className="icon-button ghost" title="附件" type="button">
              <Paperclip size={18} />
            </button>
            <button className="icon-button ghost" title="图片" type="button">
              <ImageIcon size={18} />
            </button>
            <button className="icon-button ghost" title="代码" type="button">
              <Code2 size={18} />
            </button>
            <button className="icon-button ghost" title="快捷能力" type="button">
              <Sparkles size={18} />
            </button>
            <button className="send-button" type="button" disabled={processing || !input.trim()} onClick={onSend}>
              <Send size={18} />
            </button>
          </div>
        </div>
      </footer>
    </section>
  );
}

function TerminalPanel({
  selectedAgent,
  selectedProject,
  expanded,
  onToggleExpanded,
  onBridgeChange,
  onTtyResponse,
}: {
  selectedAgent?: Agent;
  selectedProject?: Project;
  expanded: boolean;
  onToggleExpanded: () => void;
  onBridgeChange: (bridge: TtyBridge | null) => void;
  onTtyResponse: (response: TtyResponse) => void;
}) {
  const terminalElement = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<{
    projectId: string;
    agentId: string;
    runtime: AgentRuntime;
    prompt: string;
    chunks: string[];
    bufferStart: number;
    allowEmptyResponse: boolean;
    startedAt: number;
    timer: number | null;
  } | null>(null);
  const [connectionState, setConnectionState] = useState("idle");
  const [restartKey, setRestartKey] = useState(0);

  useEffect(() => {
    if (!selectedAgent || !selectedProject || !terminalElement.current) {
      onBridgeChange(null);
      return;
    }

    let disposed = false;
    let terminal: Terminal | null = null;
    let fit: FitAddon | null = null;
    let frame = 0;
    let inputDisposable: { dispose: () => void } | null = null;
    let resizeDisposable: { dispose: () => void } | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const element = terminalElement.current;

    function flushCapturedOutput(force = false) {
      const capture = captureRef.current;
      if (!capture) return;
      if (capture.timer) window.clearTimeout(capture.timer);
      const screenText = readTerminalFrom(terminalRef.current, capture.bufferStart);
      const content = cleanTtyOutput(capture.chunks.join(""), capture.prompt, capture.runtime, screenText);
      if (!force && !content && Date.now() - capture.startedAt < CAPTURE_EMPTY_MAX_MS) {
        capture.timer = window.setTimeout(() => flushCapturedOutput(), CAPTURE_EMPTY_RETRY_MS);
        return;
      }

      captureRef.current = null;
      onTtyResponse({
        projectId: capture.projectId,
        agentId: capture.agentId,
        content,
      });
    }

    function scheduleCaptureFlush() {
      const capture = captureRef.current;
      if (!capture) return;
      if (capture.timer) window.clearTimeout(capture.timer);
      const screenText = readTerminalFrom(terminalRef.current, capture.bufferStart);
      const rawText = capture.chunks.join("");
      const content = cleanTtyOutput(rawText, capture.prompt, capture.runtime, screenText);
      if (content && isAgentReadyForInput(capture.runtime, screenText, rawText)) {
        flushCapturedOutput();
        return;
      }
      if (
        capture.allowEmptyResponse &&
        isAgentReadyAfterPrompt(capture.runtime, capture.prompt, screenText, rawText)
      ) {
        flushCapturedOutput(true);
        return;
      }
      capture.timer = window.setTimeout(() => flushCapturedOutput(), CAPTURE_IDLE_FLUSH_MS);
    }

    async function connect(activeTerminal: Terminal) {
      try {
        setConnectionState("starting");
        const cols = activeTerminal.cols;
        const rows = activeTerminal.rows;
        const response = await fetch(`/api/agents/${selectedAgent!.id}/runtime`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: selectedAgent, project: selectedProject, cols, rows }),
        });
        if (!response.ok) throw new Error(await response.text());
        if (disposed) return;

        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        const socket = new WebSocket(`${protocol}://${window.location.host}/api/tty/${encodeURIComponent(selectedAgent!.id)}`);
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          setConnectionState("running");
          socket.send(JSON.stringify({ type: "resize", cols: activeTerminal.cols, rows: activeTerminal.rows }));
        });
        socket.addEventListener("message", (event) => {
          const data = typeof event.data === "string" ? event.data : String(event.data);
          activeTerminal.write(data);
          if (captureRef.current?.agentId === selectedAgent!.id) {
            captureRef.current.chunks.push(data);
            scheduleCaptureFlush();
          }
        });
        socket.addEventListener("close", () => {
          setConnectionState("closed");
          flushCapturedOutput(true);
          if (!disposed) activeTerminal.writeln("\r\n[agent-console] tty disconnected");
        });
        socket.addEventListener("error", () => {
          setConnectionState("error");
          flushCapturedOutput(true);
          if (!disposed) activeTerminal.writeln("\r\n[agent-console] tty websocket error");
        });
      } catch (error) {
        setConnectionState("error");
        flushCapturedOutput(true);
        if (!disposed) activeTerminal.writeln(`[agent-console] failed to start tty: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    function startTerminal(attempt = 0) {
      if (disposed) return;
      const box = element.getBoundingClientRect();
      if ((box.width < 20 || box.height < 20) && attempt < 60) {
        frame = window.requestAnimationFrame(() => startTerminal(attempt + 1));
        return;
      }

      terminal = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, Liberation Mono, monospace",
        fontSize: 12,
        lineHeight: 1.45,
        theme: {
          background: "#010202",
          foreground: "#c7cbd0",
          cursor: "#28e760",
          selectionBackground: "#264761",
          black: "#080c11",
          blue: "#2b85ff",
          cyan: "#35c5ff",
          green: "#55d76c",
          red: "#ff5c5c",
          white: "#d7e0ea",
          yellow: "#f2bf42",
        },
      });
      fit = new FitAddon();
      terminal.loadAddon(fit);

      try {
        terminal.open(element);
        fit.fit();
      } catch (error) {
        terminal.dispose();
        terminal = null;
        setConnectionState("error");
        console.error(error);
        return;
      }

      terminalRef.current = terminal;
      fitRef.current = fit;

      inputDisposable = terminal.onData((data) => {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "input", data }));
        }
      });
      resizeDisposable = terminal.onResize(({ cols, rows }) => {
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });
      resizeObserver = new ResizeObserver(() => {
        window.requestAnimationFrame(() => {
          if (!disposed) fit?.fit();
        });
      });
      resizeObserver.observe(element);

      onBridgeChange({
        send: async (content) => {
          if (!selectedAgent || !selectedProject) return false;
          flushCapturedOutput(true);
          captureRef.current = {
            projectId: selectedProject.id,
            agentId: selectedAgent.id,
            runtime: selectedAgent.runtime,
            prompt: content,
            chunks: [],
            bufferStart: getTerminalBufferPosition(terminalRef.current),
            allowEmptyResponse: isNoOutputCommand(content),
            startedAt: Date.now(),
            timer: null,
          };
          try {
            const inputs = buildTtyInputSequence(content, selectedAgent.runtime);
            for (const [index, input] of inputs.entries()) {
              if (index > 0) await new Promise((resolve) => window.setTimeout(resolve, input.delayMs));
              for (let attempt = 0; attempt < 8; attempt += 1) {
                const response = await fetch(`/api/agents/${selectedAgent.id}/input`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ data: input.data }),
                });
                if (response.ok) break;
                if (attempt === 7) throw new Error(await response.text());
                await new Promise((resolve) => window.setTimeout(resolve, 250));
              }
            }
            if (captureRef.current?.agentId === selectedAgent.id && captureRef.current.allowEmptyResponse) {
              window.setTimeout(() => flushCapturedOutput(true), 250);
            }
            return true;
          } catch {
            if (captureRef.current?.agentId === selectedAgent.id) {
              if (captureRef.current.timer) window.clearTimeout(captureRef.current.timer);
              captureRef.current = null;
            }
            return false;
          }
        },
      });

      void connect(terminal);
    }

    frame = window.requestAnimationFrame(() => startTerminal());

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      inputDisposable?.dispose();
      resizeDisposable?.dispose();
      flushCapturedOutput(true);
      onBridgeChange(null);
      socketRef.current?.close();
      socketRef.current = null;
      terminal?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [onBridgeChange, onTtyResponse, selectedAgent, selectedProject, restartKey]);

  function clearTerminalView() {
    terminalRef.current?.clear();
  }

  async function stopTerminal() {
    if (!selectedAgent) return;
    await fetch(`/api/agents/${selectedAgent.id}/stop`, { method: "POST" });
    socketRef.current?.close();
  }

  async function restartTerminal() {
    if (!selectedAgent) return;
    await fetch(`/api/agents/${selectedAgent.id}/stop`, { method: "POST" });
    socketRef.current?.close();
    setRestartKey((value) => value + 1);
  }

  function copyTerminalSelection() {
    const selection = terminalRef.current?.getSelection();
    if (selection) void navigator.clipboard?.writeText(selection);
  }

  return (
    <section className="terminal-panel">
      <header className="panel-header terminal-header">
        <div className="terminal-title">
          <span className="terminal-icon">
            <TerminalSquare size={18} />
          </span>
          <strong>Agent TTY</strong>
          {selectedAgent && (
            <>
              <span className="tty-agent">{selectedAgent.key}</span>
              <span className={`tty-state ${connectionState}`}>{connectionState}</span>
            </>
          )}
        </div>
        <div className="panel-tools">
          <button className="icon-button ghost" title="重启 TTY" type="button" onClick={restartTerminal}>
            <RefreshCcw size={16} />
          </button>
          <button className="icon-button ghost" title="停止 Agent" type="button" onClick={stopTerminal}>
            <Square size={16} />
          </button>
          <button className="icon-button ghost" title="清空 Terminal" type="button" onClick={clearTerminalView}>
            <Trash2 size={16} />
          </button>
          <button className="icon-button ghost" title="复制选区" type="button" onClick={copyTerminalSelection}>
            <Copy size={16} />
          </button>
          <button className="icon-button ghost" title={expanded ? "退出放大" : "放大"} type="button" onClick={onToggleExpanded}>
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      </header>
      <div className="terminal-body xterm-shell">
        {!selectedAgent && <pre>no agent selected</pre>}
        <div className="xterm-host" ref={terminalElement} />
      </div>
    </section>
  );
}

function MessageBubble({ message, agent }: { message: Message; agent: Agent }) {
  const user = message.role === "user";
  return (
    <div className={user ? "message-row user-message" : "message-row agent-message"}>
      {!user && (
        <span className="small-avatar">
          <Bot size={18} />
        </span>
      )}
      <div className={user ? "bubble user" : "bubble"}>
        {!user && <strong>{agent.name}</strong>}
        {message.messageType === "command" && <span className="command-label">COMMAND</span>}
        <MessageContent content={message.content} />
      </div>
      <time>{formatTime(message.createdAt)}</time>
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  const displayContent = normalizeMessageContent(content);
  if (displayContent.includes("| --- |")) {
    const [lead, ...rest] = displayContent.split("\n\n");
    const rows = rest.join("\n\n").split("\n").filter((line) => line.startsWith("|"));
    const cells = rows
      .filter((_, index) => index !== 1)
      .map((line) =>
        line
          .split("|")
          .map((cell) => cell.trim())
          .filter(Boolean),
      );
    return (
      <>
        <p>{lead}</p>
        <table>
          <tbody>
            {cells.map((row, index) => (
              <tr key={row.join("-")}>
                {row.map((cell) => (index === 0 ? <th key={cell}>{cell}</th> : <td key={cell}>{cell}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  }
  const lines = displayContent.split("\n").filter((line, index, source) => line.trim() || (source[index - 1]?.trim() && source[index + 1]?.trim()));
  return (
    <>
      {lines.map((line, index) => (
        <p key={`${line}-${index}`}>{line || "\u00a0"}</p>
      ))}
    </>
  );
}

function ModalHost({ modal, close }: { modal: ModalState; close: () => void }) {
  const addProject = useConsoleStore((state) => state.addProject);
  const updateProject = useConsoleStore((state) => state.updateProject);
  const deleteProject = useConsoleStore((state) => state.deleteProject);
  const addAgent = useConsoleStore((state) => state.addAgent);
  const updateAgent = useConsoleStore((state) => state.updateAgent);
  const deleteAgent = useConsoleStore((state) => state.deleteAgent);
  const addCommand = useConsoleStore((state) => state.addCommand);
  const deleteCommand = useConsoleStore((state) => state.deleteCommand);
  const runtimeOptions = useRuntimeMetaStore((state) => state.options);
  const selectedProjectId = useConsoleStore((state) => state.selectedProjectId);
  const projects = useConsoleStore((state) => state.projects);
  const formProjectId = modal?.type === "agent" ? (modal.agent?.projectId ?? modal.projectId) : selectedProjectId;
  const formProject = projects.find((project) => project.id === formProjectId);
  const defaultAgentFormForProject: AgentForm = {
    ...emptyAgentForm,
    workdir: formProject?.rootPath ?? defaultRootPath,
  };

  const [projectForm, setProjectForm] = useState<ProjectForm>(() =>
    modal?.type === "project" && modal.project
      ? {
          name: modal.project.name,
          key: modal.project.key,
          description: modal.project.description,
          rootPath: modal.project.rootPath,
          icon: modal.project.icon,
          defaultAgent: false,
        }
      : emptyProjectForm,
  );
  const [agentForm, setAgentForm] = useState<AgentForm>(() =>
    modal?.type === "agent" && modal.agent
      ? {
          name: modal.agent.name,
          key: modal.agent.key,
          runtime: modal.agent.runtime,
          model: modal.agent.model,
          description: modal.agent.description,
          workdir: modal.agent.workdir,
          startCommand: modal.agent.startCommand,
          status: modal.agent.status,
        }
      : defaultAgentFormForProject,
  );
  const [commandForm, setCommandForm] = useState<CommandForm>(emptyCommandForm);

  useEffect(() => {
    if (modal?.type === "project" && modal.project) {
      setProjectForm({
        name: modal.project.name,
        key: modal.project.key,
        description: modal.project.description,
        rootPath: modal.project.rootPath,
        icon: modal.project.icon,
        defaultAgent: false,
      });
    } else if (modal?.type === "project") {
      setProjectForm(emptyProjectForm);
    }

    if (modal?.type === "agent" && modal.agent) {
      const runtime = modal.agent.runtime && agentRuntimeOptions[modal.agent.runtime] ? modal.agent.runtime : "codex";
      const model = modal.agent.model || agentRuntimeOptions[runtime].defaultModel;
      setAgentForm({
        name: modal.agent.name,
        key: modal.agent.key,
        runtime,
        model,
        description: modal.agent.description,
        workdir: modal.agent.workdir || formProject?.rootPath || defaultRootPath,
        startCommand: normalizeStartCommand(modal.agent.startCommand, runtime, model),
        status: modal.agent.status,
      });
    } else if (modal?.type === "agent") {
      setAgentForm({
        ...emptyAgentForm,
        workdir: formProject?.rootPath ?? defaultRootPath,
      });
    }

    if (modal?.type === "command") {
      setCommandForm(emptyCommandForm);
    }
  }, [formProject?.rootPath, modal]);

  // 模型列表实时加载后，若新建表单当前模型已不在可选项里，吸附到该 runtime 的默认模型
  // （仅新建 Agent；编辑时保留 Agent 自身已配置的模型）。
  useEffect(() => {
    if (modal?.type !== "agent" || modal.agent) return;
    setAgentForm((prev) => {
      if (runtimeOptions[prev.runtime].models.some((m) => m.value === prev.model)) return prev;
      const model = runtimeOptions[prev.runtime].defaultModel;
      return { ...prev, model, startCommand: nextStartCommand(prev, prev.runtime, model) };
    });
  }, [runtimeOptions, modal]);

  if (!modal) return null;

  function submitProject(event: FormEvent) {
    event.preventDefault();
    if (modal?.type !== "project" || !projectForm.name.trim() || !projectForm.key.trim()) return;
    if (modal.mode === "edit" && modal.project) {
      updateProject(modal.project.id, projectForm);
    } else {
      addProject(projectForm);
    }
    close();
  }

  function submitAgent(event: FormEvent) {
    event.preventDefault();
    if (modal?.type !== "agent" || !agentForm.name.trim() || !agentForm.key.trim()) return;
    if (modal.mode === "edit" && modal.agent) {
      updateAgent(modal.agent.id, agentForm);
    } else {
      addAgent(modal.projectId ?? selectedProjectId, agentForm);
    }
    close();
  }

  function submitCommand(event: FormEvent) {
    event.preventDefault();
    if (!commandForm.name.trim() || !commandForm.content.trim()) return;
    addCommand(commandForm);
    close();
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <div
        className={modal.type === "discussion-group" ? "modal discussion-group-modal" : "modal"}
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="icon-button modal-close" title="关闭" type="button" onClick={close}>
          <X size={18} />
        </button>

        {modal.type === "project" && (
          <form onSubmit={submitProject}>
            <h2>{modal.mode === "edit" ? "编辑项目" : "新建项目"}</h2>
            <Field label="项目名称" required>
              <input value={projectForm.name} onChange={(event) => setProjectForm({ ...projectForm, name: event.target.value })} />
            </Field>
            <Field label="项目标识" required>
              <input value={projectForm.key} onChange={(event) => setProjectForm({ ...projectForm, key: event.target.value })} />
            </Field>
            <Field label="目录路径" required>
              <input
                placeholder="/mnt/h/ai/orchestration"
                value={projectForm.rootPath}
                onChange={(event) => setProjectForm({ ...projectForm, rootPath: event.target.value })}
              />
            </Field>
            <Field label="项目描述">
              <textarea
                value={projectForm.description}
                onChange={(event) => setProjectForm({ ...projectForm, description: event.target.value })}
              />
            </Field>
            <Field label="项目图标">
              <select value={projectForm.icon} onChange={(event) => setProjectForm({ ...projectForm, icon: event.target.value })}>
                <option value="store">电商</option>
                <option value="chart">数据</option>
                <option value="infinity">DevOps</option>
                <option value="support">客服</option>
                <option value="shield">安全</option>
              </select>
            </Field>
            {modal.mode === "create" && (
              <label className="checkbox-line">
                <input
                  checked={projectForm.defaultAgent}
                  type="checkbox"
                  onChange={(event) => setProjectForm({ ...projectForm, defaultAgent: event.target.checked })}
                />
                同时创建默认 Agent
              </label>
            )}
            <div className="modal-actions">
              {modal.mode === "edit" && modal.project && (
                <button
                  className="danger-button"
                  type="button"
                  onClick={() => {
                    close();
                    window.setTimeout(() => {
                      if (window.confirm("删除项目会同时移除其 Agent、消息和 Terminal 日志，是否继续？")) {
                        deleteProject(modal.project!.id);
                      }
                    });
                  }}
                >
                  <Trash2 size={16} />
                  删除项目
                </button>
              )}
              <button className="secondary-button" type="button" onClick={close}>
                取消
              </button>
              <button className="primary-button compact" type="submit">
                保存
              </button>
            </div>
          </form>
        )}

        {modal.type === "agent" && (
          <form onSubmit={submitAgent}>
            <h2>{modal.mode === "edit" ? "编辑 Agent" : "新建 Agent"}</h2>
            <Field label="Agent 名称" required>
              <input value={agentForm.name} onChange={(event) => setAgentForm({ ...agentForm, name: event.target.value })} />
            </Field>
            <Field label="Agent Key" required>
              <input value={agentForm.key} onChange={(event) => setAgentForm({ ...agentForm, key: event.target.value })} />
            </Field>
            <Field label="Agent 类型">
              <select
                value={agentForm.runtime}
                onChange={(event) => {
                  const runtime = event.target.value as AgentRuntime;
                  const model = runtimeOptions[runtime].defaultModel;
                  setAgentForm({
                    ...agentForm,
                    runtime,
                    model,
                    startCommand: nextStartCommand(agentForm, runtime, model),
                  });
                }}
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
              </select>
            </Field>
            <Field label="模型">
              <select
                value={agentForm.model}
                onChange={(event) => {
                  const model = event.target.value;
                  setAgentForm({
                    ...agentForm,
                    model,
                    startCommand: nextStartCommand(agentForm, agentForm.runtime, model),
                  });
                }}
              >
                {runtimeOptions[agentForm.runtime].models.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="状态">
              <select value={agentForm.status} onChange={(event) => setAgentForm({ ...agentForm, status: event.target.value as AgentStatus })}>
                <option value="online">在线</option>
                <option value="offline">离线</option>
                <option value="running">执行中</option>
                <option value="error">异常</option>
                <option value="paused">暂停</option>
              </select>
            </Field>
            <Field label="启动命令">
              <input
                value={agentForm.startCommand}
                onChange={(event) => setAgentForm({ ...agentForm, startCommand: event.target.value })}
              />
            </Field>
            <Field label="工作目录">
              <input value={agentForm.workdir} onChange={(event) => setAgentForm({ ...agentForm, workdir: event.target.value })} />
            </Field>
            <Field label="描述">
              <textarea value={agentForm.description} onChange={(event) => setAgentForm({ ...agentForm, description: event.target.value })} />
            </Field>
            <div className="modal-actions">
              {modal.mode === "edit" && modal.agent && (
                <button
                  className="danger-button"
                  type="button"
                  onClick={() => {
                    close();
                    window.setTimeout(() => {
                      if (window.confirm("删除 Agent 会移除其消息和 Terminal 日志，是否继续？")) {
                        deleteAgent(modal.agent!.id);
                      }
                    });
                  }}
                >
                  <Trash2 size={16} />
                  删除 Agent
                </button>
              )}
              <button className="secondary-button" type="button" onClick={close}>
                取消
              </button>
              <button className="primary-button compact" type="submit">
                保存
              </button>
            </div>
          </form>
        )}

        {modal.type === "command" && (
          <form onSubmit={submitCommand}>
            <h2>添加常用命令</h2>
            <Field label="命令名称" required>
              <input
                placeholder="/deploy"
                value={commandForm.name}
                onChange={(event) => setCommandForm({ ...commandForm, name: event.target.value })}
              />
            </Field>
            <Field label="命令内容" required>
              <input
                placeholder="/deploy env=dev"
                value={commandForm.content}
                onChange={(event) => setCommandForm({ ...commandForm, content: event.target.value })}
              />
            </Field>
            <Field label="命令说明">
              <input
                value={commandForm.description}
                onChange={(event) => setCommandForm({ ...commandForm, description: event.target.value })}
              />
            </Field>
            <Field label="作用范围">
              <select value={commandForm.scope} onChange={(event) => setCommandForm({ ...commandForm, scope: event.target.value as CommandScope })}>
                <option value="agent">当前 Agent</option>
                <option value="project">当前项目</option>
                <option value="global">全局</option>
              </select>
            </Field>
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={close}>
                取消
              </button>
              <button className="primary-button compact" type="submit">
                保存
              </button>
            </div>
          </form>
        )}

        {modal.type === "confirm-delete-command" && (
          <ConfirmDialog
            title="删除命令"
            description={`确认删除 ${modal.command.name}？默认命令也会从本地配置中移除。`}
            onCancel={close}
            onConfirm={() => {
              deleteCommand(modal.command.id);
              close();
            }}
          />
        )}

        {modal.type === "confirm-delete-agent" && (
          <ConfirmDialog
            title="删除 Agent"
            description={`确认删除 ${modal.agent.name}？其消息记录和终端状态会一起移除。`}
            onCancel={close}
            onConfirm={() => {
              deleteAgent(modal.agent.id);
              close();
            }}
          />
        )}

        {modal.type === "confirm-delete-project" && (
          <ConfirmDialog
            title="删除项目"
            description={`确认删除 ${modal.project.name}？项目下的 Agent、消息和终端状态会一起移除。`}
            onCancel={close}
            onConfirm={() => {
              deleteProject(modal.project.id);
              close();
            }}
          />
        )}

        {modal.type === "discussion-group" && <DiscussionGroupModal modal={modal} close={close} />}

        {modal.type === "discussion-topic" && <DiscussionTopicModal modal={modal} close={close} />}

        {modal.type === "confirm-delete-group" && <ConfirmDeleteGroup modal={modal} close={close} />}
      </div>
    </div>
  );
}

function DiscussionGroupModal({
  modal,
  close,
}: {
  modal: Extract<NonNullable<ModalState>, { type: "discussion-group" }>;
  close: () => void;
}) {
  const createGroup = useDiscussionStore((state) => state.createGroup);
  const updateGroup = useDiscussionStore((state) => state.updateGroup);
  const runtimeOptions = useRuntimeMetaStore((state) => state.options);
  const [form, setForm] = useState<DiscussionGroupForm>(() =>
    modal.group
      ? {
          name: modal.group.name,
          rule: modal.group.rule,
          members: modal.group.members.map((m) => ({
            id: m.id,
            name: m.name,
            runtime: m.runtime,
            model: m.model,
            persona: m.persona,
            duty: m.duty,
            isHost: m.isHost,
          })),
        }
      : emptyDiscussionGroupForm,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function patchMember(idx: number, patch: Partial<DiscussionMemberForm>) {
    setForm((f) => ({ ...f, members: f.members.map((m, i) => (i === idx ? { ...m, ...patch } : m)) }));
  }
  function setHost(idx: number) {
    setForm((f) => ({ ...f, members: f.members.map((m, i) => ({ ...m, isHost: i === idx })) }));
  }
  function addMember() {
    setForm((f) => ({ ...f, members: [...f.members, emptyDiscussionMemberForm(false)] }));
  }
  function removeMember(idx: number) {
    setForm((f) => {
      if (f.members.length <= 1) return f;
      const members = f.members.filter((_, i) => i !== idx);
      if (!members.some((m) => m.isHost) && members[0]) {
        members[0] = { ...members[0], isHost: true };
      }
      return { ...f, members };
    });
  }

  const hostCount = form.members.filter((m) => m.isHost).length;
  const lowerNames = form.members.map((m) => m.name.trim().toLowerCase());
  const dupName = lowerNames.some((n, i) => n && lowerNames.indexOf(n) !== i);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!form.name.trim()) return setError("请填写讨论组名称");
    if (form.members.length < 1) return setError("至少需要一个成员");
    if (hostCount !== 1) return setError("必须有且只有一个主理人");
    if (form.members.some((m) => !m.name.trim())) return setError("成员名称不能为空");
    if (dupName) return setError("成员名称不能重复");
    setBusy(true);
    try {
      if (modal.mode === "edit" && modal.group) {
        await updateGroup(modal.group.id, form);
      } else {
        await createGroup(modal.projectId || "", form);
      }
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="discussion-group-form">
      <header className="discussion-group-modal-head">
        <div className="discussion-group-title-icon">
          <Users size={18} />
        </div>
        <div>
          <h2>{modal.mode === "edit" ? "编辑讨论组" : "新建讨论组"}</h2>
          <p>
            {form.members.length} 位成员 / {hostCount} 位主理人
          </p>
        </div>
      </header>
      <div className="discussion-group-basics">
        <Field label="讨论组名称" required>
          <input
            placeholder="例如：方案评审小组"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="讨论规则">
          <textarea
            placeholder="例如：每人发言≤200字，先亮观点再给理由"
            value={form.rule}
            onChange={(e) => setForm({ ...form, rule: e.target.value })}
          />
        </Field>
      </div>
      <div className="member-editor">
        <div className="member-editor-head">
          <span>成员（主理人单选）</span>
          <button className="secondary-button" type="button" onClick={addMember}>
            <Plus size={14} />
            添加成员
          </button>
        </div>
        {form.members.map((m, idx) => (
          <div className={m.isHost ? "member-row host" : "member-row"} key={idx}>
            <div className="member-row-head">
              <div className="member-avatar">{m.name.trim().slice(0, 1) || idx + 1}</div>
              <div className="member-row-title">
                <strong>{m.name.trim() || `成员 ${idx + 1}`}</strong>
                <span>{agentRuntimeOptions[m.runtime].label}</span>
              </div>
              <button
                className={m.isHost ? "host-toggle active" : "host-toggle"}
                type="button"
                aria-pressed={m.isHost}
                title={m.isHost ? "当前主理人" : "设为主理人"}
                onClick={() => setHost(idx)}
              >
                <Crown size={14} />
                <span>{m.isHost ? "主理人" : "设为主理人"}</span>
              </button>
              <button
                className="icon-button danger"
                title="移除成员"
                type="button"
                onClick={() => removeMember(idx)}
                disabled={form.members.length <= 1}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="member-grid">
              <label className="member-field member-name">
                <span>成员名称</span>
                <input
                  placeholder="成员名"
                  value={m.name}
                  onChange={(e) => patchMember(idx, { name: e.target.value })}
                />
              </label>
              <label className="member-field member-runtime">
                <span>运行时</span>
                <select
                  value={m.runtime}
                  onChange={(e) => {
                    const runtime = e.target.value as AgentRuntime;
                    patchMember(idx, { runtime, model: runtimeOptions[runtime].defaultModel });
                  }}
                >
                  {(Object.keys(agentRuntimeOptions) as AgentRuntime[]).map((key) => (
                    <option key={key} value={key}>
                      {agentRuntimeOptions[key].label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="member-field member-model">
                <span>模型</span>
                <select value={m.model} onChange={(e) => patchMember(idx, { model: e.target.value })}>
                  {runtimeOptions[m.runtime].models.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                  {!runtimeOptions[m.runtime].models.some((opt) => opt.value === m.model) && m.model ? (
                    <option value={m.model}>{m.model}</option>
                  ) : null}
                </select>
              </label>
              <label className="member-field member-persona">
                <span>人设</span>
                <textarea
                  placeholder="例如：偏技术可行性"
                  value={m.persona}
                  onChange={(e) => patchMember(idx, { persona: e.target.value })}
                />
              </label>
              <label className="member-field member-duty">
                <span>职责</span>
                <textarea
                  placeholder="例如：指出风险和替代方案"
                  value={m.duty}
                  onChange={(e) => patchMember(idx, { duty: e.target.value })}
                />
              </label>
            </div>
          </div>
        ))}
      </div>
      {error && <div className="discussion-error">{error}</div>}
      <div className="modal-actions">
        <button className="secondary-button" type="button" onClick={close}>
          取消
        </button>
        <button className="primary-button compact" type="submit" disabled={busy}>
          {modal.mode === "edit" ? "保存" : "创建"}
        </button>
      </div>
    </form>
  );
}

function DiscussionTopicModal({
  modal,
  close,
}: {
  modal: Extract<NonNullable<ModalState>, { type: "discussion-topic" }>;
  close: () => void;
}) {
  const createSession = useDiscussionStore((state) => state.createSession);
  const startSession = useDiscussionStore((state) => state.startSession);
  const selectSession = useDiscussionStore((state) => state.selectSession);
  const [topic, setTopic] = useState("");
  const [maxRounds, setMaxRounds] = useState(20);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const host = modal.group.members.find((m) => m.isHost);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!topic.trim()) return setError("请填写话题");
    setBusy(true);
    try {
      const session = await createSession(modal.group.id, topic.trim(), maxRounds);
      await startSession(session.id, modal.projectCwd);
      await selectSession(session.id);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h2>发起话题讨论</h2>
      <p className="confirm-copy">
        讨论组：{modal.group.name}（主理人：{host?.name ?? "—"}）
      </p>
      <Field label="话题" required>
        <textarea placeholder="本次讨论要解决的问题" value={topic} onChange={(e) => setTopic(e.target.value)} />
      </Field>
      <Field label="最大发言次数（硬上限）">
        <input
          type="number"
          min={1}
          value={maxRounds}
          onChange={(e) => setMaxRounds(Math.max(1, Number(e.target.value) || 1))}
        />
      </Field>
      {error && <div className="discussion-error">{error}</div>}
      <div className="modal-actions">
        <button className="secondary-button" type="button" onClick={close}>
          取消
        </button>
        <button className="primary-button compact" type="submit" disabled={busy}>
          创建并开始
        </button>
      </div>
    </form>
  );
}

function ConfirmDeleteGroup({
  modal,
  close,
}: {
  modal: Extract<NonNullable<ModalState>, { type: "confirm-delete-group" }>;
  close: () => void;
}) {
  const deleteGroup = useDiscussionStore((state) => state.deleteGroup);
  return (
    <ConfirmDialog
      title="删除讨论组"
      description={`确认删除 ${modal.group.name}？其下的所有话题讨论与发言记录都会一起移除。`}
      onCancel={close}
      onConfirm={() => {
        void deleteGroup(modal.group.id);
        close();
      }}
    />
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="field">
      <span>
        {label}
        {required && <em>*</em>}
      </span>
      {children}
    </label>
  );
}

function ConfirmDialog({
  title,
  description,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div>
      <h2>{title}</h2>
      <p className="confirm-copy">{description}</p>
      <div className="modal-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>
          取消
        </button>
        <button className="danger-button solid" type="button" onClick={onConfirm}>
          删除
        </button>
      </div>
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty-state">
      <Bot size={34} />
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

function ProjectIcon({ project }: { project: Project }) {
  const iconProps = { size: 15 };
  if (project.icon === "chart") return <BarChart3 className="project-icon purple" {...iconProps} />;
  if (project.icon === "infinity") return <Activity className="project-icon cyan" {...iconProps} />;
  if (project.icon === "support") return <Clipboard className="project-icon yellow" {...iconProps} />;
  if (project.icon === "shield") return <Shield className="project-icon red" {...iconProps} />;
  return <Archive className="project-icon violet" {...iconProps} />;
}

function StatusDot({ status }: { status?: AgentStatus }) {
  return <span className={`status-dot ${status ?? "offline"}`} />;
}

function statusLabel(status?: AgentStatus) {
  const labels: Record<AgentStatus, string> = {
    online: "在线",
    offline: "离线",
    running: "执行中",
    error: "异常",
    paused: "暂停",
  };
  return labels[status ?? "offline"];
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function buildTtyInputSequence(content: string, runtime: AgentRuntime) {
  if (/[\r\n]$/.test(content)) return [{ data: content, delayMs: 0 }];
  if (runtime === "codex") {
    return [
      { data: content, delayMs: 0 },
      { data: "\r", delayMs: 180 },
    ];
  }
  return [{ data: `${content}\r`, delayMs: 0 }];
}

function isNoOutputCommand(content: string) {
  const command = content.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return NO_OUTPUT_COMMANDS.has(command);
}

function getTerminalBufferPosition(terminal: Terminal | null) {
  const buffer = terminal?.buffer.active;
  if (!terminal || !buffer) return 0;
  return Math.max(0, buffer.baseY + buffer.cursorY);
}

function readTerminalFrom(terminal: Terminal | null, startPosition: number) {
  const buffer = terminal?.buffer.active;
  if (!terminal || !buffer) return "";

  const start = Math.max(0, Math.min(startPosition, buffer.length - 1));
  const end = Math.min(buffer.length, buffer.baseY + terminal.rows);
  const lines: string[] = [];
  for (let index = start; index < end; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

function cleanTtyOutput(raw: string, prompt: string, runtime: AgentRuntime, screenText = "") {
  if (runtime === "codex") {
    const screenContent = extractCodexAssistantText(screenText, prompt);
    if (screenContent) return screenContent;

    const rawContent = extractCodexAssistantText(sanitizeTerminalText(raw), prompt);
    if (rawContent) return rawContent;

    return "";
  }

  if (runtime === "claude") {
    const screenContent = extractClaudeAssistantText(screenText, prompt);
    if (screenContent) return repairClaudeAnswerText(screenContent);

    const rawContent = extractClaudeAssistantText(sanitizeTerminalText(raw), prompt);
    if (rawContent) return repairClaudeAnswerText(rawContent);

    return "";
  }

  const promptText = prompt.trim();
  const lines = sanitizeTerminalText(raw)
    .split("\n")
    .map((line) => line.trimEnd());

  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();

  const filtered = lines.filter((line, index) => {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (!normalized) return true;
    if (normalized === promptText) return false;
    if (index === 0 && promptText && normalized.endsWith(promptText)) return false;
    return true;
  });

  return filtered.join("\n").trim();
}

function sanitizeTerminalText(raw: string) {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-_][0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u0007/g, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function extractCodexAssistantText(text: string, prompt: string) {
  const promptText = prompt.trim();
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\u00a0/g, " ").trimEnd());
  const searchStart = findPromptEchoIndex("codex", lines, promptText) + 1;

  let assistantStart = -1;
  for (let index = searchStart; index < lines.length; index += 1) {
    const candidate = normalizeTerminalLine(stripCodexAssistantChrome(lines[index]));
    if (/^\s*•\s+\S/.test(lines[index]) && candidate && !isCodexTuiLine(candidate, promptText)) {
      assistantStart = index;
    }
  }

  if (assistantStart === -1) return "";

  const block: string[] = [];
  for (let index = assistantStart; index < lines.length; index += 1) {
    const normalized = normalizeTerminalLine(lines[index]);
    if (index > assistantStart && isCodexConversationBoundary(normalized, promptText)) break;
    const line = stripCodexAssistantChrome(lines[index]);
    if (isCodexTuiLine(normalizeTerminalLine(line), promptText)) continue;
    if (!line && block.length === 0) continue;
    block.push(line);
  }

  while (block[0]?.trim() === "") block.shift();
  while (block.at(-1)?.trim() === "") block.pop();
  return block.join("\n").trim();
}

function extractClaudeAssistantText(text: string, prompt: string) {
  const promptText = prompt.trim();
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\u00a0/g, " ").trimEnd());
  const searchStart = findPromptEchoIndex("claude", lines, promptText) + 1;

  const candidates: string[][] = [];
  let block: string[] | null = null;

  function pushBlock() {
    if (!block) return;
    while (block[0]?.trim() === "") block.shift();
    while (block.at(-1)?.trim() === "") block.pop();
    if (block.length) candidates.push(block);
    block = null;
  }

  for (const rawLine of lines.slice(searchStart)) {
    const hasAssistantMarker = /^\s*●/.test(rawLine);
    const line = stripClaudeAssistantChrome(rawLine);
    const normalizedRaw = normalizeTerminalLine(rawLine);
    const normalizedLine = normalizeTerminalLine(line);

    if (hasAssistantMarker) {
      pushBlock();
      if (!normalizedLine) {
        block = [];
        continue;
      }
      if (isClaudeTuiLine(normalizedLine, promptText) || isClaudeThinkingLine(normalizedLine)) {
        block = null;
        continue;
      }
      block = [line];
      continue;
    }

    if (isClaudeConversationBoundary(normalizedRaw, promptText)) {
      pushBlock();
      continue;
    }

    if (
      isClaudeTuiLine(normalizedRaw, promptText) ||
      isClaudeTuiLine(normalizedLine, promptText) ||
      isClaudeThinkingLine(normalizedRaw) ||
      isClaudeThinkingLine(normalizedLine)
    ) {
      continue;
    }

    if (!block) continue;
    if (!line && block.length === 0) continue;
    block.push(line);
  }

  pushBlock();

  const usable = candidates.filter((candidate) => {
    const text = candidate.join("\n").trim();
    return text && !isClaudeThinkingLine(text) && !candidate.every((line) => isClaudeTuiLine(normalizeTerminalLine(line), promptText));
  });

  return usable.at(-1)?.join("\n").trim() ?? "";
}

function findPromptEchoIndex(runtime: AgentRuntime, lines: string[], promptText: string) {
  if (!promptText) return -1;
  const marker = runtime === "codex" ? "›" : "❯";

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeTerminalLine(lines[index]);
    if (!normalized.includes(promptText)) continue;
    if (normalized.startsWith(marker) || normalized.includes(`${marker} ${promptText}`) || normalized.endsWith(promptText)) {
      return index;
    }
  }

  return -1;
}

function normalizeTerminalLine(line: string) {
  return line.replace(/\s+/g, " ").trim();
}

function normalizeMessageContent(content: string) {
  return content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .map((line) => stripTrailingTerminalArtifacts(line))
    .filter((line) => !isResidualTuiLine(normalizeTerminalLine(line)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isAgentReadyForInput(runtime: AgentRuntime, screenText: string, rawText: string) {
  return isAgentReadyText(runtime, screenText) || isAgentReadyText(runtime, rawText);
}

function isAgentReadyAfterPrompt(runtime: AgentRuntime, prompt: string, screenText: string, rawText: string) {
  return isAgentReadyAfterPromptText(runtime, prompt, screenText) || isAgentReadyAfterPromptText(runtime, prompt, rawText);
}

function isAgentReadyAfterPromptText(runtime: AgentRuntime, prompt: string, text: string) {
  const cleanText = sanitizeTerminalText(text);
  const lines = cleanText
    .split("\n")
    .map((line) => normalizeTerminalLine(line))
    .filter(Boolean);
  const promptIndex = findPromptEchoIndex(runtime, lines, prompt.trim());
  if (promptIndex === -1) return false;
  const tail = lines.slice(promptIndex + 1).slice(-8);
  return isReadyTail(runtime, tail);
}

function isAgentReadyText(runtime: AgentRuntime, text: string) {
  const cleanText = sanitizeTerminalText(text);
  const lines = cleanText
    .split("\n")
    .map((line) => normalizeTerminalLine(line))
    .filter(Boolean);
  const assistantIndex = findLastAssistantLineIndex(runtime, lines);
  if (assistantIndex === -1) return false;

  const afterAssistant = lines.slice(assistantIndex + 1);
  const tail = afterAssistant.slice(-8);
  return isReadyTail(runtime, tail);
}

function isReadyTail(runtime: AgentRuntime, tail: string[]) {
  const tailText = tail.join("\n");

  if (runtime === "codex") {
    return (
      tail.some((line) => line.startsWith("›")) ||
      /\bReady\b[\s\S]{0,160}\bContext\s+\d+% left\b/.test(tailText) ||
      /\bReady\b[\s\S]{0,180}\bweekly\s+\d+% left\b/.test(tailText)
    );
  }

  return tail.some((line) => line.startsWith("❯") || line.includes("❯") || /^\? for shortcuts\b/.test(line));
}

function stripTrailingTerminalArtifacts(line: string) {
  return line
    .replace(/([.!?。！？])[\s°º˚]+$/g, "$1")
    .replace(/\b(?:or|and)\s*$/i, (tail, offset, full) => {
      const before = full.slice(0, offset).trimEnd();
      return /[.!?。！？]$/.test(before) ? "" : tail;
    });
}

function findLastAssistantLineIndex(runtime: AgentRuntime, lines: string[]) {
  const marker = runtime === "codex" ? "•" : "●";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith(marker)) continue;
    const candidate =
      runtime === "codex" ? stripCodexAssistantChrome(lines[index]) : stripClaudeAssistantChrome(lines[index]);
    const normalized = normalizeTerminalLine(candidate);
    if (runtime === "codex" && isCodexTuiLine(normalized, "")) continue;
    if (runtime === "claude" && isClaudeTuiLine(normalized, "")) continue;
    return index;
  }
  return -1;
}

function isResidualTuiLine(line: string) {
  if (!line) return false;
  if (line.startsWith("❯") || line.startsWith("›")) return true;
  if (/^\? for shortcuts\b/.test(line)) return true;
  if (/^esc to interrupt$/i.test(line)) return true;
  if (/^Starting MCP servers\b/i.test(line)) return true;
  if (/^\(?\d+s\s*•?\s*esc to interrupt\)?$/i.test(line)) return true;
  if (/^Tip:\s+/i.test(line)) return true;
  if (/^Token usage:/i.test(line)) return true;
  if (/^To continue this session\b/i.test(line)) return true;
  if (/^[✻✶✽✢*·]\s*$/.test(line)) return true;
  if (/^[\s─━_—-]{8,}$/.test(line)) return true;
  if (/^[✻✶✽✢*·]?\s*(?:Crunched|Churned|Sautéed|Sauteed|Unfurling|Ebbing|Cooked|Brewed|Tempering|Brewing|Cogitating)\b/i.test(line)) return true;
  if (/^\(?\d+s\s*·\s*[↓↑]?\s*\d+\s+tokens?\)?$/i.test(line)) return true;
  return false;
}

function stripCodexAssistantChrome(line: string) {
  let value = line.replace(/^\s*•\s?/, "").trimEnd();
  const tailIndex = value.search(/\s*[•◦]\s*(?:q;?\s*)?[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  if (tailIndex >= 0) value = value.slice(0, tailIndex);
  value = stripCodexInlinePromptTail(value);
  return value.trimEnd();
}

function stripCodexInlinePromptTail(value: string) {
  const promptIndex = value.indexOf("›");
  if (promptIndex > 0) value = value.slice(0, promptIndex);

  const statusIndex = value.search(/\b(?:gpt-[\w.-]+|o\d|Context\s+\d+% left|Ready|Working)\b/);
  if (statusIndex > 0) value = value.slice(0, statusIndex);

  return value.replace(/\b(?:or|and)\s*$/i, (tail, offset, full) => {
    const before = full.slice(0, offset).trimEnd();
    return /[.!?。！？]$/.test(before) ? "" : tail;
  });
}

function isCodexConversationBoundary(line: string, promptText: string) {
  if (!line) return false;
  if (line.startsWith("›")) return true;
  if (promptText && (line === promptText || line.endsWith(`› ${promptText}`))) return true;
  return isCodexTuiLine(line, promptText);
}

function isCodexTuiLine(line: string, promptText: string) {
  if (!line) return false;
  if (line.startsWith("[agent-console]")) return true;
  if (line.startsWith("›")) return true;
  if (promptText && line === promptText) return true;
  if (/^Starting MCP servers\b/i.test(line)) return true;
  if (/^\(?\d+s\s*•?\s*esc to interrupt\)?$/i.test(line)) return true;
  if (/^esc to interrupt$/i.test(line)) return true;
  if (/^Tip:\s+/i.test(line)) return true;
  if (/^Token usage:/i.test(line)) return true;
  if (/^To continue this session\b/i.test(line)) return true;
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)) return true;
  if (/\b(?:Working|Ready)\b/.test(line) && /\b(?:Context|left|interrupt|orchestration)\b/.test(line)) return true;
  if (/\bContext\s+\d+% left\b/.test(line)) return true;
  if (/\b(?:gpt-[\w.-]+|o\d)\b/.test(line) && /(?:\/|\\|·)/.test(line) && /\bleft\b/.test(line)) return true;
  return false;
}

function stripClaudeAssistantChrome(line: string) {
  let value = line.replace(/^\s*●\s?/, "").trimEnd();
  const statusIndex = findClaudeStatusIndex(value);
  if (statusIndex > 0) value = value.slice(0, statusIndex);
  return value.trimEnd();
}

function isClaudeConversationBoundary(line: string, promptText: string) {
  if (!line) return false;
  if (line.startsWith("❯")) return true;
  if (promptText && line === promptText) return true;
  return isClaudeTuiLine(line, promptText);
}

function isClaudeTuiLine(line: string, promptText: string) {
  if (!line) return false;
  if (line.startsWith("[agent-console]")) return true;
  if (line.startsWith("❯")) return true;
  if (line.startsWith("⎿")) return true;
  if (promptText && line === promptText) return true;
  if (isClaudeThinkingLine(line)) return true;
  if (/^Tip:\s+/i.test(line)) return true;
  if (/\bTip:\s*\/loop\b/i.test(line)) return true;
  if (/^[A-Za-z]$/.test(line)) return true;
  if (/^\d+$/.test(line)) return true;
  if (/^[✻✶✽✢*·]\s*$/.test(line)) return true;
  if (isClaudeStatusLine(line)) return true;
  if (/^esc to interrupt$/i.test(line)) return true;
  if (/^\? for shortcuts\b/.test(line)) return true;
  if (/^\(?\d+s\s*·\s*[↓↑]?\s*\d+\s+tokens?\)?$/i.test(line)) return true;
  if (/^[✻✶✽✢*·]?\s*\(?\d+s\s*·\s*[↓↑]?\s*\d+\s+tokens?\)?$/i.test(line)) return true;
  return false;
}

function isClaudeThinkingLine(line: string) {
  const normalized = normalizeTerminalLine(line);
  const compact = normalized.replace(/\s+/g, "");
  if (!normalized) return false;
  if (/^Thinkingfor\d+s/i.test(compact)) return true;
  if (/^Thoughtfor\d+s/i.test(compact)) return true;
  if (/^thoughtfor\d+s\)?$/i.test(compact)) return true;
  if (/^\(?\d+s·thinking\)?$/i.test(compact)) return true;
  if (/^\d+thinking$/i.test(compact)) return true;
  if (/^thinking$/i.test(normalized)) return true;
  if (/^[✻✶✽✢*·]?\s*thinking$/i.test(normalized)) return true;
  if (/\bthought for \d+s\b/i.test(normalized)) return true;
  if (/\bThinking for \d+s\b/i.test(normalized)) return true;
  return false;
}

function isClaudeStatusLine(line: string) {
  const normalized = normalizeTerminalLine(line);
  if (findClaudeStatusIndex(normalized) === 0) return true;
  if (/^[✻✶✽✢*·]/.test(normalized) && findClaudeStatusIndex(normalized.replace(/^[✻✶✽✢*·]\s*/, "")) === 0) return true;
  return false;
}

function findClaudeStatusIndex(line: string) {
  return line.search(
    /(?:^|[\s✻✶✽✢*·])(?:Tempering|Brewed|Brewing|Cogitating|Thinking|Thought|Cooked|Ebbing|Unfurling|Sautéed|Sauteed|Crunched|Churned)\b/i,
  );
}

function repairClaudeAnswerText(text: string) {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/([.!?。！？])(?=[A-Z])/g, "$1 ")
        .replace(/HowcanIhelpwiththe/g, "How can I help with the")
        .replace(/HowcanIhelpwith/g, "How can I help with ")
        .replace(/HowcanIhelp/g, "How can I help")
        .replace(/withthe/g, "with the")
        .replace(/theorchestrationproject/g, "the orchestration project")
        .replace(/orchestrationproject/g, "orchestration project")
        .replace(/projecttoday/g, "project today")
        .replace(/\s{2,}/g, " ")
        .trimEnd(),
    )
    .join("\n")
    .trim();
}
