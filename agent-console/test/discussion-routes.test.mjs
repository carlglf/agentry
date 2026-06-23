import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../server/discussion-store.mjs";
import { handleDiscussionApi } from "../server/discussion-routes.mjs";
import { memberKey } from "../server/discussion-pty.mjs";

const runtimeMeta = {
  codex: { command: "codex", yoloArgs: ["--yolo"] },
  claude: { command: "claude", yoloArgs: ["--dangerously-skip-permissions"] },
};

function fakePtyMgr() {
  const alive = new Set();
  const typed = []; // { key, text }
  const closed = [];
  return {
    typed,
    closed,
    alive,
    ensureMember: ({ sessionId, member }) => alive.add(memberKey(sessionId, member.id)),
    typeInto: (key, text) => {
      typed.push({ key, text });
      return Promise.resolve(alive.has(key));
    },
    waitForReady: (key) => Promise.resolve(alive.has(key)),
    has: (key) => alive.has(key),
    closeSession: (sessionId) => {
      const prefix = `disc:${sessionId}:member:`;
      let n = 0;
      for (const k of [...alive]) {
        if (k.startsWith(prefix)) {
          alive.delete(k);
          n += 1;
        }
      }
      closed.push(sessionId);
      return n;
    },
    memberKey,
  };
}

async function call(ctx, { method, path: pathname, body, query }) {
  const captured = {};
  const res = {};
  const url = query ? `${pathname}?${query}` : pathname;
  const handled = await handleDiscussionApi(
    { method, url, headers: { host: "127.0.0.1:5173" }, __body: body || {} },
    res,
    {
      ...ctx,
      host: "127.0.0.1",
      port: 5173,
      readJson: async (req) => req.__body,
      sendJson: (_res, status, payload) => {
        captured.status = status;
        captured.payload = payload;
      },
    },
  );
  return { handled, ...captured };
}

const members = [
  { name: "主持", runtime: "codex", model: "gpt-5-codex", isHost: true, persona: "主理人", duty: "主导" },
  { name: "甲", runtime: "claude", model: "sonnet", persona: "甲设", duty: "甲职" },
  { name: "乙", runtime: "codex", model: "gpt-5", persona: "乙设", duty: "乙职" },
];

