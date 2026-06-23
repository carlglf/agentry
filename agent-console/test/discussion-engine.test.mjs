import { describe, it, expect } from "vitest";
import {
  validateGroup,
  findHost,
  findMemberByName,
  validateSay,
  validateEnd,
  computeDelta,
  reduceSay,
  reduceEnd,
  nextSeq,
  normalizeContent,
  validateRevision,
  deriveRevisionNo,
} from "../server/discussion-engine.mjs";

const member = (over = {}) => ({
  id: over.id || "m1",
  name: over.name || "张三",
  runtime: over.runtime || "codex",
  model: over.model || "gpt-5-codex",
  persona: over.persona || "",
  duty: over.duty || "",
  isHost: over.isHost || false,
  ...over,
});

describe("validateGroup", () => {
  const group = { name: "电商讨论组" };

  it("接受恰好一个主理人且成员名唯一的组", () => {
    const r = validateGroup(group, [
      member({ id: "a", name: "张三", isHost: true }),
      member({ id: "b", name: "李四" }),
    ]);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("拒绝 0 个主理人", () => {
    const r = validateGroup(group, [member({ name: "张三" }), member({ name: "李四" })]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("主理人"))).toBe(true);
  });

  it("拒绝 2 个主理人", () => {
    const r = validateGroup(group, [
      member({ id: "a", name: "张三", isHost: true }),
      member({ id: "b", name: "李四", isHost: true }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("主理人"))).toBe(true);
  });

  it("拒绝重名（大小写/空格不敏感）", () => {
    const r = validateGroup(group, [
      member({ id: "a", name: "Alice", isHost: true }),
      member({ id: "b", name: " alice " }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("重复"))).toBe(true);
  });

  it("拒绝空成员名", () => {
    const r = validateGroup(group, [member({ name: "  ", isHost: true })]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("不能为空"))).toBe(true);
  });

  it("拒绝非法 runtime 和空 model", () => {
    const r = validateGroup(group, [
      member({ name: "张三", isHost: true, runtime: "gpt", model: "" }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("runtime"))).toBe(true);
    expect(r.errors.some((e) => e.includes("model"))).toBe(true);
  });

  it("拒绝空组名和零成员", () => {
    const r = validateGroup({ name: "" }, []);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("名称"))).toBe(true);
    expect(r.errors.some((e) => e.includes("至少"))).toBe(true);
  });
});

describe("findHost / findMemberByName", () => {
  const members = [
    member({ id: "a", name: "张三", isHost: true }),
    member({ id: "b", name: "李四" }),
  ];
  it("找到主理人", () => {
    expect(findHost(members)?.id).toBe("a");
  });
  it("无主理人返回 null", () => {
    expect(findHost([member({ name: "x" })])).toBe(null);
  });
  it("按名查找（trim + 大小写不敏感）", () => {
    expect(findMemberByName(members, " 李四 ")?.id).toBe("b");
    expect(findMemberByName(members, "WANGWU")).toBe(null);
  });
});

describe("validateSay", () => {
  const members = [
    member({ id: "a", name: "张三", isHost: true }),
    member({ id: "b", name: "李四" }),
  ];
  const running = { status: "running", currentMemberId: "a" };

  it("happy：返回 nextMemberId", () => {
    const r = validateSay({ session: running, members, memberId: "a", next: "李四" });
    expect(r.ok).toBe(true);
    expect(r.nextMemberId).toBe("b");
  });

  it("拒绝非 running", () => {
    const r = validateSay({
      session: { status: "ended", currentMemberId: "a" },
      members,
      memberId: "a",
      next: "李四",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not_running");
  });

  it("拒绝非当前发言人", () => {
    const r = validateSay({ session: running, members, memberId: "b", next: "张三" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not_current_speaker");
  });

  it("拒绝提名自己（决策7）", () => {
    const r = validateSay({ session: running, members, memberId: "a", next: "张三" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("next_self");
  });

  it("拒绝未知提名", () => {
    const r = validateSay({ session: running, members, memberId: "a", next: "王五" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("unknown_next");
  });

  it("拒绝缺失 next", () => {
    const r = validateSay({ session: running, members, memberId: "a", next: "" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("missing_next");
  });
});

describe("validateEnd", () => {
  const members = [
    member({ id: "a", name: "张三", isHost: true }),
    member({ id: "b", name: "李四" }),
  ];
  const running = { status: "running", currentMemberId: "a" };

  it("主理人可结束", () => {
    expect(validateEnd({ session: running, members, memberId: "a" }).ok).toBe(true);
  });
  it("非主理人拒绝", () => {
    const r = validateEnd({ session: running, members, memberId: "b" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not_host");
  });
  it("非 running 拒绝", () => {
    const r = validateEnd({ session: { status: "idle" }, members, memberId: "a" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not_running");
  });
});

describe("computeDelta", () => {
  const msgs = [
    { seq: 1, memberId: "a", content: "a1" },
    { seq: 2, memberId: "b", content: "b1" },
    { seq: 3, memberId: "a", content: "a2" },
    { seq: 4, memberId: "c", content: "c1" },
  ];

  it("只返回别人、且在自己上次发言之后的消息", () => {
    const d = computeDelta(msgs, "a");
    expect(d.map((m) => m.content)).toEqual(["c1"]); // a 上次 seq=3，之后只有 c1
  });

  it("首次被提名的成员拿到此前全部别人消息", () => {
    const d = computeDelta(msgs, "z");
    expect(d.map((m) => m.content)).toEqual(["a1", "b1", "a2", "c1"]);
  });

  it("永不包含自己的消息", () => {
    const d = computeDelta(msgs, "b");
    expect(d.every((m) => m.memberId !== "b")).toBe(true);
  });

  it("按 seq 升序", () => {
    const d = computeDelta([...msgs].reverse(), "z");
    expect(d.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  });

  it("空输入返回空数组", () => {
    expect(computeDelta([], "a")).toEqual([]);
    expect(computeDelta(undefined, "a")).toEqual([]);
  });
});

describe("reduceSay", () => {
  const base = { round: 0, currentMemberId: "a", status: "running", maxRounds: 3 };

  it("按发言计数 round+1，切换当前发言人", () => {
    const r = reduceSay(base, { nextMemberId: "b" }, 3);
    expect(r.session.round).toBe(1);
    expect(r.session.currentMemberId).toBe("b");
    expect(r.session.status).toBe("running");
    expect(r.ended).toBe(false);
  });

  it("达到 maxRounds 自动结束，不再切换发言人", () => {
    const r = reduceSay({ ...base, round: 2 }, { nextMemberId: "b" }, 3);
    expect(r.session.round).toBe(3);
    expect(r.session.status).toBe("ended");
    expect(r.session.currentMemberId).toBe("a");
    expect(r.ended).toBe(true);
    expect(r.reason).toBe("maxRounds");
  });
});

describe("reduceEnd / nextSeq", () => {
  it("reduceEnd 置 ended 且 round+1", () => {
    const s = reduceEnd({ round: 2, status: "running" });
    expect(s.status).toBe("ended");
    expect(s.round).toBe(3);
  });
  it("nextSeq 空→1，否则 max+1", () => {
    expect(nextSeq([])).toBe(1);
    expect(nextSeq([{ seq: 5 }, { seq: 2 }])).toBe(6);
  });
});

describe("normalizeContent", () => {
  it("把字面量 \\n / \\r\\n / \\t 还原为真实字符（codex 经双引号提交的内容）", () => {
    expect(normalizeContent("第一段\\n\\n第二段")).toBe("第一段\n\n第二段");
    expect(normalizeContent("a\\r\\nb")).toBe("a\nb");
    expect(normalizeContent("col1\\tcol2")).toBe("col1\tcol2");
  });

  it("内容已含真实换行时原样返回（不破坏 claude/stdin 的多行内容）", () => {
    const real = "第一段\n\n第二段（这里有字面量 \\n 不应被动）";
    expect(normalizeContent(real)).toBe(real);
  });

  it("非字符串归一化为空串", () => {
    expect(normalizeContent(undefined)).toBe("");
    expect(normalizeContent(null)).toBe("");
  });
});

describe("validateRevision", () => {
  const ended = { id: "s1", status: "ended" };

  it("happy：父已结束 + 反馈非空 + 无 existing child", () => {
    expect(validateRevision({ parentSession: ended, feedback: "意见", existingChild: false }).ok).toBe(true);
  });

  it("父会话不存在 → no_session", () => {
    const r = validateRevision({ parentSession: null, feedback: "x", existingChild: false });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("no_session");
  });

  it("父会话未结束 → not_ended", () => {
    const r = validateRevision({ parentSession: { status: "running" }, feedback: "x", existingChild: false });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not_ended");
  });

  it("空反馈（含纯空白）→ empty_feedback", () => {
    expect(validateRevision({ parentSession: ended, feedback: "   ", existingChild: false }).code).toBe(
      "empty_feedback",
    );
    expect(validateRevision({ parentSession: ended, feedback: "", existingChild: false }).code).toBe(
      "empty_feedback",
    );
  });

  it("已有派生轮 → already_revised", () => {
    const r = validateRevision({ parentSession: ended, feedback: "x", existingChild: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("already_revised");
  });
});

describe("deriveRevisionNo", () => {
  it("首轮无 revisionNo 视为 1，派生为 2", () => {
    expect(deriveRevisionNo({})).toBe(2);
  });
  it("已有 revisionNo 时 +1", () => {
    expect(deriveRevisionNo({ revisionNo: 3 })).toBe(4);
  });
});
