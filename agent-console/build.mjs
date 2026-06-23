#!/usr/bin/env node
// build.mjs —— 构建 Agent Console 的自包含独立产物（standalone package）。
//
//   node build.mjs [选项]
//     --out <dir>      产物目录，默认 release/
//     --no-install     跳过在产物目录内执行 npm install --omit=dev
//     --tar            额外打成 <out>.tar.gz
//     --skip-frontend  跳过 vite 前端构建（复用现有 dist/，用于快速迭代）
//
// 产物内容：
//   <out>/server.mjs      已打包的后端入口（NODE_ENV=production node server.mjs）
//   <out>/bin/acg.mjs     已打包的 acg CLI 入口
//   <out>/dist/           vite 构建出的前端静态资源
//   <out>/package.json    精简后的生产 package.json（仅保留运行期依赖）
//   <out>/.npmrc          本地缓存配置（沿用源仓库的 .npm-cache）
//   <out>/README.md       运行说明
//
// 注意：node-pty 是原生插件，按平台/Node 版本编译，无法跨平台拷贝。
// 因此本脚本产出的是“当前平台的独立包”：默认在产物目录内 npm install 以编译 node-pty；
// 若用 --no-install 拷贝到其它平台，接收方需在目标机执行一次 `npm install --omit=dev`。

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(__dirname, "package.json"), "utf8"));

// 运行期真正需要、且不应被打进 bundle 的依赖：
//   node-pty —— 原生插件，必须保持外部并在目标平台安装/编译。
//   @anthropic-ai/claude-agent-sdk —— 仅模型发现时按需 import()，体积大且可选，保持外部。
// 其余（ws 等纯 JS 依赖）全部内联进 bundle。
const RUNTIME_DEPS = ["node-pty", "@anthropic-ai/claude-agent-sdk"];
// vite 仅开发态使用（server.mjs 已改为动态 import），生产包不需要。
const EXTERNAL = [...RUNTIME_DEPS, "vite"];

function parseArgs(argv) {
  const opts = { out: "release", install: true, tar: false, skipFrontend: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--no-install") opts.install = false;
    else if (a === "--tar") opts.tar = true;
    else if (a === "--skip-frontend") opts.skipFrontend = true;
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

function log(step, msg) {
  console.log(`\x1b[36m[build:${step}]\x1b[0m ${msg}`);
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} 退出码 ${code}`)),
    );
  });
}

async function copyDir(src, dest) {
  await fs.cp(src, dest, { recursive: true });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(__dirname, opts.out);

  log("clean", `清理产物目录 ${path.relative(__dirname, outDir) || outDir}`);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(path.join(outDir, "bin"), { recursive: true });

  // 1) 前端：vite build → dist/
  if (opts.skipFrontend) {
    log("frontend", "跳过前端构建，复用现有 dist/");
  } else {
    log("frontend", "vite build → dist/");
    await viteBuild({ root: __dirname, logLevel: "warn" });
  }
  const distSrc = path.join(__dirname, "dist");
  try {
    await fs.access(distSrc);
  } catch {
    throw new Error(`未找到 dist/（${distSrc}）；请勿配合空目录使用 --skip-frontend。`);
  }

  // 2) 后端 + CLI：esbuild 打包，仅保留原生/可选依赖为外部。
  log("bundle", `esbuild 打包 server.mjs + bin/acg.mjs（external: ${EXTERNAL.join(", ")}）`);
  await esbuild({
    entryPoints: {
      server: path.join(__dirname, "server.mjs"),
      "bin/acg": path.join(__dirname, "bin", "acg.mjs"),
    },
    outdir: outDir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // 输出 .mjs，匹配 package.json 的 start/bin 及 acg.mjs 内对 ../server.mjs 的动态 import。
    outExtension: { ".js": ".mjs" },
    external: EXTERNAL,
    banner: {
      // 兼容 bundle 内可能出现的 CJS 互操作（require / __dirname）。
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    legalComments: "none",
    logLevel: "warning",
  });

  // 3) 前端静态资源
  log("copy", "拷贝 dist/ → 产物目录");
  await copyDir(distSrc, path.join(outDir, "dist"));

  // 4) 精简版生产 package.json
  log("manifest", "写入精简 package.json");
  const outPkg = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    type: "module",
    bin: { acg: "bin/acg.mjs" },
    scripts: {
      // 独立包无前端源码/vite，必须以生产态运行（serveStatic 提供 dist/）。
      start: "NODE_ENV=production node server.mjs",
      serve: "NODE_ENV=production node bin/acg.mjs serve",
    },
    dependencies: Object.fromEntries(
      RUNTIME_DEPS.filter((d) => pkg.dependencies[d]).map((d) => [d, pkg.dependencies[d]]),
    ),
  };
  await fs.writeFile(path.join(outDir, "package.json"), JSON.stringify(outPkg, null, 2) + "\n");

  // .npmrc：沿用本地缓存目录，避免污染全局 ~/.npm。
  await fs.writeFile(
    path.join(outDir, ".npmrc"),
    `cache=${path.join(__dirname, ".npm-cache")}\nfund=false\naudit=false\n`,
  );

  // README：运行说明（中文，符合仓库约定）。
  await fs.writeFile(
    path.join(outDir, "README.md"),
    [
      `# ${pkg.name}（独立运行包 v${pkg.version}）`,
      "",
      "自包含的 Agent Console 生产包。已内联前端与后端，仅 `node-pty`（原生）及可选的",
      "`@anthropic-ai/claude-agent-sdk` 为外部依赖。",
      "",
      "## 运行",
      "",
      "```bash",
      "# 若产物未带 node_modules（构建时用了 --no-install，或拷贝到了其它平台）：",
      "npm install --omit=dev",
      "",
      "# 启动（默认 http://127.0.0.1:5173，可用 PORT / HOST 覆盖）：",
      "npm start",
      "# 或：node server.mjs   /   npx acg serve",
      "```",
      "",
      "## 跨平台说明",
      "",
      "`node-pty` 是按平台、按 Node 版本编译的原生插件，**不能跨平台直接拷贝**。",
      "迁移到不同操作系统或 Node 大版本时，请在目标机重新执行 `npm install --omit=dev`。",
      "",
    ].join("\n"),
  );

  // 5) 安装运行期依赖（编译 node-pty）
  if (opts.install) {
    log("install", "在产物目录内 npm install --omit=dev（编译 node-pty）");
    await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], outDir);
  } else {
    log("install", "跳过依赖安装（--no-install）；目标机需自行 npm install --omit=dev");
  }

  // 6) 打包 tar.gz
  if (opts.tar) {
    const tarName = `${path.basename(outDir)}.tar.gz`;
    log("tar", `打包 → ${tarName}`);
    await run("tar", ["czf", tarName, "-C", path.dirname(outDir), path.basename(outDir)], __dirname);
  }

  log("done", `完成：${outDir}`);
  console.log(
    `\n下一步：cd ${path.relative(process.cwd(), outDir) || outDir}${opts.install ? "" : " && npm install --omit=dev"} && npm start`,
  );
}

main().catch((err) => {
  console.error(`\x1b[31m[build] 失败：\x1b[0m ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
