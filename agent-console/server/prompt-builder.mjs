// 注入给成员 PTY 的提示词构造（纯字符串，无 I/O）。
// 对应需求文档 §5：开场首轮含 话题+人设+职责+规则；后续仅注入「自上次发言以来、别人的新发言」。

const CLI_HINT = [
  "发言后请调用 CLI 把发言权交给下一位：",
  '  acg say --next <成员名> "你的发言内容"',
  "（长内容可用 stdin：acg say --next <成员名> < message.txt）",
  '主理人若认为讨论可以结束，改用：acg end "收尾结论"',
].join("\n");

const DISCUSSION_PROTOCOL = [
  "【讨论质量协议】",
  "本次讨论不是轮流表态，而是要逐步逼近可执行结论。请遵守：",
  "1. 发散：补充你职责范围内的新维度，不要复述别人已经说过的内容。",
  "2. 交锋：指出上一位或当前共识里的漏洞、风险、遗漏或过度假设，并给出替代方案。",
  "3. 收敛：只有在目标、约束、方案、取舍、风险、待验证事项、下一步行动都被覆盖后，主理人才可以结束。",
  "4. 每次发言必须推进讨论：至少给出一个新判断、一个依据、一个风险/反对点或一个可执行建议。",
  "5. 如果话题过泛，先主动拆解成关键子问题；如果缺少信息，明确列出需要验证的假设。",
].join("\n");

const SPEAKING_CONTRACT = [
  "【本轮发言格式】",
  "请用清晰的小标题或列表输出，至少覆盖：",
  "- 我的判断",
  "- 依据",
  "- 对上一位观点的补充或反驳",
  "- 仍未解决的问题",
  "- 为什么点名下一位",
].join("\n");

const HOST_CONTRACT = [
  "【主理人额外职责】",
  "你需要控制讨论质量，而不是过早总结。结束前请确认：",
  "- 是否至少完成了发散与交锋；",
  "- 是否覆盖了关键子问题、主要分歧、风险、取舍和下一步；",
  "- 最终结论是否包含共识、分歧、决策、待验证事项和行动项。",
].join("\n");

/** 开场提示词：仅注入给主理人，用于首发。 */
export function buildOpeningPrompt({ topic, member, rule }) {
  const lines = [
    "【讨论开始】",
    `话题：${topic}`,
    `你的人设：${member?.persona || "（未设置）"}`,
    `你的职责：${member?.duty || "（未设置）"}`,
  ];
  if (rule && String(rule).trim()) {
    lines.push(`讨论规则：${String(rule).trim()}`);
  }
  lines.push("");
  lines.push(DISCUSSION_PROTOCOL);
  lines.push("");
  lines.push(SPEAKING_CONTRACT);
  lines.push("");
  lines.push(HOST_CONTRACT);
  lines.push("");
  lines.push("你是本次讨论的主理人。请先拆解话题、定义本轮需要覆盖的关键问题，发表第一轮观点，然后提名最应该补充或挑战你的下一位发言人。");
  lines.push(CLI_HINT);
  return lines.join("\n");
}

const REVISION_CLOSING_CONTRACT = [
  "【本轮收尾要求（对照式结论）】",
  "本轮是在用户意见驱动下的继续讨论，结束时（acg end）请相对上一轮结论给出对照：",
  "- 保留项：上一轮哪些结论仍然成立。",
  "- 修改项：哪些被调整，以及调整成了什么。",
  "- 废弃项：哪些被推翻或放弃。",
  "- 修改依据：为何这样取舍（须回应用户意见）。",
  "- 仍有分歧：尚未达成共识之处。",
  "- 待验证：仍需进一步确认的假设或事项。",
].join("\n");

