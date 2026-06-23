// 讨论组 REST 路由：把纯逻辑（engine/prompt）、持久化（store）、PTY（ptyMgr）粘起来。
// 设计成 handleDiscussionApi(req, res, ctx) → 命中返回 true，未命中返回 false（交回 server.mjs 的 404）。

import process from "node:process";
import {
  validateSay,
  validateEnd,
  validateRevision,
  computeDelta,
  reduceSay,
  reduceEnd,
  findHost,
  normalizeContent,
} from "./discussion-engine.mjs";
import {
  buildOpeningPrompt,
  buildIncrementalPrompt,
  buildRevisionOpeningPrompt,
  buildRecapPrompt,
} from "./prompt-builder.mjs";

function memberEnv(ctx, session, member) {
  return {
    AGENT_CONSOLE: "1",
    AGENT_CONSOLE_YOLO: "1",
    AGENT_CONSOLE_SESSION_ID: session.id,
    AGENT_CONSOLE_GROUP_ID: session.groupId,
    AGENT_CONSOLE_MEMBER_ID: member.id,
    AGENT_CONSOLE_API: `http://${ctx.host}:${ctx.port}`,
  };
}

function nameMap(members) {
  const map = {};
  for (const m of members) map[m.id] = m.name;
  return map;
}

/**
 * @param {object} ctx { store, ptyMgr, runtimeMeta, host, port, readJson, sendJson }
 * @returns {Promise<boolean>} 是否命中讨论组路由
 */
