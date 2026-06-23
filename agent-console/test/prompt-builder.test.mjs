import { describe, it, expect } from "vitest";
import {
  buildOpeningPrompt,
  buildIncrementalPrompt,
  buildRevisionOpeningPrompt,
  buildRecapPrompt,
} from "../server/prompt-builder.mjs";

describe("buildOpeningPrompt", () => {
  it("包含话题、人设、职责、规则与 acg 用法", () => {
    const p = buildOpeningPrompt({
      topic: "如何提升转化率",
      member: { persona: "增长专家", duty: "主导讨论" },
      rule: "每人发言不超过200字",
    });
    expect(p).toContain("如何提升转化率");
    expect(p).toContain("增长专家");
    expect(p).toContain("主导讨论");
    expect(p).toContain("每人发言不超过200字");
    expect(p).toContain("讨论质量协议");
    expect(p).toContain("发散");
    expect(p).toContain("交锋");
    expect(p).toContain("本轮发言格式");
    expect(p).toContain("主理人额外职责");
    expect(p).toContain("acg say --next");
    expect(p).toContain("acg end");
  });
});

describe("buildIncrementalPrompt", () => {
  const memberNameById = { a: "张三", b: "李四" };

  it("只渲染 delta 中别人的发言，用成员名", () => {
    const p = buildIncrementalPrompt({
      topic: "话题X",
      member: { persona: "P", duty: "D" },
      deltaMessages: [
        { memberId: "a", content: "甲说" },
        { memberId: "b", content: "乙说" },
      ],
      memberNameById,
    });
    expect(p).toContain("张三：甲说");
    expect(p).toContain("李四：乙说");
    expect(p).toContain("话题X");
    expect(p).toContain("讨论质量协议");
    expect(p).toContain("对上一位观点的补充或反驳");
    expect(p).toContain("你不是主理人");
    expect(p).toContain("acg say --next");
  });

  it("下一位是主理人时包含结束条件约束", () => {
    const p = buildIncrementalPrompt({
      topic: "话题X",
      member: { persona: "P", duty: "D", isHost: true },
      deltaMessages: [{ memberId: "a", content: "甲说" }],
      memberNameById,
    });
    expect(p).toContain("主理人额外职责");
    expect(p).toContain("若未满足，继续推进");
    expect(p).toContain("若已满足，用 acg end");
  });

  it("delta 为空时给出占位提示", () => {
    const p = buildIncrementalPrompt({
      topic: "话题",
      member: {},
      deltaMessages: [],
      memberNameById,
    });
    expect(p).toContain("暂无其他成员的新发言");
  });
});

describe("buildRecapPrompt", () => {
  it("按 seq 升序拼接全部发言", () => {
    const p = buildRecapPrompt(
      [
        { seq: 2, memberId: "b", content: "第二" },
        { seq: 1, memberId: "a", content: "第一" },
      ],
      { a: "张三", b: "李四" },
    );
    const firstIdx = p.indexOf("张三：第一");
    const secondIdx = p.indexOf("李四：第二");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it("空记录给出占位", () => {
    expect(buildRecapPrompt([], {})).toContain("暂无发言");
  });
});

describe("buildRevisionOpeningPrompt", () => {
  const host = { name: "主持", persona: "主理人", duty: "主导", isHost: true };

  it("含上一轮结论、逐字反馈、modes 文案与对照式收尾要求（revise）", () => {
    const p = buildRevisionOpeningPrompt({
      topic: "如何增长",
      member: host,
      rule: "简洁",
      previousConclusion: "上一轮：先做留存",
      userFeedback: "成本没说清楚",
      mode: "revise",
    });
    expect(p).toContain("如何增长");
    expect(p).toContain("先做留存");
    expect(p).toContain("成本没说清楚");
    expect(p).toContain("基于上一轮结论进行修订");
    expect(p).toContain("保留项");
    expect(p).toContain("废弃项");
    expect(p).toContain("acg say");
  });

  it("restart 模式给出「从头讨论」文案", () => {
    const p = buildRevisionOpeningPrompt({
      topic: "T",
      member: host,
      previousConclusion: "X",
      userFeedback: "Y",
      mode: "restart",
    });
    expect(p).toContain("从头讨论");
  });

  it("缺失结论/反馈时给出占位，不崩", () => {
    const p = buildRevisionOpeningPrompt({ topic: "T", member: host, mode: "revise" });
    expect(p).toContain("（上一轮无可用结论）");
    expect(p).toContain("（空）");
  });
});