/** 派生轮开场提示词（§9.4）：仅注入给主理人，用于继续讨论的首发。 */
export function buildRevisionOpeningPrompt({ topic, member, rule, previousConclusion, userFeedback, mode }) {
  const restart = mode === "restart";
  const lines = [
    "【继续讨论 · 新一轮】",
    `话题：${topic}`,
    `你的人设：${member?.persona || "（未设置）"}`,
    `你的职责：${member?.duty || "（未设置）"}`,
  ];
  if (rule && String(rule).trim()) {
    lines.push(`讨论规则：${String(rule).trim()}`);
  }
  lines.push("");
  lines.push("【上一轮结论】");
  lines.push(String(previousConclusion || "").trim() || "（上一轮无可用结论）");
  lines.push("");
  lines.push("【用户意见（原文，请勿改写）】");
  lines.push(String(userFeedback || "").trim() || "（空）");
  lines.push("");
  lines.push(
    restart
      ? "本轮模式：不沿用上一轮结论，从头讨论。上一轮结论仅作背景参考。"
      : "本轮模式：基于上一轮结论进行修订。",
  );
  lines.push(
    "用户的意见是新的证据或约束，可以被分析、质疑、甚至反驳，但不是预设答案——不要无条件照单全收。",
  );
  lines.push("");
  lines.push(DISCUSSION_PROTOCOL);
  lines.push("");
  lines.push(SPEAKING_CONTRACT);
  lines.push("");
  lines.push(HOST_CONTRACT);
  lines.push("");
  lines.push(REVISION_CLOSING_CONTRACT);
  lines.push("");
  lines.push(
    "你是本轮主理人。请先指出这条用户意见挑战了上一轮的哪些假设或决策，再列出本轮需要重新解决的关键问题，发表你的判断，然后提名最该补充或挑战你的下一位发言人。",
  );
  lines.push(CLI_HINT);
  return lines.join("\n");
}

/** 增量提示词：注入给被提名的下一位，只携带别人的新发言。 */
export function buildIncrementalPrompt({ topic, member, deltaMessages, memberNameById }) {
  const lines = [
    "【讨论继续】",
    `话题：${topic}`,
    `你的人设：${member?.persona || "（未设置）"}`,
    `你的职责：${member?.duty || "（未设置）"}`,
    "",
  ];
  const delta = Array.isArray(deltaMessages) ? deltaMessages : [];
  if (delta.length === 0) {
    lines.push("（自你上次发言以来暂无其他成员的新发言）");
  } else {
    lines.push("自你上次发言以来的新发言：");
    for (const m of delta) {
      const name = (memberNameById && memberNameById[m.memberId]) || m.memberId;
      lines.push(`  ${name}：${m.content}`);
    }
  }
  lines.push("");
  lines.push(DISCUSSION_PROTOCOL);
  lines.push("");
  lines.push(SPEAKING_CONTRACT);
  lines.push("");
  if (member?.isHost) {
    lines.push(HOST_CONTRACT);
    lines.push("");
    lines.push("你是主理人。请判断讨论是否已经满足结束条件：若未满足，继续推进并提名下一位；若已满足，用 acg end 输出结构化收尾结论。");
  } else {
    lines.push("你不是主理人，请不要直接收敛为最终结论；你的重点是从自身职责出发补充、挑战、拆风险，并把发言权交给最能继续推进讨论的人。");
  }
  lines.push(CLI_HINT);
  return lines.join("\n");
}

/** 讨论摘要（acg recap / 重开前回灌）：server 直接拼接已记录消息。 */
export function buildRecapPrompt(messages, memberNameById) {
  const list = Array.isArray(messages) ? messages : [];
  const lines = ["【讨论回顾】以下是迄今为止的完整发言记录："];
  if (list.length === 0) {
    lines.push("（暂无发言）");
  } else {
    for (const m of [...list].sort((a, b) => a.seq - b.seq)) {
      const name = (memberNameById && memberNameById[m.memberId]) || m.memberId;
      lines.push(`${m.seq}. ${name}：${m.content}`);
    }
  }
  return lines.join("\n");
}
