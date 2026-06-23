#!/usr/bin/env node
// acg —— Agent Console 的统一入口与讨论 CLI。
//   acg serve                              启动 web server（替代 node server.mjs）
//   acg say --next <成员名> "内容"          提交发言并把发言权交给下一位（内容也可走 stdin）
//   acg end ["收尾"]                        仅主理人：提交收尾并结束讨论
//   acg whoami                             打印当前讨论身份（调试）
//   acg recap                              请求 server 回灌一份讨论摘要
//
// say/end/recap/whoami 由成员 PTY 内的 agent 调用，身份通过 server 注入的环境变量传递。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAcgArgs, readIdentityFromEnv } from "../server/cli-args.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  return { ok: res.ok, status: res.status, json };
}

async function main() {
  const parsed = parseAcgArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`acg: ${parsed.error}`);
    process.exit(2);
  }

  if (parsed.cmd === "serve") {
    // 作为已安装 CLI 运行时默认走生产态：serveStatic 提供构建好的 dist/，无需 vite。
    // （开发用 `npm run dev`，不经此路径。）显式设了 NODE_ENV 则尊重之。
    if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
    // 启动应用 server（server.mjs 自带顶层 listen）。
    await import(path.join(__dirname, "..", "server.mjs"));
    return;
  }

  const id = readIdentityFromEnv(process.env);

  if (parsed.cmd === "whoami") {
    console.log(JSON.stringify(id, null, 2));
    return;
  }

  // ---- 流程运行：acg stage / acg run ----
  if (parsed.cmd === "stage" || parsed.cmd === "run") {
    if (!id.runId) {
      console.error("acg: 未检测到流程运行身份（AGENT_CONSOLE_RUN_ID）。该命令应在流程运行角色执行会话内调用。");
      process.exit(2);
    }
    await runWorkflowCommand(parsed, id);
    return;
  }

  if (!id.sessionId || !id.memberId) {
    console.error("acg: 未检测到讨论身份（AGENT_CONSOLE_SESSION_ID / MEMBER_ID）。该命令应在讨论组成员会话内调用。");
    process.exit(2);
  }

  if (parsed.cmd === "recap") {
    const res = await fetch(`${id.api}/api/sessions/${id.sessionId}/recap`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`acg: 获取摘要失败：${json.error || res.status}`);
      process.exit(1);
    }
    console.log(json.recap || "");
    return;
  }

  // say / end 的内容：优先命令行，其次 stdin
  let content = parsed.content;
  if (content === undefined) content = await readStdin();

  if (parsed.cmd === "say") {
    const { ok, status, json } = await postJson(
      `${id.api}/api/sessions/${id.sessionId}/members/${id.memberId}/say`,
      { content, next: parsed.next },
    );
    if (!ok) {
      console.error(`acg: 发言被拒绝（${status}）：${json.error || "未知错误"}`);
      process.exit(1);
    }
    if (json.ended) {
      console.log(json.message || "讨论已结束。");
    } else if (json.warning) {
      console.log(`已记录发言。注意：${json.warning}`);
    } else {
      console.log(`已记录发言，发言权已交给 ${parsed.next}。`);
    }
    return;
  }

  if (parsed.cmd === "end") {
    const { ok, status, json } = await postJson(
      `${id.api}/api/sessions/${id.sessionId}/members/${id.memberId}/end`,
      { content },
    );
    if (!ok) {
      console.error(`acg: 结束被拒绝（${status}）：${json.error || "未知错误"}`);
      process.exit(1);
    }
    console.log("讨论已结束。");
    return;
  }
}

// ---- 流程运行命令实现 ----

async function runWorkflowCommand(parsed, id) {
  const base = `${id.api}/api/workflow/runs/${id.runId}`;

  if (parsed.cmd === "run") {
    if (parsed.sub === "status") {
      const res = await fetch(base);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(`acg: 查询运行失败：${json.error || res.status}`);
        process.exit(1);
      }
      const tasks = (json.tasks || []).map((t) => `  - ${t.id} ${t.title} [${t.status}]`).join("\n");
      console.log(`运行 ${json.run.id}：状态=${json.run.status} 当前任务=${json.run.currentTaskId || "(无)"}\n任务：\n${tasks}`);
      return;
    }
    if (parsed.sub === "pause" || parsed.sub === "resume") {
      const { ok, status, json } = await postJson(`${base}/${parsed.sub}`, {});
      if (!ok) {
        console.error(`acg: ${parsed.sub} 失败（${status}）：${json.error || "未知错误"}`);
        process.exit(1);
      }
      console.log(parsed.sub === "pause" ? "已请求安全暂停。" : "已恢复运行。");
      return;
    }
    if (parsed.sub === "attention") {
      const { ok, json } = await postJson(`${base}/pause`, {});
      if (!ok) {
        console.error(`acg: 请求人工处理失败：${json.error || "未知错误"}`);
        process.exit(1);
      }
      console.log("已请求转人工处理（运行已暂停）。");
      return;
    }
  }

  if (parsed.cmd === "stage") {
    if (parsed.sub === "context") {
      const res = await fetch(base);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(`acg: 获取上下文失败：${json.error || res.status}`);
        process.exit(1);
      }
      const task = (json.tasks || []).find((t) => t.id === id.taskId);
      console.log(JSON.stringify({ run: json.run, task, stageId: id.stageId, roleId: id.roleId }, null, 2));
      return;
    }

    // submit：读取 JSON 负载（--json 文件 / stdin）。
    let payloadText = "";
    if (parsed.json && parsed.json !== "-") {
      payloadText = fs.readFileSync(parsed.json, "utf8");
    } else {
      payloadText = await readStdin();
    }
    let payload = {};
    if (payloadText.trim()) {
      try {
        payload = JSON.parse(payloadText);
      } catch (err) {
        console.error(`acg: 阶段结果 JSON 解析失败：${err.message}`);
        process.exit(2);
      }
    }
    const { ok, status, json } = await postJson(`${base}/stage`, {
      type: parsed.type,
      taskId: parsed.task || id.taskId,
      roleId: parsed.role || id.roleId,
      payload,
    });
    if (!ok) {
      console.error(`acg: 阶段结果被拒绝（${status}）：${json.error || "未知错误"}`);
      process.exit(1);
    }
    if (json.needsAttention) console.log(json.message || "已转人工处理。");
    else if (json.committed) console.log("任务已通过并提交，进入下一任务。");
    else if (json.bounced) console.log(`已退回开发修改${json.lastRoundWarning ? "（即将到达重试上限，请注意）" : ""}。`);
    else if (json.advanced) console.log(`已进入下一阶段：${json.nextStage}。`);
    else console.log("阶段结果已记录。");
    return;
  }
}

main().catch((err) => {
  console.error(`acg: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
