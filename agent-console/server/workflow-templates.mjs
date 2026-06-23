// 流程编排模板：内置角色/流程/提示词模板 + 项目 .acg 读取/校验/合成/快照（PRD §5.2/5.3/5.4/§6/§9）。
// 纯校验/合成函数无 I/O，可单测；loadProjectTemplates 用 node:fs 读 .acg（测试用 temp dir，类比 store）。

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ---- 内容 hash（审计/恢复用，PRD §13）----
export function stableHash(content) {
  return crypto.createHash("sha256").update(String(content ?? ""), "utf8").digest("hex").slice(0, 16);
}

// ---- 服务端权限策略（.acg 不得越权，PRD §9.4）----
export const WORKSPACE_SCOPES = ["repository", "worktree", "read-only"];
// 非法/高风险关键词：出现在角色或流程模板里即拒绝（静默高风险 git / 绕过门槛）。
const FORBIDDEN_WORKFLOW_FLAGS = [
  "forcePush",
  "skipReview",
  "skipGates",
  "skipTests",
  "autoMergeProtected",
  "allowProtectedDirectMerge",
  "cleanWorktreeAuto",
];
// 凭据扫描（PRD §9.4 / §12.7）。
const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:secret|token|password|passwd|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
];

// ---- 内置角色模板（PRD §5.2）----
function role(over) {
  return {
    description: "",
    allowedTools: [],
    permissions: { canWriteCode: false, canRunCommands: false, canCommit: false, workspaceScope: "read-only" },
    defaultRuntime: "codex",
    defaultModel: "gpt-5-codex",
    minInstances: 1,
    maxInstances: 1,
    ...over,
    permissions: { canWriteCode: false, canRunCommands: false, canCommit: false, workspaceScope: "read-only", ...(over.permissions || {}) },
  };
}

export const BUILTIN_ROLES = {
  planner: role({
    id: "planner",
    name: "规划",
    description: "读取目标与仓库上下文，产出结构化子任务、依赖与验收标准。",
    systemPrompt: "你是规划角色。把开发目标拆解为有依赖关系的结构化子任务，每项含目标、范围、禁改、验收标准与建议测试。",
    permissions: { canWriteCode: false, canRunCommands: true, canCommit: false, workspaceScope: "read-only" },
  }),
  developer: role({
    id: "developer",
    name: "开发",
    description: "只实现当前任务，输出变更摘要、修改文件、自测与候选 diff。",
    systemPrompt: "你是开发角色。只处理当前任务范围内的代码，完成后自测并提交结构化阶段结果。",
    permissions: { canWriteCode: true, canRunCommands: true, canCommit: true, workspaceScope: "worktree" },
  }),
  reviewer: role({
    id: "reviewer",
    name: "代码审查",
    description: "审查当前任务 diff、验收标准与测试证据，默认不直接改代码。",
    systemPrompt: "你是 Review 角色。只审查当前任务范围，产出结构化裁决与问题列表，默认不改代码。",
    permissions: { canWriteCode: false, canRunCommands: true, canCommit: false, workspaceScope: "read-only" },
  }),
  tester: role({
    id: "tester",
    name: "测试",
    description: "独立验证验收标准与回归风险，默认不改业务代码。",
    systemPrompt: "你是测试角色。运行允许的测试命令，独立验证验收标准，产出结构化测试结果。",
    permissions: { canWriteCode: false, canRunCommands: true, canCommit: false, workspaceScope: "read-only" },
  }),
  integrator: role({
    id: "integrator",
    name: "集成",
    description: "执行全量测试、问题检查、提交链与漂移检查，生成 PR 或在确认后合并。",
    systemPrompt: "你是集成角色。负责最终集成检查与 PR/合并，遵守服务端门槛，不得绕过未关闭问题或漂移。",
    permissions: { canWriteCode: false, canRunCommands: true, canCommit: true, workspaceScope: "repository" },
  }),
  doc: role({
    id: "doc",
    name: "文档",
    description: "补充与本次变更相关的文档。",
    systemPrompt: "你是文档角色。根据已完成变更补充必要文档，产出文档阶段结果。",
    permissions: { canWriteCode: true, canRunCommands: false, canCommit: true, workspaceScope: "worktree" },
  }),
};

