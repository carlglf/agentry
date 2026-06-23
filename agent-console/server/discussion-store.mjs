// 讨论组数据持久化（决策9：server 落盘 JSON）。
// 单文件 .data/discussions.json；原子写（写 tmp + rename）+ 单写入队列，避免并发写损坏。

import fs from "node:fs/promises";
import path from "node:path";
import { validateGroup, findHost, nextSeq, deriveRevisionNo } from "./discussion-engine.mjs";

const STORE_VERSION = 1;

function uid(prefix) {
  // 不依赖 crypto.randomUUID 的可读 id；纳秒 + 随机后缀，单进程内足够唯一。
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

function nowIso() {
  return new Date().toISOString();
}

function emptyState() {
  return { version: STORE_VERSION, groups: [], members: [], sessions: [], messages: [] };
}

export function createStore({ dataDir }) {
  const dir = dataDir;
  const file = path.join(dir, "discussions.json");
  let state = emptyState();
  let loaded = false;

  // 单写入队列：所有 save 串行，避免并发 rename 交错。
  let writeChain = Promise.resolve();

  async function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    writeChain = writeChain.then(async () => {
      await fs.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.discussions.${process.pid}.${Date.now()}.tmp`);
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
        groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        members: Array.isArray(parsed.members) ? parsed.members : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      };
    } catch {
      state = emptyState();
    }
    loaded = true;
    return state;
  }

  function ensureLoaded() {
    if (!loaded) throw new Error("discussion store not loaded; call load() first");
  }

  // ---- Groups（可复用模板）----

  function membersOf(groupId) {
    return state.members.filter((m) => m.groupId === groupId);
  }

  function listGroups(projectId) {
    ensureLoaded();
    return state.groups
      .filter((g) => !projectId || g.projectId === projectId)
      .map((g) => ({ ...g, members: membersOf(g.id) }));
  }

  function getGroup(groupId) {
    ensureLoaded();
    const g = state.groups.find((x) => x.id === groupId);
    return g ? { ...g, members: membersOf(g.id) } : null;
  }

  async function createGroup({ projectId, name, rule, members }) {
    ensureLoaded();
    const incoming = (Array.isArray(members) ? members : []).map((m) => ({
      id: m.id || uid("dmem"),
      name: String(m.name || "").trim(),
      runtime: m.runtime,
      model: m.model,
      persona: m.persona || "",
      duty: m.duty || "",
      isHost: !!m.isHost,
    }));
    const check = validateGroup({ name }, incoming);
    if (!check.ok) {
      const err = new Error(check.errors.join("；"));
      err.code = "validation";
      err.errors = check.errors;
      throw err;
    }
    const ts = nowIso();
    const group = {
      id: uid("dgrp"),
      projectId,
      name: String(name).trim(),
      rule: rule || "",
      createdAt: ts,
      updatedAt: ts,
    };
    state.groups.push(group);
    for (const m of incoming) {
      state.members.push({ ...m, groupId: group.id });
    }
    await persist();
    return getGroup(group.id);
  }

  async function updateGroup(groupId, { name, rule, members }) {
    ensureLoaded();
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) {
      const err = new Error("讨论组不存在");
      err.code = "not_found";
      throw err;
    }
    const nextMembers =
      members === undefined
        ? membersOf(groupId)
        : members.map((m) => ({
            id: m.id || uid("dmem"),
            groupId,
            name: String(m.name || "").trim(),
            runtime: m.runtime,
            model: m.model,
            persona: m.persona || "",
            duty: m.duty || "",
            isHost: !!m.isHost,
          }));
    const nextName = name === undefined ? group.name : String(name).trim();
    const check = validateGroup({ name: nextName }, nextMembers);
    if (!check.ok) {
      const err = new Error(check.errors.join("；"));
      err.code = "validation";
      err.errors = check.errors;
      throw err;
    }
    group.name = nextName;
    if (rule !== undefined) group.rule = rule;
    group.updatedAt = nowIso();
    if (members !== undefined) {
      state.members = state.members.filter((m) => m.groupId !== groupId).concat(nextMembers);
    }
    await persist();
    return getGroup(groupId);
  }

  async function deleteGroup(groupId) {
    ensureLoaded();
    state.groups = state.groups.filter((g) => g.id !== groupId);
    state.members = state.members.filter((m) => m.groupId !== groupId);
    const sessionIds = state.sessions.filter((s) => s.groupId === groupId).map((s) => s.id);
    state.sessions = state.sessions.filter((s) => s.groupId !== groupId);
    state.messages = state.messages.filter((m) => !sessionIds.includes(m.sessionId));
    await persist();
  }

  // ---- Sessions（一次话题讨论）----

  async function createSession({ groupId, topic, maxRounds }) {
    ensureLoaded();
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) {
      const err = new Error("讨论组不存在");
      err.code = "not_found";
      throw err;
    }
    const host = findHost(membersOf(groupId));
    if (!host) {
      const err = new Error("讨论组缺少主理人");
      err.code = "validation";
      throw err;
    }
    const ts = nowIso();
    const session = {
      id: uid("dses"),
      groupId,
      topic: String(topic || "").trim(),
      status: "idle",
      maxRounds: Number(maxRounds) > 0 ? Number(maxRounds) : 20,
      currentMemberId: host.id,
      round: 0,
      createdAt: ts,
      updatedAt: ts,
    };
    state.sessions.push(session);
    await persist();
    return { ...session };
  }

  function getSession(sessionId) {
    ensureLoaded();
    const s = state.sessions.find((x) => x.id === sessionId);
    return s ? { ...s } : null;
  }

  function listSessions(groupId) {
    ensureLoaded();
    return state.sessions.filter((s) => s.groupId === groupId).map((s) => ({ ...s }));
  }

  async function updateSession(sessionId, patch) {
    ensureLoaded();
    const s = state.sessions.find((x) => x.id === sessionId);
    if (!s) {
      const err = new Error("话题讨论不存在");
      err.code = "not_found";
      throw err;
    }
    Object.assign(s, patch, { updatedAt: nowIso() });
    await persist();
    return { ...s };
  }

  // ---- Messages ----

  function listMessages(sessionId) {
    ensureLoaded();
    return state.messages
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq)
      .map((m) => ({ ...m }));
  }

  async function appendMessage({ sessionId, memberId, content, type }) {
    ensureLoaded();
    const seq = nextSeq(state.messages.filter((m) => m.sessionId === sessionId));
    const message = {
      id: uid("dmsg"),
      sessionId,
      memberId: memberId ?? null,
      type: type || "member_message",
      seq,
      content: String(content || ""),
      createdAt: nowIso(),
    };
    state.messages.push(message);
    await persist();
    return { ...message };
  }

  /**
   * 原子创建「用户反馈驱动」的派生 session（§9.3）。
   * 在首个 await 之前同步完成「校验无 existing child + push 派生 session + push user_feedback」，
   * 再 persist 一次落盘——单线程下即原子，避免「有 session 无反馈」或「有反馈未启动」的半成功状态。
   */
  async function createRevisionSession({ parentSessionId, feedback, mode, previousConclusionSnapshot }) {
    ensureLoaded();
    const parent = state.sessions.find((s) => s.id === parentSessionId);
    if (!parent) {
      const err = new Error("父话题讨论不存在");
      err.code = "not_found";
      throw err;
    }
    if (state.sessions.some((s) => s.parentSessionId === parentSessionId)) {
      const err = new Error("该轮讨论已派生过新一轮，只能从最新一轮继续");
      err.code = "already_revised";
      throw err;
    }
    const host = findHost(membersOf(parent.groupId));
    if (!host) {
      const err = new Error("讨论组缺少主理人");
      err.code = "validation";
      throw err;
    }
    const ts = nowIso();
    const session = {
      id: uid("dses"),
      groupId: parent.groupId,
      topic: parent.topic,
      status: "idle",
      maxRounds: Number(parent.maxRounds) > 0 ? Number(parent.maxRounds) : 20,
      currentMemberId: host.id,
      round: 0,
      parentSessionId,
      revisionNo: deriveRevisionNo(parent),
      reopenMode: mode === "restart" ? "restart" : "revise",
      previousConclusionSnapshot: String(previousConclusionSnapshot || ""),
      createdAt: ts,
      updatedAt: ts,
    };
    const feedbackMessage = {
      id: uid("dmsg"),
      sessionId: session.id,
      memberId: null,
      type: "user_feedback",
      seq: 1,
      content: String(feedback || ""),
      createdAt: ts,
    };
    session.userFeedbackMessageId = feedbackMessage.id;
    state.sessions.push(session);
    state.messages.push(feedbackMessage);
    await persist();
    return { session: { ...session }, feedbackMessage: { ...feedbackMessage } };
  }

  return {
    load,
    // groups
    listGroups,
    getGroup,
    createGroup,
    updateGroup,
    deleteGroup,
    // sessions
    createSession,
    createRevisionSession,
    getSession,
    listSessions,
    updateSession,
    // messages
    listMessages,
    appendMessage,
    // 测试/调试用
    _raw: () => state,
  };
}
