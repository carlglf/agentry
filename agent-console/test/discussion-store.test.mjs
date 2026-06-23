import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../server/discussion-store.mjs";

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "disc-store-"));
}

const validMembers = [
  { name: "张三", runtime: "codex", model: "gpt-5-codex", isHost: true, persona: "P", duty: "D" },
  { name: "李四", runtime: "claude", model: "sonnet" },
];

describe("discussion-store", () => {
  let dir;
  let store;
  beforeEach(async () => {
    dir = await tmpDir();
    store = createStore({ dataDir: dir });
    await store.load();
  });

  it("load 空目录返回空集合", () => {
    expect(store.listGroups()).toEqual([]);
  });

  it("createGroup 成功并带回成员", async () => {
    const g = await store.createGroup({
      projectId: "p1",
      name: "电商组",
      rule: "简洁",
      members: validMembers,
    });
    expect(g.id).toBeTruthy();
    expect(g.members).toHaveLength(2);
    expect(g.members.find((m) => m.isHost)?.name).toBe("张三");
  });

  it("createGroup 校验失败抛错（无主理人）", async () => {
    await expect(
      store.createGroup({
        projectId: "p1",
        name: "坏组",
        members: [{ name: "张三", runtime: "codex", model: "x" }],
      }),
    ).rejects.toThrow(/主理人/);
  });

  it("appendMessage seq 按 session 单调递增", async () => {
    const g = await store.createGroup({ projectId: "p1", name: "组", members: validMembers });
    const s = await store.createSession({ groupId: g.id, topic: "T", maxRounds: 10 });
    const m1 = await store.appendMessage({ sessionId: s.id, memberId: "a", content: "一" });
    const m2 = await store.appendMessage({ sessionId: s.id, memberId: "b", content: "二" });
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
    expect(store.listMessages(s.id).map((m) => m.content)).toEqual(["一", "二"]);
  });

  it("seq 按 session 隔离", async () => {
    const g = await store.createGroup({ projectId: "p1", name: "组", members: validMembers });
    const s1 = await store.createSession({ groupId: g.id, topic: "T1" });
    const s2 = await store.createSession({ groupId: g.id, topic: "T2" });
    await store.appendMessage({ sessionId: s1.id, memberId: "a", content: "a" });
    const firstInS2 = await store.appendMessage({ sessionId: s2.id, memberId: "a", content: "b" });
    expect(firstInS2.seq).toBe(1);
  });

  it("原子写后另一个 store 实例可读回（reload 持久化）", async () => {
    const g = await store.createGroup({ projectId: "p1", name: "持久组", members: validMembers });
    const s = await store.createSession({ groupId: g.id, topic: "话题" });
    await store.appendMessage({ sessionId: s.id, memberId: "a", content: "hi" });

    const store2 = createStore({ dataDir: dir });
    await store2.load();
    const groups = store2.listGroups("p1");
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("持久组");
    expect(store2.listSessions(g.id)).toHaveLength(1);
    expect(store2.listMessages(s.id)).toHaveLength(1);
  });

  it("createSession 默认 status idle 且 currentMemberId 为主理人", async () => {
    const g = await store.createGroup({ projectId: "p1", name: "组", members: validMembers });
    const s = await store.createSession({ groupId: g.id, topic: "T" });
    const host = g.members.find((m) => m.isHost);
    expect(s.status).toBe("idle");
    expect(s.currentMemberId).toBe(host.id);
    expect(s.round).toBe(0);
  });

  it("updateSession 落盘", async () => {
    const g = await store.createGroup({ projectId: "p1", name: "组", members: validMembers });
    const s = await store.createSession({ groupId: g.id, topic: "T" });
    await store.updateSession(s.id, { status: "running", round: 2 });
    expect(store.getSession(s.id).status).toBe("running");
    expect(store.getSession(s.id).round).toBe(2);
  });

  it("deleteGroup 级联删除 session 与 message", async () => {
    const g = await store.createGroup({ projectId: "p1", name: "组", members: validMembers });
    const s = await store.createSession({ groupId: g.id, topic: "T" });
    await store.appendMessage({ sessionId: s.id, memberId: "a", content: "x" });
    await store.deleteGroup(g.id);
    expect(store.listGroups("p1")).toHaveLength(0);
    expect(store.listSessions(g.id)).toHaveLength(0);
    expect(store.listMessages(s.id)).toHaveLength(0);
  });

  it("updateGroup 校验失败时抛错且不写坏", async () => {
    const g = await store.createGroup({ projectId: "p1", name: "组", members: validMembers });
    await expect(
      store.updateGroup(g.id, {
        members: [{ name: "x", runtime: "codex", model: "m" }], // 0 主理人
      }),
    ).rejects.toThrow(/主理人/);
    expect(store.getGroup(g.id).members).toHaveLength(2);
  });

  it("appendMessage 支持 type 与 null memberId（user_feedback）", async () => {
    const g = await store.createGroup({ projectId: "p1", name: "组", members: validMembers });
    const s = await store.createSession({ groupId: g.id, topic: "T" });
    const fb = await store.appendMessage({
      sessionId: s.id,
      memberId: null,
      type: "user_feedback",
      content: "意见",
    });
    expect(fb.memberId).toBeNull();
    expect(fb.type).toBe("user_feedback");
    const normal = await store.appendMessage({ sessionId: s.id, memberId: "a", content: "x" });
    expect(normal.type).toBe("member_message"); // 默认类型
  });

  it("createRevisionSession 原子建派生 session + seq1 的 user_feedback 并回填 id", async () => {
    const g = await store.createGroup({ projectId: "p1", name: "组", members: validMembers });
    const host = g.members.find((m) => m.isHost);
    const parent = await store.createSession({ groupId: g.id, topic: "话题", maxRounds: 8 });
    await store.updateSession(parent.id, { status: "ended" });

    const { session, feedbackMessage } = await store.createRevisionSession({
      parentSessionId: parent.id,
      feedback: "我的意见",
      mode: "revise",
      previousConclusionSnapshot: "上一轮结论",
    });
    expect(session.parentSessionId).toBe(parent.id);
    expect(session.revisionNo).toBe(2);
    expect(session.reopenMode).toBe("revise");
    expect(session.status).toBe("idle");
    expect(session.maxRounds).toBe(8);
    expect(session.currentMemberId).toBe(host.id);
    expect(session.previousConclusionSnapshot).toBe("上一轮结论");
    expect(session.userFeedbackMessageId).toBe(feedbackMessage.id);

    const msgs = store.listMessages(session.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].seq).toBe(1);
    expect(msgs[0].type).toBe("user_feedback");
    expect(msgs[0].memberId).toBeNull();
    expect(msgs[0].content).toBe("我的意见");
  });

  it("createRevisionSession 拒绝重复派生（同父已有 child）", async () => {
    const g = await store.createGroup({ projectId: "p1", name: "组", members: validMembers });
    const parent = await store.createSession({ groupId: g.id, topic: "话题" });
    await store.updateSession(parent.id, { status: "ended" });
    await store.createRevisionSession({ parentSessionId: parent.id, feedback: "一", mode: "revise" });
    await expect(
      store.createRevisionSession({ parentSessionId: parent.id, feedback: "二", mode: "restart" }),
    ).rejects.toThrow(/最新一轮/);
  });

  it("createRevisionSession 派生链可 reload 还原", async () => {
    const g = await store.createGroup({ projectId: "p1", name: "组", members: validMembers });
    const parent = await store.createSession({ groupId: g.id, topic: "话题" });
    await store.updateSession(parent.id, { status: "ended" });
    const { session } = await store.createRevisionSession({
      parentSessionId: parent.id,
      feedback: "意见",
      mode: "revise",
    });

    const store2 = createStore({ dataDir: dir });
    await store2.load();
    const reloaded = store2.getSession(session.id);
    expect(reloaded.parentSessionId).toBe(parent.id);
    expect(reloaded.revisionNo).toBe(2);
    expect(store2.listMessages(session.id)[0].type).toBe("user_feedback");
  });
});