// ---- 内置阶段提示词模板（PRD §5.4，正文由 prompt-builder 填充变量）----
export const BUILTIN_PROMPTS = {
  planning: "依据开发目标与仓库上下文，拆解为有依赖关系的结构化子任务。",
  development: "只实现当前任务，完成后自测并用 acg stage submit --type dev 提交结构化结果。",
  review: "审查当前任务 diff 与验收标准，用 acg stage submit --type review 提交结构化裁决。",
  testing: "运行允许的测试命令验证验收标准，用 acg stage submit --type test 提交结构化测试结果。",
  doc: "补充与本次变更相关的文档，用 acg stage submit --type doc 提交结果。",
  integration: "执行最终集成检查并按集成方式产出 PR 或合并，用 acg stage submit --type integration 提交结果。",
};

// ---- 内置流程模板（PRD §6）----
export const BUILTIN_WORKFLOWS = {
  "lightweight-dev": {
    id: "lightweight-dev",
    name: "轻量开发",
    version: 1,
    description: "规划 → 开发 → Review → 任务提交 → 集成。适合范围清晰、风险较低的任务。",
    planningRoleId: "planner",
    integrationRoleId: "integrator",
    requiredRoles: [{ roleId: "planner" }, { roleId: "developer" }, { roleId: "reviewer" }, { roleId: "integrator" }],
    optionalRoles: [{ roleId: "doc" }],
    taskStages: [
      { id: "development", kind: "development", roleId: "developer" },
      { id: "review", kind: "review", roleId: "reviewer" },
    ],
    settings: { maxReviewRounds: 3, integrationMode: "pull_request" },
  },
  "standard-dev": {
    id: "standard-dev",
    name: "标准开发",
    version: 1,
    description: "规划 → 开发 → Review → 测试 → 任务提交 → 集成。测试角色独立验证验收标准与回归风险。",
    planningRoleId: "planner",
    integrationRoleId: "integrator",
    requiredRoles: [
      { roleId: "planner" },
      { roleId: "developer" },
      { roleId: "reviewer" },
      { roleId: "tester" },
      { roleId: "integrator" },
    ],
    optionalRoles: [{ roleId: "doc" }],
    taskStages: [
      { id: "development", kind: "development", roleId: "developer" },
      { id: "review", kind: "review", roleId: "reviewer" },
      { id: "testing", kind: "testing", roleId: "tester" },
    ],
    settings: { maxReviewRounds: 3, integrationMode: "pull_request" },
  },
};

