// 自定义运行方式模板持久化：用户在“新建自动开发运行”页以内置流程为模板复制再改后另存为可复用模板。
// 单文件 .data/workflow-templates.json；原子写（写 tmp + rename）+ 单写入队列，避免并发写损坏。
// 与 discussion-store 同构。纯存储无校验/合成逻辑——校验在 workflow-routes 调 workflow-templates 完成。

import fs from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;

function uid(prefix) {
  // 不依赖 crypto.randomUUID 的可读 id；时间戳 + 随机后缀，单进程内足够唯一。
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

function nowIso() {
  return new Date().toISOString();
}

function emptyState() {
  return { version: STORE_VERSION, templates: [] };
}

export function createTemplateStore({ dataDir }) {
  const dir = dataDir;
  const file = path.join(dir, "workflow-templates.json");
  let state = emptyState();
  let loaded = false;

  // 单写入队列：所有 save 串行，避免并发 rename 交错。
  let writeChain = Promise.resolve();

  async function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    writeChain = writeChain.then(async () => {
      await fs.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.workflow-templates.${process.pid}.${Date.now()}.tmp`);
      await fs.writeFile(tmp, snapshot, "utf8");
      await fs.rename(tmp, file);
    });
    return writeChain;
  }

  async function load() {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      state = {
        version: parsed.version || STORE_VERSION,
        templates: Array.isArray(parsed.templates) ? parsed.templates : [],
      };
    } catch {
      state = emptyState();
    }
    loaded = true;
    return state;
  }

  function ensureLoaded() {
    if (!loaded) throw new Error("workflow template store not loaded; call load() first");
  }

  /** 列出所有自定义模板（深拷贝，避免调用方污染内部状态）。 */
  function list() {
    ensureLoaded();
    return state.templates.map((t) => clone(t));
  }

  function get(id) {
    ensureLoaded();
    const t = state.templates.find((x) => x.id === id);
    return t ? clone(t) : null;
  }

  /**
   * 保存一个自定义运行方式模板。入参为已成型的流程定义片段：
   * { name, description, baseWorkflowId, planningRoleId, integrationRoleId, taskStages, settings, roleBindings }
   * 自动补 id（custom_*）、version、createdAt。返回保存后的模板。
   */
  async function create(input) {
    ensureLoaded();
    const id = input.id && String(input.id).trim() ? String(input.id).trim() : uid("custom");
    const tpl = {
      id,
      name: String(input.name || "").trim() || "自定义运行方式",
      description: String(input.description || "").trim(),
      version: 1,
      baseWorkflowId: input.baseWorkflowId || null,
      planningRoleId: input.planningRoleId || null,
      integrationRoleId: input.integrationRoleId || null,
      taskStages: Array.isArray(input.taskStages) ? clone(input.taskStages) : [],
      settings: clone(input.settings || {}),
      roleBindings: clone(input.roleBindings || {}),
      // 自定义角色定义（按阶段种类合成、权限锁定）与自定义阶段提示词（含 planning 任务拆分提示词）。
      roles: clone(input.roles || {}),
      prompts: clone(input.prompts || {}),
      requiredRoles: Array.isArray(input.requiredRoles) ? clone(input.requiredRoles) : undefined,
      optionalRoles: Array.isArray(input.optionalRoles) ? clone(input.optionalRoles) : undefined,
      createdAt: nowIso(),
    };
    // 同 id 视为覆盖更新。
    const idx = state.templates.findIndex((x) => x.id === id);
    if (idx >= 0) {
      tpl.createdAt = state.templates[idx].createdAt || tpl.createdAt;
      state.templates[idx] = tpl;
    } else {
      state.templates.push(tpl);
    }
    await persist();
    return clone(tpl);
  }

  async function remove(id) {
    ensureLoaded();
    const before = state.templates.length;
    state.templates = state.templates.filter((x) => x.id !== id);
    const removed = state.templates.length < before;
    if (removed) await persist();
    return removed;
  }

  return { load, list, get, create, remove };
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