describe("discussion-routes full flow", () => {
  let dir;
  let store;
  let ptyMgr;
  let ctx;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "disc-routes-"));
    store = createStore({ dataDir: dir });
    await store.load();
    ptyMgr = fakePtyMgr();
    ctx = { store, ptyMgr, runtimeMeta };
  });

  it("建组 → 建话题 → start → say → end → close 全流程", async () => {
    // 建组
    const created = await call(ctx, {
      method: "POST",
      path: "/api/groups",
      body: { projectId: "p1", name: "策略组", rule: "简洁", members },
    });
    expect(created.status).toBe(201);
    const group = created.payload.group;
    const host = group.members.find((m) => m.isHost);
    const jia = group.members.find((m) => m.name === "甲");
    const yi = group.members.find((m) => m.name === "乙");

    // 列组
    const listed = await call(ctx, { method: "GET", path: "/api/groups", query: "projectId=p1" });
    expect(listed.payload.groups).toHaveLength(1);

    // 建话题
    const sesRes = await call(ctx, {
      method: "POST",
      path: `/api/groups/${group.id}/sessions`,
      body: { topic: "如何增长", maxRounds: 10 },
    });
    expect(sesRes.status).toBe(201);
    const session = sesRes.payload.session;
    expect(session.status).toBe("idle");
    expect(session.currentMemberId).toBe(host.id);

    // start：拉起成员 + 给 host 注入开场
    const startRes = await call(ctx, { method: "POST", path: `/api/sessions/${session.id}/start` });
    expect(startRes.payload.session.status).toBe("running");
    expect(ptyMgr.alive.has(memberKey(session.id, host.id))).toBe(true);
    const opening = ptyMgr.typed.find((t) => t.key === memberKey(session.id, host.id));
    expect(opening.text).toContain("如何增长");
    expect(opening.text).toContain("主理人");

    // host say --next 甲：甲应收到 delta（含 host 发言）
    const say1 = await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/members/${host.id}/say`,
      body: { content: "开场观点", next: "甲" },
    });
    expect(say1.status).toBe(200);
    expect(say1.payload.session.currentMemberId).toBe(jia.id);
    const toJia = ptyMgr.typed.filter((t) => t.key === memberKey(session.id, jia.id)).pop();
    expect(toJia.text).toContain("开场观点");

    // 非当前发言人（乙）抢说 → 409
    const stolen = await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/members/${yi.id}/say`,
      body: { content: "插嘴", next: "甲" },
    });
    expect(stolen.status).toBe(409);
    expect(stolen.payload.code).toBe("not_current_speaker");

    // 甲提名自己 → 409
    const selfNom = await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/members/${jia.id}/say`,
      body: { content: "x", next: "甲" },
    });
    expect(selfNom.status).toBe(409);
    expect(selfNom.payload.code).toBe("next_self");

    // 甲正常 say --next 乙
    const say2 = await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/members/${jia.id}/say`,
      body: { content: "甲的观点", next: "乙" },
    });
    expect(say2.payload.session.currentMemberId).toBe(yi.id);

    // 非 host（乙）end → 409
    const yiEnd = await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/members/${yi.id}/end`,
      body: { content: "我来收尾" },
    });
    expect(yiEnd.status).toBe(409);
    expect(yiEnd.payload.code).toBe("not_host");

    // 乙 say --next 主持，把发言权交回 host
    await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/members/${yi.id}/say`,
      body: { content: "乙的观点", next: "主持" },
    });

    // host end → ended
    const hostEnd = await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/members/${host.id}/end`,
      body: { content: "结论" },
    });
    expect(hostEnd.status).toBe(200);
    expect(hostEnd.payload.session.status).toBe("ended");

    // recap 含全部发言
    const recap = await call(ctx, { method: "GET", path: `/api/sessions/${session.id}/recap` });
    expect(recap.payload.recap).toContain("开场观点");
    expect(recap.payload.recap).toContain("结论");

    // close → kill PTY 且会话状态为 ended
    const closeRes = await call(ctx, { method: "POST", path: `/api/sessions/${session.id}/close` });
    expect(closeRes.payload.killed).toBe(3);
    expect(closeRes.payload.session.status).toBe("ended");
    expect(ptyMgr.closed).toContain(session.id);
  });

  it("say 时下一位 PTY 已死：不推进发言权，状态保持 running 并告警", async () => {
    const created = await call(ctx, {
      method: "POST",
      path: "/api/groups",
      body: { projectId: "p1", name: "组", rule: "", members },
    });
    const group = created.payload.group;
    const host = group.members.find((m) => m.isHost);
    const jia = group.members.find((m) => m.name === "甲");

    const sesRes = await call(ctx, {
      method: "POST",
      path: `/api/groups/${group.id}/sessions`,
      body: { topic: "T", maxRounds: 10 },
    });
    const session = sesRes.payload.session;
    await call(ctx, { method: "POST", path: `/api/sessions/${session.id}/start` });

    // 模拟甲的 PTY 崩溃/被关闭
    ptyMgr.alive.delete(memberKey(session.id, jia.id));

    const say = await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/members/${host.id}/say`,
      body: { content: "开场，交给甲", next: "甲" },
    });
    expect(say.status).toBe(200);
    expect(say.payload.delivered).toBe(false);
    expect(say.payload.handoff).toBe(false);
    expect(say.payload.warning).toMatch(/未能把发言权送达/);
    // 发言权仍在 host，状态仍 running，没有卡在死掉的甲身上
    expect(say.payload.session.currentMemberId).toBe(host.id);
    expect(say.payload.session.status).toBe("running");
    // 发言已记录
    const got = await call(ctx, { method: "GET", path: `/api/sessions/${session.id}` });
    expect(got.payload.messages.map((x) => x.content)).toContain("开场，交给甲");
  });

  it("close 一个 running 会话：kill PTY 且置为 ended", async () => {
    const created = await call(ctx, {
      method: "POST",
      path: "/api/groups",
      body: { projectId: "p1", name: "组", rule: "", members },
    });
    const group = created.payload.group;
    const sesRes = await call(ctx, {
      method: "POST",
      path: `/api/groups/${group.id}/sessions`,
      body: { topic: "T", maxRounds: 10 },
    });
    const session = sesRes.payload.session;
    await call(ctx, { method: "POST", path: `/api/sessions/${session.id}/start` });
    // 仍在 running
    expect((await call(ctx, { method: "GET", path: `/api/sessions/${session.id}` })).payload.session.status).toBe(
      "running",
    );

    const closeRes = await call(ctx, { method: "POST", path: `/api/sessions/${session.id}/close` });
    expect(closeRes.payload.killed).toBe(3);
    expect(closeRes.payload.session.status).toBe("ended");
    // 落盘也为 ended
    expect((await call(ctx, { method: "GET", path: `/api/sessions/${session.id}` })).payload.session.status).toBe(
      "ended",
    );
  });

  it("close 不存在的会话返回 404", async () => {
    const r = await call(ctx, { method: "POST", path: "/api/sessions/nope/close" });
    expect(r.status).toBe(404);
  });

  it("maxRounds 触顶自动结束", async () => {
    const created = await call(ctx, {
      method: "POST",
      path: "/api/groups",
      body: { projectId: "p1", name: "组", rule: "", members },
    });
    const group = created.payload.group;
    const host = group.members.find((m) => m.isHost);
    const jia = group.members.find((m) => m.name === "甲");

    const sesRes = await call(ctx, {
      method: "POST",
      path: `/api/groups/${group.id}/sessions`,
      body: { topic: "T", maxRounds: 1 },
    });
    const session = sesRes.payload.session;
    await call(ctx, { method: "POST", path: `/api/sessions/${session.id}/start` });

    const say1 = await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/members/${host.id}/say`,
      body: { content: "唯一一轮", next: "甲" },
    });
    expect(say1.payload.ended).toBe(true);
    expect(say1.payload.reason).toBe("maxRounds");
    expect(say1.payload.session.status).toBe("ended");
    expect(jia).toBeTruthy();
  });

  it("创建非法组返回 400", async () => {
    const r = await call(ctx, {
      method: "POST",
      path: "/api/groups",
      body: { projectId: "p1", name: "坏组", members: [{ name: "x", runtime: "codex", model: "m" }] },
    });
    expect(r.status).toBe(400);
    expect(r.payload.errors.some((e) => e.includes("主理人"))).toBe(true);
  });

  it("未命中的路由返回 false", async () => {
    const res = {};
    const handled = await handleDiscussionApi(
      { method: "GET", url: "/api/runtime-meta", headers: { host: "x" } },
      res,
      { ...ctx, host: "x", port: 1, readJson: async () => ({}), sendJson: () => {} },
    );
    expect(handled).toBe(false);
  });

  async function buildEndedSession() {
    const created = await call(ctx, {
      method: "POST",
      path: "/api/groups",
      body: { projectId: "p1", name: "组", rule: "简洁", members },
    });
    const group = created.payload.group;
    const host = group.members.find((m) => m.isHost);
    const sesRes = await call(ctx, {
      method: "POST",
      path: `/api/groups/${group.id}/sessions`,
      body: { topic: "如何增长", maxRounds: 10 },
    });
    const session = sesRes.payload.session;
    await call(ctx, { method: "POST", path: `/api/sessions/${session.id}/start` });
    await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/members/${host.id}/end`,
      body: { content: "第一轮结论：先做留存" },
    });
    return { group, host, session };
  }

  it("revisions：从已结束会话派生新一轮，写入 user_feedback 并给 host 注入开场，父会话仍 ended", async () => {
    const { host, session } = await buildEndedSession();

    const rev = await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/revisions`,
      body: { feedback: "留存方案没说清楚成本", mode: "revise" },
    });
    expect(rev.status).toBe(201);
    const derived = rev.payload.session;
    expect(derived.id).not.toBe(session.id);
    expect(derived.parentSessionId).toBe(session.id);
    expect(derived.revisionNo).toBe(2);
    expect(derived.reopenMode).toBe("revise");
    expect(derived.status).toBe("running");
    expect(derived.previousConclusionSnapshot).toContain("先做留存");

    // 派生会话首条是 user_feedback（作者为空，不伪装成员）
    const got = await call(ctx, { method: "GET", path: `/api/sessions/${derived.id}` });
    const first = got.payload.messages[0];
    expect(first.type).toBe("user_feedback");
    expect(first.memberId).toBeNull();
    expect(first.content).toBe("留存方案没说清楚成本");

    // host 收到派生开场，含上一轮结论 + 逐字反馈
    const opening = ptyMgr.typed.filter((t) => t.key === memberKey(derived.id, host.id)).pop();
    expect(opening.text).toContain("先做留存");
    expect(opening.text).toContain("留存方案没说清楚成本");

    // 父会话保持 ended、不可变
    const parent = await call(ctx, { method: "GET", path: `/api/sessions/${session.id}` });
    expect(parent.payload.session.status).toBe("ended");
  });

  it("revisions：父会话未结束 → 400 not_ended", async () => {
    const created = await call(ctx, {
      method: "POST",
      path: "/api/groups",
      body: { projectId: "p1", name: "组", members },
    });
    const group = created.payload.group;
    const sesRes = await call(ctx, {
      method: "POST",
      path: `/api/groups/${group.id}/sessions`,
      body: { topic: "T" },
    });
    const session = sesRes.payload.session;
    await call(ctx, { method: "POST", path: `/api/sessions/${session.id}/start` });
    const rev = await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/revisions`,
      body: { feedback: "x", mode: "revise" },
    });
    expect(rev.status).toBe(400);
    expect(rev.payload.code).toBe("not_ended");
  });

  it("revisions：空反馈 → 400 empty_feedback", async () => {
    const { session } = await buildEndedSession();
    const rev = await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/revisions`,
      body: { feedback: "   ", mode: "revise" },
    });
    expect(rev.status).toBe(400);
    expect(rev.payload.code).toBe("empty_feedback");
  });

  it("revisions：同一父会话重复派生 → 409 already_revised", async () => {
    const { session } = await buildEndedSession();
    const first = await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/revisions`,
      body: { feedback: "意见一", mode: "revise" },
    });
    expect(first.status).toBe(201);
    const second = await call(ctx, {
      method: "POST",
      path: `/api/sessions/${session.id}/revisions`,
      body: { feedback: "意见二", mode: "restart" },
    });
    expect(second.status).toBe(409);
    expect(second.payload.code).toBe("already_revised");
  });

  it("revisions：不存在的父会话 → 404", async () => {
    const r = await call(ctx, {
      method: "POST",
      path: "/api/sessions/nope/revisions",
      body: { feedback: "x" },
    });
    expect(r.status).toBe(404);
  });

  it("GET session 返回 session+members+messages", async () => {
    const created = await call(ctx, {
      method: "POST",
      path: "/api/groups",
      body: { projectId: "p1", name: "组", members },
    });
    const group = created.payload.group;
    const sesRes = await call(ctx, {
      method: "POST",
      path: `/api/groups/${group.id}/sessions`,
      body: { topic: "T" },
    });
    const session = sesRes.payload.session;
    const got = await call(ctx, { method: "GET", path: `/api/sessions/${session.id}` });
    expect(got.payload.session.id).toBe(session.id);
    expect(got.payload.members).toHaveLength(3);
    expect(got.payload.messages).toEqual([]);
  });
});