/** 取内置模板集合的深拷贝（避免调用方污染常量）。 */
export function builtinTemplates() {
  return clone({ roles: BUILTIN_ROLES, workflows: BUILTIN_WORKFLOWS, prompts: BUILTIN_PROMPTS });
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ---- 纯校验 ----

/** 校验角色模板 schema + 权限不越权（PRD §9.4）。 */
export function validateRoleTemplate(role, id) {
  const errors = [];
  const rid = String(role?.id || id || "").trim();
  if (!rid) errors.push("角色模板缺少 id");
  if (!String(role?.name || "").trim()) errors.push(`角色「${rid}」缺少名称`);
  const perm = role?.permissions || {};
  if (perm.workspaceScope && !WORKSPACE_SCOPES.includes(perm.workspaceScope)) {
    errors.push(`角色「${rid}」的 workspaceScope 非法：${perm.workspaceScope}`);
  }
  // 越权：只读角色不得 canCommit / canWriteCode。
  if (perm.workspaceScope === "read-only" && (perm.canCommit || perm.canWriteCode)) {
    errors.push(`角色「${rid}」为只读范围却申请写/提交权限，超出策略允许`);
  }
  for (const key of Object.keys(perm)) {
    if (!["canWriteCode", "canRunCommands", "canCommit", "workspaceScope"].includes(key)) {
      errors.push(`角色「${rid}」包含未知权限字段：${key}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 校验流程模板（PRD §9.3）：
 * 每阶段有可用执行角色、至少一条合法完成路径、无无退出条件自动循环、
 * 移除可选角色后无不可达阶段、高风险动作不得静默自动。
 */
export function validateWorkflowTemplate(wf, roles) {
  const errors = [];
  const roleMap = roles || {};
  if (!String(wf?.id || "").trim()) errors.push("流程模板缺少 id");

  // 高风险/绕过门槛标记拒绝。
  for (const flag of FORBIDDEN_WORKFLOW_FLAGS) {
    if (truthyDeep(wf, flag)) {
      errors.push(`流程模板包含被禁止的高风险/绕过门槛配置：${flag}`);
    }
  }

  const stages = Array.isArray(wf?.taskStages) ? wf.taskStages : [];
  if (stages.length === 0) errors.push("流程模板至少需要一个任务阶段");

  // 每阶段有可用角色。
  for (const s of stages) {
    if (!roleMap[s.roleId]) errors.push(`阶段「${s.id || s.kind}」缺少可用执行角色：${s.roleId}`);
    if (s.gate === false && (s.kind === "review" || s.kind === "testing")) {
      errors.push(`阶段「${s.id || s.kind}」不得关闭门槛（绕过 Review/测试）`);
    }
  }

  // 必须有开发阶段作为门槛失败的回退落点，否则门槛失败将无退出条件（死循环）。
  const hasDev = stages.some((s) => s.kind === "development");
  const hasGate = stages.some((s) => s.kind === "review" || s.kind === "testing");
  if (hasGate && !hasDev) {
    errors.push("存在门槛阶段但缺少开发阶段作为回退落点，可能形成无退出条件的自动循环");
  }

  // 重试上限必须有限正整数（否则 fixing 循环无退出）。
  const cap = Number(wf?.settings?.maxReviewRounds);
  if (!(cap > 0) || !Number.isFinite(cap)) {
    errors.push("settings.maxReviewRounds 必须为正整数，避免无退出条件的自动循环");
  }

  // 规划/集成角色可用。
  if (wf?.planningRoleId && !roleMap[wf.planningRoleId]) errors.push(`规划角色不可用：${wf.planningRoleId}`);
  if (wf?.integrationRoleId && !roleMap[wf.integrationRoleId]) errors.push(`集成角色不可用：${wf.integrationRoleId}`);

  const mode = wf?.settings?.integrationMode;
  if (mode && !["pull_request", "direct_merge"].includes(mode)) {
    errors.push(`集成方式非法：${mode}`);
  }

  return { ok: errors.length === 0, errors };
}

function truthyDeep(obj, key) {
  if (!obj || typeof obj !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key]) return true;
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && truthyDeep(v, key)) return true;
  }
  return false;
}

/** 扫描明显凭据；命中返回首个匹配模式描述。 */
export function scanForSecrets(text) {
  const s = String(text || "");
  for (const re of SECRET_PATTERNS) {
    if (re.test(s)) return { found: true, pattern: re.source };
  }
  return { found: false };
}

// ---- 运行时参数覆盖（启动页微调，PRD §9.2）----
/**
 * 把启动页/项目参数应用到流程模板，生成本次运行用的流程定义（不写回 .acg）。
 * 支持：maxReviewRounds、integrationMode、enableTesting、enableDoc。
 */
export function applyWorkflowOverrides(workflow, overrides = {}) {
  const wf = clone(workflow);
  wf.settings = wf.settings || {};
  if (overrides.maxReviewRounds != null && Number(overrides.maxReviewRounds) > 0) {
    wf.settings.maxReviewRounds = Number(overrides.maxReviewRounds);
  }
  if (overrides.integrationMode) {
    wf.settings.integrationMode = overrides.integrationMode;
  }
  let stages = Array.isArray(wf.taskStages) ? [...wf.taskStages] : [];
  if (overrides.enableTesting === false) {
    stages = stages.filter((s) => s.kind !== "testing");
  }
  if (overrides.enableTesting === true && !stages.some((s) => s.kind === "testing")) {
    const reviewIdx = stages.findIndex((s) => s.kind === "review");
    const testStage = { id: "testing", kind: "testing", roleId: "tester" };
    stages.splice(reviewIdx >= 0 ? reviewIdx + 1 : stages.length, 0, testStage);
  }
  if (overrides.enableDoc === true && !stages.some((s) => s.kind === "doc")) {
    stages.push({ id: "doc", kind: "doc", roleId: "doc" });
  }
  if (overrides.enableDoc === false) {
    stages = stages.filter((s) => s.kind !== "doc");
  }
  wf.taskStages = stages;
  return wf;
}

// ---- 合成与快照（PRD §9.4）----

/**
 * 按优先级合成模板：内置 < 项目 .acg < 本次修改（overrides）。
 * 同 id 覆盖。返回 { roles, workflows, prompts, sources }，sources 记录每个 id 的最终来源。
 */
export function resolveTemplates({ builtin, project, overrides } = {}) {
  const layers = [
    { tag: "内置", data: builtin || {} },
    { tag: "项目 .acg", data: project || {} },
    { tag: "本次修改", data: overrides || {} },
  ];
  const roles = {};
  const workflows = {};
  const prompts = {};
  const sources = {};
  for (const { tag, data } of layers) {
    for (const [id, r] of Object.entries(data.roles || {})) {
      roles[id] = r;
      sources[`role:${id}`] = { kind: "role", id, source: tag, relativePath: r.__relativePath || null, version: r.version || 1 };
    }
    for (const [id, w] of Object.entries(data.workflows || {})) {
      workflows[id] = w;
      sources[`workflow:${id}`] = { kind: "workflow", id, source: tag, relativePath: w.__relativePath || null, version: w.version || 1 };
    }
    for (const [id, p] of Object.entries(data.prompts || {})) {
      prompts[id] = p;
      sources[`prompt:${id}`] = { kind: "prompt", id, source: tag, relativePath: (p && p.__relativePath) || null, version: 1 };
    }
  }
  return { roles, workflows, prompts, sources };
}

/**
 * 为某个流程构建不可变运行快照：包含选定 workflow（已应用覆盖）、其用到的角色、提示词，
 * 以及来源/相对路径/版本/内容 hash（审计与恢复，PRD §9.4 / §13）。
 */
export function snapshotTemplates({ resolved, workflowId, overrides }) {
  const baseWorkflow = resolved.workflows[workflowId];
  if (!baseWorkflow) {
    const err = new Error(`流程模板不存在：${workflowId}`);
    err.code = "not_found";
    throw err;
  }
  const workflow = applyWorkflowOverrides(baseWorkflow, overrides || {});

  // 收集 workflow 实际用到的角色 id。
  const roleIds = new Set();
  for (const s of workflow.taskStages || []) roleIds.add(s.roleId);
  if (workflow.planningRoleId) roleIds.add(workflow.planningRoleId);
  if (workflow.integrationRoleId) roleIds.add(workflow.integrationRoleId);

  const roles = {};
  for (const id of roleIds) {
    if (resolved.roles[id]) roles[id] = clone(resolved.roles[id]);
  }
  const prompts = clone(resolved.prompts);

  const sources = [];
  const pushSource = (kind, id, content) => {
    const meta = resolved.sources[`${kind}:${id}`] || { source: "内置", relativePath: null, version: 1 };
    sources.push({
      kind,
      id,
      source: meta.source,
      relativePath: meta.relativePath || null,
      version: meta.version || 1,
      contentHash: stableHash(content),
    });
  };
  pushSource("workflow", workflowId, JSON.stringify(baseWorkflow));
  for (const id of Object.keys(roles)) pushSource("role", id, JSON.stringify(resolved.roles[id]));
  for (const id of Object.keys(prompts)) pushSource("prompt", id, JSON.stringify(prompts[id]));

  // 冻结（不可变快照）。
  const snapshot = { workflow, roles, prompts, sources, overrides: overrides || {} };
  return deepFreeze(snapshot);
}

function deepFreeze(obj) {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

// ---- 项目 .acg 读取（I/O，PRD §9.4）----

/**
 * 读取目标仓库 .acg 目录下的角色/流程/提示词模板，逐文件做安全与 schema 校验。
 * 任一文件不合法 → 收集到 errors，不纳入结果（启动页可展示并要求处理）。
 * @returns {Promise<{ roles, workflows, prompts, sources, errors }>}
 */
export async function loadProjectTemplates(repoPath) {
  const result = { roles: {}, workflows: {}, prompts: {}, sources: {}, errors: [] };
  if (!repoPath) return result;
  const acgRoot = path.resolve(repoPath, ".acg");

  // 路径穿越守卫：解析后路径必须落在 .acg 内。
  const within = (p) => {
    const resolved = path.resolve(acgRoot, p);
    const rel = path.relative(acgRoot, resolved);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  };

  const readDir = async (sub) => {
    try {
      return await fs.readdir(path.join(acgRoot, sub));
    } catch {
      return [];
    }
  };

  // roles/*.json
  for (const f of await readDir("roles")) {
    if (!f.endsWith(".json")) continue;
    const rel = path.join(".acg", "roles", f);
    if (!within(path.join("roles", f))) {
      result.errors.push(`拒绝越界文件路径：${rel}`);
      continue;
    }
    try {
      const raw = await fs.readFile(path.join(acgRoot, "roles", f), "utf8");
      const secret = scanForSecrets(raw);
      if (secret.found) {
        result.errors.push(`${rel} 含疑似凭据，已拒绝（请移除后重试）`);
        continue;
      }
      const role = JSON.parse(raw);
      const id = role.id || f.replace(/\.json$/, "");
      const check = validateRoleTemplate(role, id);
      if (!check.ok) {
        result.errors.push(`${rel}：${check.errors.join("；")}`);
        continue;
      }
      role.__relativePath = rel;
      result.roles[id] = role;
    } catch (err) {
      result.errors.push(`${rel} 解析失败：${err.message}`);
    }
  }

  // workflows/*.json
  for (const f of await readDir("workflows")) {
    if (!f.endsWith(".json")) continue;
    const rel = path.join(".acg", "workflows", f);
    if (!within(path.join("workflows", f))) {
      result.errors.push(`拒绝越界文件路径：${rel}`);
      continue;
    }
    try {
      const raw = await fs.readFile(path.join(acgRoot, "workflows", f), "utf8");
      const secret = scanForSecrets(raw);
      if (secret.found) {
        result.errors.push(`${rel} 含疑似凭据，已拒绝`);
        continue;
      }
      const wf = JSON.parse(raw);
      wf.__relativePath = rel;
      result.workflows[wf.id || f.replace(/\.json$/, "")] = wf;
    } catch (err) {
      result.errors.push(`${rel} 解析失败：${err.message}`);
    }
  }

  // prompts/*.md
  for (const f of await readDir("prompts")) {
    if (!f.endsWith(".md")) continue;
    const rel = path.join(".acg", "prompts", f);
    if (!within(path.join("prompts", f))) {
      result.errors.push(`拒绝越界文件路径：${rel}`);
      continue;
    }
    try {
      const raw = await fs.readFile(path.join(acgRoot, "prompts", f), "utf8");
      const secret = scanForSecrets(raw);
      if (secret.found) {
        result.errors.push(`${rel} 含疑似凭据，已拒绝`);
        continue;
      }
      const kind = f.replace(/\.md$/, "");
      const value = new String(raw); // 携带 __relativePath
      value.__relativePath = rel;
      result.prompts[kind] = value.toString();
      result.sources[`prompt:${kind}`] = { kind: "prompt", id: kind, source: "项目 .acg", relativePath: rel, version: 1 };
    } catch (err) {
      result.errors.push(`${rel} 解析失败：${err.message}`);
    }
  }

  return result;
}

/**
 * 校验项目层 + 内置合成后的某流程是否整体合法（含 .acg workflow 的流程校验）。
 * 用于创建运行前的最终把关。
 */
export function validateResolvedWorkflow(resolved, workflowId) {
  const wf = resolved.workflows[workflowId];
  if (!wf) return { ok: false, errors: [`流程模板不存在：${workflowId}`] };
  const roleErrors = [];
  for (const [id, r] of Object.entries(resolved.roles)) {
    const c = validateRoleTemplate(r, id);
    if (!c.ok) roleErrors.push(...c.errors);
  }
  const wfCheck = validateWorkflowTemplate(wf, resolved.roles);
  const errors = [...roleErrors, ...wfCheck.errors];
  return { ok: errors.length === 0, errors };
}
