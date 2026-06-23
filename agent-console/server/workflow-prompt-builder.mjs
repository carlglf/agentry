// 流程运行各阶段提示词构造（纯字符串，无 I/O，PRD §5.4/§7.3）。
// 每次交接只注入当前阶段所需信息，按当前任务 + 依赖交接产物裁剪，不回灌完整历史。

// 各阶段统一的 CLI 提交说明（acg stage 系列）。
export const STAGE_CLI_HINT = [
  "完成本阶段后，请用 CLI 提交结构化阶段结果（流程引擎据此决定下一步）：",
  "  acg stage submit --type <dev|review|test|doc|integration> --json -   # JSON 走 stdin",
  "也可：acg stage submit --type review --json result.json",
  "其它命令：acg stage context（回看本阶段上下文）、acg run status（查看运行进度）、acg run pause（请求安全暂停）。",
].join("\n");

/** 角色人格/职责前言：复用讨论组成员的 persona/duty，拼到阶段提示词最前。无内容则返回空串。 */
export function buildRolePreamble({ persona, duty } = {}) {
  const lines = [];
  if (persona) lines.push(`你的人设：${persona}`);
  if (duty) lines.push(`你的职责：${duty}`);
  return lines.length ? lines.join("\n") + "\n\n" : "";
}

function header(title, ctx) {
  const lines = [`【${title}】`, `总目标：${ctx.goal || "（未提供）"}`];
  if (ctx.baseBranch) lines.push(`目标分支：${ctx.baseBranch}`);
  if (ctx.integrationBaseline) lines.push(`集成基线：${ctx.integrationBaseline}`);
  return lines;
}

function taskBlock(task) {
  const lines = [
    `当前任务：${task.title || task.id}`,
    `任务目标：${task.objective || "（未提供）"}`,
  ];
  if (task.branch) lines.push(`任务分支：${task.branch}`);
  if (task.worktree) lines.push(`工作区(worktree)：${task.worktree}`);
  if ((task.scope || []).length) lines.push(`允许范围：\n${list(task.scope)}`);
  if ((task.forbiddenChanges || []).length) lines.push(`禁止改动：\n${list(task.forbiddenChanges)}`);
  if ((task.acceptanceCriteria || []).length) lines.push(`验收标准：\n${list(task.acceptanceCriteria)}`);
  if ((task.suggestedTests || []).length) lines.push(`建议测试：\n${list(task.suggestedTests)}`);
  if ((task.expectedFiles || []).length) lines.push(`预计涉及文件：${task.expectedFiles.join(", ")}`);
  return lines;
}

function dependencyBlock(handoffs) {
  if (!handoffs || handoffs.length === 0) return ["（无相关依赖任务交接）"];
  const lines = ["相关依赖任务的交接产物（仅必要信息）："];
  for (const h of handoffs) {
    lines.push(`- 任务 ${h.taskId}（commit ${h.commitSha || "?"}）：${h.changeSummary || ""}`);
    if ((h.changedInterfaces || []).length) lines.push(`  接口变化：${h.changedInterfaces.join(", ")}`);
    if ((h.decisions || []).length) lines.push(`  设计决策：${h.decisions.join("；")}`);
  }
  return lines;
}

function list(items) {
  return (items || []).map((s) => `  - ${s}`).join("\n");
}

/** 规划阶段：注入目标 + 仓库上下文，要求产出结构化任务。 */
export function buildPlanningPrompt({ goal, repositoryPath, baseBranch, stagePrompt, detectedTestCommand }) {
  const lines = [
    "【规划阶段】",
    `总目标：${goal || "（未提供）"}`,
    `仓库：${repositoryPath || ""}`,
    `目标分支：${baseBranch || ""}`,
  ];
  if (detectedTestCommand) lines.push(`探测到的测试命令：${detectedTestCommand}`);
  lines.push("");
  if (stagePrompt) lines.push(stagePrompt, "");
  lines.push(
    "请把目标拆解为有依赖关系的结构化子任务。每个子任务需包含：id、title、objective、scope[]、forbiddenChanges[]、dependencies[]、acceptanceCriteria[]、suggestedTests[]、expectedFiles[]。",
    "首版串行执行，请确保依赖关系无环、可串行完成。",
    "",
    "请用 CLI 提交计划：",
    '  acg stage submit --type plan --json -   # 负载为 { "tasks": [ ... ] }',
  );
  return lines.join("\n");
}

