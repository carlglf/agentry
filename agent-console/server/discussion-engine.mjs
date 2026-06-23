// 讨论组纯逻辑引擎：状态机 + 增量计算 + 校验规则。
// 零依赖纯函数，可被 Vitest 直接单测，不接触 PTY / HTTP / fs。

export const RUNTIMES = new Set(["codex", "claude"]);

/**
 * 归一化成员发言内容。某些 agent（如 codex）通过 `acg say --next X "...\n..."` 提交时，
 * bash 双引号不解释 `\n`，于是内容里存的是「字面量反斜杠 n」而非真实换行，前端渲染成一坨没有断行的文本。
 * 这里只在内容「不含任何真实换行」时，才把字面量转义序列还原为真实字符——
 * 避免破坏本就带真实换行的内容（如经 stdin 提交的多行文本）。
 */
export function normalizeContent(content) {
  if (typeof content !== "string") return "";
  if (/[\r\n]/.test(content)) return content;
  return content
    .replace(/\\r\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

/**
 * 校验讨论组模板（创建/编辑时调用）。
 * 规则：成员≥1；主理人(host)有且只有一个；成员名非空且组内唯一（trim + 大小写不敏感）；
 * runtime ∈ {codex, claude}；model 非空。
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateGroup(group, members) {
  const errors = [];
  const list = Array.isArray(members) ? members : [];

  if (!group || !String(group.name || "").trim()) {
    errors.push("讨论组名称不能为空");
  }
  if (list.length < 1) {
    errors.push("讨论组至少需要一个成员");
  }

  const hostCount = list.filter((m) => m && m.isHost).length;
  if (hostCount !== 1) {
    errors.push(`讨论组必须有且只有一个主理人（当前 ${hostCount} 个）`);
  }

  const seen = new Set();
  for (const m of list) {
    const name = String(m?.name || "").trim();
    if (!name) {
      errors.push("成员名称不能为空");
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      errors.push(`成员名称重复：${name}`);
    }
    seen.add(key);

    if (!RUNTIMES.has(m?.runtime)) {
      errors.push(`成员「${name}」的 runtime 非法：${m?.runtime}`);
    }
    if (!String(m?.model || "").trim()) {
      errors.push(`成员「${name}」的 model 不能为空`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** 返回成员数组里的主理人，没有则返回 null。 */
export function findHost(members) {
  return (Array.isArray(members) ? members : []).find((m) => m && m.isHost) || null;
}

/** 按名称查找成员（trim + 大小写不敏感）。 */
export function findMemberByName(members, name) {
  const target = String(name || "").trim().toLowerCase();
  if (!target) return null;
  return (
    (Array.isArray(members) ? members : []).find(
      (m) => String(m?.name || "").trim().toLowerCase() === target,
    ) || null
  );
}

/**
 * 校验一次发言（acg say）。
 * 拒绝：会话非 running；调用者不是当前发言人；提名(next)缺失/非组内成员/指向自己（决策7）。
 * @returns {{ ok: boolean, error?: string, code?: string, nextMemberId?: string }}
 */
export function validateSay({ session, members, memberId, next }) {
  if (!session) {
    return { ok: false, code: "no_session", error: "话题讨论不存在" };
  }
  if (session.status !== "running") {
    return {
      ok: false,
      code: "not_running",
      error: `话题讨论当前状态为 ${session.status}，无法发言`,
    };
  }
  if (session.currentMemberId !== memberId) {
    return {
      ok: false,
      code: "not_current_speaker",
      error: "当前发言权不在你这里，请等待被提名",
    };
  }

  const nextName = String(next || "").trim();
  if (!nextName) {
    return { ok: false, code: "missing_next", error: "必须用 --next 提名下一位发言人" };
  }

  const self = (members || []).find((m) => m && m.id === memberId);
  if (self && String(self.name || "").trim().toLowerCase() === nextName.toLowerCase()) {
    return { ok: false, code: "next_self", error: "不能提名自己，请提名其他成员" };
  }

  const target = findMemberByName(members, nextName);
  if (!target) {
    return { ok: false, code: "unknown_next", error: `成员不存在：${nextName}` };
  }

  return { ok: true, nextMemberId: target.id };
}

/**
 * 校验结束讨论（acg end）。仅主理人有效。
 * @returns {{ ok: boolean, error?: string, code?: string }}
 */
export function validateEnd({ session, members, memberId }) {
  if (!session) {
    return { ok: false, code: "no_session", error: "话题讨论不存在" };
  }
  if (session.status !== "running") {
    return {
      ok: false,
      code: "not_running",
      error: `话题讨论当前状态为 ${session.status}，无法结束`,
    };
  }
  const self = (members || []).find((m) => m && m.id === memberId);
  if (!self || !self.isHost) {
    return { ok: false, code: "not_host", error: "只有主理人可以结束讨论" };
  }
  return { ok: true };
}

/**
 * 计算注入给 target 的「增量、仅别人」消息（决策4）。
 * 返回 memberId !== target 且 seq > target 自己最大 seq（没有则 0）的消息，按 seq 升序。
 */
export function computeDelta(messages, targetMemberId) {
  const list = Array.isArray(messages) ? messages : [];
  let lastOwnSeq = 0;
  for (const m of list) {
    if (m && m.memberId === targetMemberId && m.seq > lastOwnSeq) {
      lastOwnSeq = m.seq;
    }
  }
  return list
    .filter((m) => m && m.memberId !== targetMemberId && m.seq > lastOwnSeq)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * 发言后推进会话状态。round 按发言次数计数：每次发言 +1。
 * 达到 maxRounds 自动结束。
 * @returns {{ session: object, ended: boolean, reason: string|null }}
 */
export function reduceSay(session, { nextMemberId }, maxRounds) {
  const round = (session.round || 0) + 1;
  const cap = Number(maxRounds || session.maxRounds || 0);
  const hitCap = cap > 0 && round >= cap;
  return {
    session: {
      ...session,
      round,
      currentMemberId: hitCap ? session.currentMemberId : nextMemberId,
      status: hitCap ? "ended" : "running",
    },
    ended: hitCap,
    reason: hitCap ? "maxRounds" : null,
  };
}

/** 结束会话（host end / 强制结束）。round 仍 +1 计入本条收尾发言。 */
export function reduceEnd(session) {
  return { ...session, round: (session.round || 0) + 1, status: "ended" };
}

/** 计算下一条消息的 seq（按 session 单调递增）。 */
export function nextSeq(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let max = 0;
  for (const m of list) {
    if (m && m.seq > max) max = m.seq;
  }
  return max + 1;
}

/**
 * 校验「用户反馈驱动的派生讨论」（§9.3 / 决策11）。
 * 拒绝：父 session 不存在 / 未结束；反馈为空；父 session 已被派生过（保证线性链 + 防重复点击/并发）。
 * @param {{ parentSession: object|null, feedback: string, existingChild: boolean }} args
 * @returns {{ ok: boolean, code?: string, error?: string }}
 */
export function validateRevision({ parentSession, feedback, existingChild }) {
  if (!parentSession) {
    return { ok: false, code: "no_session", error: "父话题讨论不存在" };
  }
  if (parentSession.status !== "ended") {
    return {
      ok: false,
      code: "not_ended",
      error: `父话题讨论当前状态为 ${parentSession.status}，只能从已结束的讨论继续`,
    };
  }
  if (!String(feedback || "").trim()) {
    return { ok: false, code: "empty_feedback", error: "请先填写你的意见" };
  }
  if (existingChild) {
    return {
      ok: false,
      code: "already_revised",
      error: "该轮讨论已派生过新一轮，只能从最新一轮继续",
    };
  }
  return { ok: true };
}

/** 计算派生轮次号：首轮无 revisionNo 视为 1，派生轮在此基础上 +1。 */
export function deriveRevisionNo(parentSession) {
  const base = Number(parentSession && parentSession.revisionNo) || 1;
  return base + 1;
}
