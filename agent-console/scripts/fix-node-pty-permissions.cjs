#!/usr/bin/env node
/**
 * 修复 node-pty 的 spawn-helper 执行权限。
 *
 * 某些包管理器（npm/pnpm/yarn/bun）在安装时会丢掉原生二进制的可执行位，
 * 而 macOS/Linux 下 node-pty 启动 PTY 依赖 spawn-helper 有执行权限。
 * 用 require.resolve 定位 node-pty，兼容各包管理器布局。
 *
 * 作为 postinstall 钩子运行（参考 stoneforge/smithy 的同名脚本）。
 */

const { chmodSync, existsSync, readdirSync } = require("node:fs");
const { join, dirname } = require("node:path");

if (process.platform === "win32") {
  process.exit(0);
}

let nodePtyDir;
try {
  nodePtyDir = dirname(require.resolve("node-pty/package.json"));
} catch {
  // node-pty 未安装 —— 无需处理。
  process.exit(0);
}

let fixed = 0;

function fixHelper(helperPath) {
  if (!existsSync(helperPath)) return;
  try {
    chmodSync(helperPath, 0o755);
    fixed++;
    console.log(`[postinstall] 修复权限：${helperPath}`);
  } catch (err) {
    console.warn(`[postinstall] 无法修复 ${helperPath}：${err.message}`);
  }
}

// 1) 预编译多架构布局：prebuilds/<platform>-<arch>/spawn-helper
const prebuildsDir = join(nodePtyDir, "prebuilds");
if (existsSync(prebuildsDir)) {
  for (const entry of readdirSync(prebuildsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) fixHelper(join(prebuildsDir, entry.name, "spawn-helper"));
  }
}

// 2) 本机源码编译布局：build/Release/spawn-helper（部分平台本地构建时产出）
fixHelper(join(nodePtyDir, "build", "Release", "spawn-helper"));

if (fixed === 0) {
  console.log("[postinstall] 未发现需要修复的 spawn-helper（当前平台可能无需）。");
}