/** 开发阶段：注入裁剪后的当前任务上下文。 */
export function buildDevelopmentPrompt({ context, stagePrompt, isFix }) {
  const lines = [
    ...header(isFix ? "继续修改（同一任务）" : "开发阶段", context),
    "",
    ...taskBlock(context.task),
    "",
    ...dependencyBlock(context.dependencyHandoffs),
    "",
  ];
  if (stagePrompt) lines.push(stagePrompt, "");
  lines.push(
    "你只处理当前任务范围内的改动，完成后请自测。开发自检通过仅代表「可送审」，不代表任务完成。",
    "提交结果需包含：变更摘要、修改文件、自测命令与结果、已知限制、候选 diff/提交引用。",
    "",
    STAGE_CLI_HINT,
  );
  return lines.join("\n");
}

/** 退回开发的修复提示词：携带结构化 findings。 */
export function buildFixPrompt({ context, findings, round, repeatedFindingIds, stagePrompt }) {
  const lines = [
    ...header("修改循环（Review/测试退回）", context),
    "",
    `当前任务：${context.task.title || context.task.id}（第 ${round || "?"} 轮修改）`,
    "",
    "需要解决的问题：",
  ];
  for (const f of findings || []) {
    const repeated = (repeatedFindingIds || []).includes(f.id) ? "（⚠ 连续多轮未解决）" : "";
    const loc = f.file ? `${f.file}${f.line ? ":" + f.line : ""} ` : "";
    lines.push(`- [${f.severity || "issue"}] ${loc}${f.title || ""}${repeated}`);
    if (f.detail) lines.push(`    ${f.detail}`);
    if (f.suggestedFix) lines.push(`    建议修复：${f.suggestedFix}`);
  }
  lines.push("");
  if (stagePrompt) lines.push(stagePrompt, "");
  lines.push("请在当前任务分支上修复以上问题，不要扩大任务范围，完成后重新提交开发结果。", "", STAGE_CLI_HINT);
  return lines.join("\n");
}

/** Review 阶段：注入任务范围 + diff 摘要 + 验收标准 + 测试证据。 */
export function buildReviewPrompt({ context, diffSummary, changedFiles, devResult, stagePrompt }) {
  const lines = [
    ...header("Review 阶段", context),
    "",
    ...taskBlock(context.task),
    "",
  ];
  if (changedFiles && changedFiles.length) lines.push(`本次改动文件：${changedFiles.join(", ")}`);
  if (diffSummary) lines.push(`变更摘要：${diffSummary}`);
  if (devResult && devResult.selfTest) lines.push(`开发自测：${JSON.stringify(devResult.selfTest)}`);
  lines.push("");
  if (stagePrompt) lines.push(stagePrompt, "");
  lines.push(
    "只审查当前任务范围、diff、验收标准与测试证据，默认不直接改代码。",
    "提交结构化裁决：{ verdict: 'approved'|'changes_requested'|'failed', findings: [{ id, severity, file?, line?, title, detail, suggestedFix? }] }。",
    "",
    STAGE_CLI_HINT,
  );
  return lines.join("\n");
}

/** 测试阶段：注入验收标准 + 候选 diff + 允许的测试命令。 */
export function buildTestingPrompt({ context, allowedTestCommands, changedFiles, stagePrompt }) {
  const lines = [
    ...header("测试阶段", context),
    "",
    ...taskBlock(context.task),
    "",
  ];
  if (changedFiles && changedFiles.length) lines.push(`本次改动文件：${changedFiles.join(", ")}`);
  if (allowedTestCommands && allowedTestCommands.length) lines.push(`允许的测试命令：${allowedTestCommands.join(" / ")}`);
  lines.push("");
  if (stagePrompt) lines.push(stagePrompt, "");
  lines.push(
    "独立验证验收标准与回归风险，默认不改业务代码。禁止忽略失败测试。",
    "提交结构化结果：{ command, exitCode, passed, failed, summary, log }。",
    "",
    STAGE_CLI_HINT,
  );
  return lines.join("\n");
}

/** 最终集成阶段。 */
export function buildIntegrationPrompt({ goal, tasks, integrationMode, baseBranch, fullTestCommand, stagePrompt }) {
  const lines = [
    "【最终集成阶段】",
    `总目标：${goal || ""}`,
    `目标分支：${baseBranch || ""}`,
    `集成方式：${integrationMode === "direct_merge" ? "直接合并（需二次确认且非受保护分支）" : "创建 Pull Request"}`,
    `已完成任务数：${(tasks || []).length}`,
  ];
  if (fullTestCommand) lines.push(`全量测试命令：${fullTestCommand}`);
  lines.push("");
  if (stagePrompt) lines.push(stagePrompt, "");
  lines.push(
    "请执行：全量测试、未关闭 Review/测试问题检查、提交链完整性检查、目标分支漂移检查、最终变更摘要生成。",
    "存在全量测试失败、阻断级问题未关闭、提交链缺失或目标分支漂移时，禁止集成。",
    "提交结构化集成结果：{ fullTest: {...}, summary, unresolved: [...] }。",
    "",
    STAGE_CLI_HINT,
  );
  return lines.join("\n");
}