export async function handleDiscussionApi(req, res, ctx) {
  const { store, ptyMgr, readJson, sendJson } = ctx;
  const url = new URL(req.url || "/", `http://${req.headers?.host || "local"}`);
  const p = url.pathname;
  const method = req.method;

  // ---- Groups ----
  if (p === "/api/groups" && method === "GET") {
    const projectId = url.searchParams.get("projectId") || "";
    sendJson(res, 200, { groups: store.listGroups(projectId) });
    return true;
  }

  if (p === "/api/groups" && method === "POST") {
    const body = await readJson(req);
    try {
      const group = await store.createGroup(body);
      sendJson(res, 201, { group });
    } catch (err) {
      sendJson(res, err.code === "validation" ? 400 : 500, {
        error: err.message,
        errors: err.errors,
      });
    }
    return true;
  }

  let m = p.match(/^\/api\/groups\/([^/]+)$/);
  if (m && method === "PUT") {
    const groupId = decodeURIComponent(m[1]);
    const body = await readJson(req);
    try {
      const group = await store.updateGroup(groupId, body);
      sendJson(res, 200, { group });
    } catch (err) {
      const status = err.code === "validation" ? 400 : err.code === "not_found" ? 404 : 500;
      sendJson(res, status, { error: err.message, errors: err.errors });
    }
    return true;
  }
  if (m && method === "DELETE") {
    const groupId = decodeURIComponent(m[1]);
    await store.deleteGroup(groupId);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ---- Sessions under a group ----
  m = p.match(/^\/api\/groups\/([^/]+)\/sessions$/);
  if (m && method === "POST") {
    const groupId = decodeURIComponent(m[1]);
    const body = await readJson(req);
    try {
      const session = await store.createSession({ groupId, ...body });
      sendJson(res, 201, { session });
    } catch (err) {
      const status = err.code === "not_found" ? 404 : err.code === "validation" ? 400 : 500;
      sendJson(res, status, { error: err.message });
    }
    return true;
  }
  if (m && method === "GET") {
    const groupId = decodeURIComponent(m[1]);
    sendJson(res, 200, { sessions: store.listSessions(groupId) });
    return true;
  }

  // ---- Single session read ----
  m = p.match(/^\/api\/sessions\/([^/]+)$/);
  if (m && method === "GET") {
    const sessionId = decodeURIComponent(m[1]);
    const session = store.getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "话题讨论不存在" });
      return true;
    }
    const group = store.getGroup(session.groupId);
    sendJson(res, 200, {
      session,
      members: group ? group.members : [],
      messages: store.listMessages(sessionId),
    });
    return true;
  }

  // ---- Start ----
  m = p.match(/^\/api\/sessions\/([^/]+)\/start$/);
  if (m && method === "POST") {
    const sessionId = decodeURIComponent(m[1]);
    const body = await readJson(req);
    const session = store.getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "话题讨论不存在" });
      return true;
    }
    const group = store.getGroup(session.groupId);
    const members = group ? group.members : [];
    const host = findHost(members);
    if (!host) {
      sendJson(res, 400, { error: "讨论组缺少主理人" });
      return true;
    }
    const cwd = body.cwd || process.cwd();
    for (const member of members) {
      ptyMgr.ensureMember({
        sessionId,
        member,
        cwd,
        cols: body.cols,
        rows: body.rows,
        env: memberEnv(ctx, session, member),
      });
    }
    const updated = await store.updateSession(sessionId, {
      status: "running",
      round: 0,
      currentMemberId: host.id,
    });
    const opening = buildOpeningPrompt({ topic: session.topic, member: host, rule: group.rule });
    const hostKey = ptyMgr.memberKey(sessionId, host.id);
    // 等待主理人 TUI 就绪再注入开场——刚 spawn 的 codex/claude 还没准备好接收输入，
    // 立即注入会被吞掉，导致「启动话题后主理人不自动开场」。
    const ready = ptyMgr.waitForReady
      ? await ptyMgr.waitForReady(hostKey, host.runtime)
      : true;
    const delivered = await ptyMgr.typeInto(hostKey, opening, host.runtime);
    sendJson(res, 200, { session: updated, delivered, ready });
    return true;
  }

  // ---- Say ----
  m = p.match(/^\/api\/sessions\/([^/]+)\/members\/([^/]+)\/say$/);
  if (m && method === "POST") {
    const sessionId = decodeURIComponent(m[1]);
    const memberId = decodeURIComponent(m[2]);
    const body = await readJson(req);
    const session = store.getSession(sessionId);
    const group = session ? store.getGroup(session.groupId) : null;
    const members = group ? group.members : [];

    const check = validateSay({ session, members, memberId, next: body.next });
    if (!check.ok) {
      sendJson(res, 409, { error: check.error, code: check.code });
      return true;
    }

    await store.appendMessage({ sessionId, memberId, content: normalizeContent(body.content) });
    const result = reduceSay(session, { nextMemberId: check.nextMemberId }, session.maxRounds);

    if (result.ended) {
      const updated = await store.updateSession(sessionId, {
        round: result.session.round,
        currentMemberId: result.session.currentMemberId,
        status: result.session.status,
      });
      sendJson(res, 200, {
        ok: true,
        ended: true,
        reason: result.reason,
        session: updated,
        message: "已达到最大轮次，讨论自动结束。",
      });
      return true;
    }

    // 丢轮防护（§3.2）：先尝试把增量送达下一位，确认成功后再推进发言权。
    // 若目标 PTY 已关闭/崩溃（typeInto 返回 false），不要把 currentMemberId 推进到一个
    // 收不到 prompt 的成员，否则会话会卡在 running 却无人能继续。保持发言权在当前发言人手里。
    const nextMember = members.find((x) => x.id === check.nextMemberId);
    const delta = computeDelta(store.listMessages(sessionId), check.nextMemberId);
    const prompt = buildIncrementalPrompt({
      topic: session.topic,
      member: nextMember,
      deltaMessages: delta,
      memberNameById: nameMap(members),
    });
    const nextKey = ptyMgr.memberKey(sessionId, check.nextMemberId);
    // 与开场一致：注入前先等下一位 TUI 就绪，否则提示词会被未就绪的 TUI 吞掉/无法提交
    // （只有主理人开场走了 waitForReady，交接漏了，导致交接消息进了输入框却没发出去）。
    if (ptyMgr.waitForReady) await ptyMgr.waitForReady(nextKey, nextMember.runtime);
    const delivered = await ptyMgr.typeInto(nextKey, prompt, nextMember.runtime);

    if (!delivered) {
      // 仅记录本轮发言（round 已自增），发言权仍留在当前发言人，状态保持 running。
      const updated = await store.updateSession(sessionId, {
        round: result.session.round,
        currentMemberId: memberId,
        status: "running",
      });
      sendJson(res, 200, {
        ok: true,
        ended: false,
        delivered: false,
        handoff: false,
        session: updated,
        warning: `未能把发言权送达 ${nextMember.name}（其会话可能已关闭）。发言权仍在你这里，请先重开该成员会话后重试，或改提名其他在线成员。`,
      });
      return true;
    }

    const updated = await store.updateSession(sessionId, {
      round: result.session.round,
      currentMemberId: result.session.currentMemberId,
      status: result.session.status,
    });
    sendJson(res, 200, { ok: true, ended: false, delivered: true, handoff: true, session: updated });
    return true;
  }

  // ---- End (host only) ----
  m = p.match(/^\/api\/sessions\/([^/]+)\/members\/([^/]+)\/end$/);
  if (m && method === "POST") {
    const sessionId = decodeURIComponent(m[1]);
    const memberId = decodeURIComponent(m[2]);
    const body = await readJson(req);
    const session = store.getSession(sessionId);
    const group = session ? store.getGroup(session.groupId) : null;
    const members = group ? group.members : [];

    const check = validateEnd({ session, members, memberId });
    if (!check.ok) {
      sendJson(res, 409, { error: check.error, code: check.code });
      return true;
    }
    if (body.content) {
      await store.appendMessage({ sessionId, memberId, content: normalizeContent(body.content) });
    }
    const ended = reduceEnd(session);
    const updated = await store.updateSession(sessionId, {
      round: ended.round,
      status: "ended",
    });
    sendJson(res, 200, { ok: true, ended: true, session: updated });
    return true;
  }

  // ---- Recap ----
  m = p.match(/^\/api\/sessions\/([^/]+)\/recap$/);
  if (m && method === "GET") {
    const sessionId = decodeURIComponent(m[1]);
    const session = store.getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "话题讨论不存在" });
      return true;
    }
    const group = store.getGroup(session.groupId);
    const recap = buildRecapPrompt(
      store.listMessages(sessionId),
      nameMap(group ? group.members : []),
    );
    sendJson(res, 200, { recap });
    return true;
  }

  // ---- Stop（强制结束，PTY 保留）----
  m = p.match(/^\/api\/sessions\/([^/]+)\/stop$/);
  if (m && method === "POST") {
    const sessionId = decodeURIComponent(m[1]);
    const session = store.getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "话题讨论不存在" });
      return true;
    }
    const updated = await store.updateSession(sessionId, { status: "ended" });
    sendJson(res, 200, { ok: true, session: updated });
    return true;
  }

  // ---- Reopen（复用存活会话；成员已死则重拉并回灌摘要）----
  m = p.match(/^\/api\/sessions\/([^/]+)\/reopen$/);
  if (m && method === "POST") {
    const sessionId = decodeURIComponent(m[1]);
    const body = await readJson(req);
    const session = store.getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "话题讨论不存在" });
      return true;
    }
    const group = store.getGroup(session.groupId);
    const members = group ? group.members : [];
    const cwd = body.cwd || process.cwd();
    let respawned = false;
    for (const member of members) {
      if (!ptyMgr.has(ptyMgr.memberKey(sessionId, member.id))) {
        respawned = true;
        ptyMgr.ensureMember({
          sessionId,
          member,
          cwd,
          env: memberEnv(ctx, session, member),
        });
      }
    }
    const updated = await store.updateSession(sessionId, { status: "running" });
    // 若有成员被重拉（PTY 失去记忆），给当前发言人回灌一份讨论摘要。
    if (respawned) {
      const current = members.find((x) => x.id === updated.currentMemberId);
      if (current) {
        const recap = buildRecapPrompt(store.listMessages(sessionId), nameMap(members));
        const curKey = ptyMgr.memberKey(sessionId, current.id);
        if (ptyMgr.waitForReady) await ptyMgr.waitForReady(curKey, current.runtime);
        await ptyMgr.typeInto(curKey, recap, current.runtime);
      }
    }
    sendJson(res, 200, { ok: true, session: updated, respawned });
    return true;
  }

  // ---- Revisions（用户反馈驱动的派生讨论，§9.3）----
  m = p.match(/^\/api\/sessions\/([^/]+)\/revisions$/);
  if (m && method === "POST") {
    const parentSessionId = decodeURIComponent(m[1]);
    const body = await readJson(req);
    const parent = store.getSession(parentSessionId);
    if (!parent) {
      sendJson(res, 404, { error: "父话题讨论不存在" });
      return true;
    }
    const group = store.getGroup(parent.groupId);
    const members = group ? group.members : [];
    const host = findHost(members);
    if (!host) {
      sendJson(res, 400, { error: "讨论组缺少主理人" });
      return true;
    }
    const existingChild = store
      .listSessions(parent.groupId)
      .some((s) => s.parentSessionId === parentSessionId);
    const check = validateRevision({ parentSession: parent, feedback: body.feedback, existingChild });
    if (!check.ok) {
      const status = check.code === "already_revised" ? 409 : 400;
      sendJson(res, status, { error: check.error, code: check.code });
      return true;
    }

    // 上一轮结论快照：父会话里最后一条主理人发言；无则回退最后一条消息（§9.3.4）。
    const parentMessages = store.listMessages(parentSessionId);
    const hostMessages = parentMessages.filter((x) => x.memberId === host.id);
    const lastConclusion = hostMessages.length
      ? hostMessages[hostMessages.length - 1]
      : parentMessages[parentMessages.length - 1];
    const previousConclusionSnapshot = lastConclusion ? lastConclusion.content : "";

    let created;
    try {
      created = await store.createRevisionSession({
        parentSessionId,
        feedback: normalizeContent(body.feedback),
        mode: body.mode,
        previousConclusionSnapshot,
      });
    } catch (err) {
      const status = err.code === "already_revised" ? 409 : err.code === "not_found" ? 404 : 500;
      sendJson(res, status, { error: err.message, code: err.code });
      return true;
    }

    const session = created.session;
    const cwd = body.cwd || process.cwd();
    for (const member of members) {
      ptyMgr.ensureMember({
        sessionId: session.id,
        member,
        cwd,
        cols: body.cols,
        rows: body.rows,
        env: memberEnv(ctx, session, member),
      });
    }
    const updated = await store.updateSession(session.id, {
      status: "running",
      round: 0,
      currentMemberId: host.id,
    });
    const opening = buildRevisionOpeningPrompt({
      topic: session.topic,
      member: host,
      rule: group.rule,
      previousConclusion: previousConclusionSnapshot,
      userFeedback: created.feedbackMessage.content,
      mode: session.reopenMode,
    });
    const hostKey = ptyMgr.memberKey(session.id, host.id);
    const ready = ptyMgr.waitForReady ? await ptyMgr.waitForReady(hostKey, host.runtime) : true;
    const delivered = await ptyMgr.typeInto(hostKey, opening, host.runtime);
    sendJson(res, 201, { session: updated, delivered, ready });
    return true;
  }

  // ---- Close（kill 全部成员 PTY，并把会话置为 ended）----
  m = p.match(/^\/api\/sessions\/([^/]+)\/close$/);
  if (m && method === "POST") {
    const sessionId = decodeURIComponent(m[1]);
    const session = store.getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "话题讨论不存在" });
      return true;
    }
    const killed = ptyMgr.closeSession(sessionId);
    // 关闭会话即释放资源：PTY 都被 kill，会话不可能再继续，状态必须脱离 running，
    // 否则前端会一直把它当 running 轮询，当前发言人却收发不了任何内容。
    const updated = await store.updateSession(sessionId, { status: "ended" });
    sendJson(res, 200, { ok: true, killed, session: updated });
    return true;
  }

  return false;
}
