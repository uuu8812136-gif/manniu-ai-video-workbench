const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const version = require(path.join(projectRoot, "package.json")).version;
const development = process.argv.includes("--development");
const outputArgument = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const executablePath = development
  ? path.join(projectRoot, "node_modules", ".pnpm", "electron@43.2.0", "node_modules", "electron", "dist", "electron.exe")
  : path.join(projectRoot, "dist", "win-unpacked", "ai-tool.exe");
const outputPath = path.resolve(outputArgument || path.join(
  projectRoot,
  "dist",
  development ? `UI-PARITY-AUDIT-${version}-development.json` : `UI-PARITY-AUDIT-${version}.json`,
));

if (!fs.existsSync(executablePath)) throw new Error(`Packaged executable not found: ${executablePath}`);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const auditRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tool-ui-audit-"));
  const networkLogPath = path.join(auditRoot, "network-guard.jsonl");
  const port = await availablePort();
  const launchArguments = [
    ...(development ? [projectRoot] : []),
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    ...(development ? [`--user-data-dir=${path.join(auditRoot, "development-user-data")}`] : []),
  ];
  const child = spawn(executablePath, launchArguments, {
    cwd: development ? projectRoot : path.dirname(executablePath),
    env: {
      ...process.env,
      PORTABLE_EXECUTABLE_DIR: auditRoot,
      AI_TOOL_TEST_BLOCK_EXTERNAL_NETWORK: "1",
      AI_TOOL_TEST_NETWORK_LOG: networkLogPath,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  let exit = null;
  child.once("exit", (code, signal) => { exit = { code, signal }; });

  try {
    const page = await waitForRenderer(port, () => exit);
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    try {
      await waitForOfflineApi(cdp);
      const result = await evaluate(cdp, `
        (async () => {
          const auditRoot = ${JSON.stringify(auditRoot)};
          const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
          const normalize = (value) => String(value ?? "").replace(/\\s+/gu, " ").trim();
          const text = () => normalize(document.body.innerText);
          const clickText = async (label, selector = "button") => {
            const element = [...document.querySelectorAll(selector)].find((item) => normalize(item.textContent) === label || item.title === label);
            if (!element) {
              const available = [...document.querySelectorAll(selector)].map((item) => normalize(item.textContent) || item.title).filter(Boolean);
              throw new Error("UI element not found: " + label + "; page=" + text() + "; available=" + available.join(" | "));
            }
            element.click();
            await delay(120);
          };
          const clickContains = async (label, selector = "button") => {
            const element = [...document.querySelectorAll(selector)].find((item) => normalize(item.textContent).includes(label));
            if (!element) throw new Error("UI element containing text not found: " + label + "; page=" + text());
            element.click();
            await delay(120);
          };
          const setInputValue = (element, value) => {
            const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
            element.dispatchEvent(new Event("input", { bubbles: true }));
          };
          const waitForText = async (value, timeoutMs = 5_000) => {
            const deadline = Date.now() + timeoutMs;
            while (!text().includes(value) && Date.now() < deadline) await delay(80);
            if (!text().includes(value)) throw new Error("UI text did not appear: " + value + "; page=" + text());
          };
          const waitForFieldValue = async (value, timeoutMs = 5_000) => {
            const deadline = Date.now() + timeoutMs;
            const hasValue = () => [...document.querySelectorAll("input, textarea")].some((element) => element.value === value);
            while (!hasValue() && Date.now() < deadline) await delay(80);
            if (!hasValue()) throw new Error("UI field value did not appear: " + value + "; page=" + text());
          };
          const selectOption = async (label, timeoutMs = 5_000) => {
            const deadline = Date.now() + timeoutMs;
            let match = null;
            while (!match && Date.now() < deadline) {
              for (const element of document.querySelectorAll("select")) {
                const option = [...element.options].find((item) => normalize(item.textContent) === label);
                if (option) { match = { element, option }; break; }
              }
              if (!match) await delay(80);
            }
            if (!match) throw new Error("UI select option did not appear: " + label + "; page=" + text());
            match.element.value = match.option.value;
            match.element.dispatchEvent(new Event("change", { bubbles: true }));
            await delay(120);
          };
          const waitForJob = async (id) => {
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
              const job = (await window.offline.jobs.list()).find((item) => item.id === id);
              if (job && !["queued", "running"].includes(job.status)) return job;
              await delay(80);
            }
            throw new Error("Workflow job did not settle: " + id);
          };
          const snapshot = (name) => ({
            name,
            route: window.location.hash,
            text: text(),
            buttons: [...document.querySelectorAll("button")].map((element) => ({
              text: normalize(element.textContent),
              title: element.title || "",
              disabled: element.disabled,
            })),
            fields: [...document.querySelectorAll("input, textarea, select")].map((element) => ({
              tag: element.tagName.toLowerCase(),
              type: element.type || "",
              value: element.type === "password" ? (element.value ? "[configured]" : "") : element.value,
              placeholder: element.placeholder || "",
              checked: element.type === "checkbox" ? element.checked : undefined,
              disabled: element.disabled,
              readOnly: element.readOnly,
              options: element.tagName === "SELECT" ? [...element.options].map((option) => normalize(option.textContent)) : undefined,
            })),
          });
          const pages = [];

          const readyDeadline = Date.now() + 10_000;
          while (!text().includes("创作项目") && Date.now() < readyDeadline) await delay(100);
          if (!text().includes("创作项目")) throw new Error("React UI did not reach the project list: " + text());

          pages.push(snapshot("创作-列表"));
          await clickText("新建项目");
          pages.push(snapshot("创作-新建项目-原版模式"));
          await clickText("高级模式");
          pages.push(snapshot("创作-新建项目-高级模式"));
          const projectNameInput = [...document.querySelectorAll("input")].find((element) => element.placeholder === "输入项目名称");
          if (!projectNameInput) throw new Error("Project name input not found");
          setInputValue(projectNameInput, "UI 动态验收");
          await delay(80);
          await clickText("创建并进入");
          await waitForText("角色与场景资产");
          pages.push(snapshot("项目详情-空态"));

          const createdProject = (await window.offline.projects.list()).find((project) => project.name === "UI 动态验收");
          if (!createdProject) throw new Error("Created project was not persisted");
          await window.offline.characterProfiles.replace(createdProject.id, [
            { name: "林川", aliases: ["阿川"], identity: "男主角", gender: "男", age: "青年", appearance: "清俊面容", hair: "黑色短发", clothing: "深色风衣", personality: "沉静", visualPrompt: "青年男性，清俊面容，黑色短发，深色风衣，沉静克制", assetType: "character" },
            { name: "雨夜车站", aliases: ["车站"], visualPrompt: "湿润站台，冷色灯光与远处列车", assetType: "scene" },
          ]);
          await window.offline.storyboards.replace(createdProject.id, [
            { index: 0, originalText: "林川在雨夜走入车站。", subjects: ["林川", "雨夜车站", "未推理角色"], prompt: "中景，@林川 与 @未推理角色 走入 @雨夜车站，冷色电影光", duration: 4 },
          ]);
          await clickText("创作");
          await clickContains("UI 动态验收");
          await waitForText("角色与场景资产 (3)");
          await waitForText("待补设定");
          const firstProfileSummary = document.querySelector(".character-profile-list details summary");
          if (!firstProfileSummary) throw new Error("Character profile expander not found");
          firstProfileSummary.click();
          await delay(80);
          await waitForText("青年男性，清俊面容");
          await clickText("项目工具", "summary");
          pages.push(snapshot("项目详情-角色分镜与剪映"));
          await clickText("批量修改");
          pages.push(snapshot("项目详情-批量修改"));

          await clickText("批量");
          pages.push(snapshot("批量"));
          await clickContains("底层任务");
          pages.push(snapshot("批量-底层任务"));
          await clickText("项目队列");

          await clickText("开头");
          pages.push(snapshot("开头-通用版-QQ阅读"));
          await clickText("增强版");
          await clickText("文件");
          pages.push(snapshot("开头-增强版-文件"));
          await clickText("粘贴");
          pages.push(snapshot("开头-增强版-粘贴"));
          const openingJob = await window.offline.jobs.enqueue("opening.optimize", {
            text: "审计开头恢复文案",
            title: "开头恢复测试",
            mode: "enhanced",
            outDir: auditRoot,
          });
          await waitForJob(openingJob.id);
          await clickText("批量");
          await clickText("开头");
          await waitForFieldValue("审计开头恢复文案");
          pages.push(snapshot("开头-失败任务恢复"));

          await clickText("捋文");
          pages.push(snapshot("捋文-原版模式"));
          await clickText("高级模式");
          pages.push(snapshot("捋文-高级模式"));
          const polishJob = await window.offline.jobs.enqueue("text.polish", {
            text: "审计捋文恢复文案",
            title: "捋文恢复测试",
            mode: "advanced",
            sourceFormat: "txt",
            outDir: auditRoot,
          });
          await waitForJob(polishJob.id);
          await clickText("批量");
          await clickText("捋文");
          await waitForFieldValue("审计捋文恢复文案");
          pages.push(snapshot("捋文-失败任务恢复"));

          await clickText("推理");
          pages.push(snapshot("推理"));

          await clickText("生图");
          pages.push(snapshot("生图"));
          const imageJob = await window.offline.jobs.enqueue("image.standalone", {
            name: "恢复卡片",
            prompt: "雨夜车站中的青年",
            batchName: "ui-recovery-batch",
            workbenchKey: "ui-recovery-card",
            model: "gpt-image-2",
            count: 1,
            aspectRatio: "16:9",
            outputDirectory: auditRoot,
          });
          await waitForJob(imageJob.id);
          await clickText("批量");
          await clickText("生图");
          await waitForText("恢复卡片");
          pages.push(snapshot("生图-失败任务恢复"));

          await clickText("视频");
          pages.push(snapshot("视频-自定义API"));

          await window.offline.settings.set("video_provider", "vidu-browser");
          await clickText("创作");
          await clickText("视频");
          await selectOption("UI 动态验收");
          await waitForText("当前没有可用的 Vidu 账号");
          pages.push(snapshot("视频-Vidu无账号"));

          await clickText("设置");
          pages.push(snapshot("设置-浏览器账号"));
          for (const label of ["项目文件夹", "开头优化", "捋文设置", "推理设置", "出图设置", "剪映路径", "通知设置"]) {
            await clickText(label);
            pages.push(snapshot("设置-" + label));
          }
          await clickText("浏览器账号");
          await clickText("添加账号");
          pages.push(snapshot("设置-添加浏览器账号"));
          await clickText("批量 JWT");
          pages.push(snapshot("设置-批量JWT"));
          await clickText("单个添加");
          await clickText("取消");

          await clickText("关于软件");
          pages.push(snapshot("关于"));
          await clickText("使用文档");
          await waitForText("创作与批量");
          pages.push(snapshot("关于-使用文档"));
          await clickText("新手教程");
          await waitForText("首次使用流程");
          pages.push(snapshot("关于-新手教程"));
          await clickText("检查更新");
          await waitForText("源码部署版");
          pages.push(snapshot("关于-检查更新"));
          await clickText("重新检测");
          await delay(200);
          pages.push(snapshot("关于-诊断完成"));

          const requiredText = {
            "创作-列表": ["创作项目", "新建项目"],
            "创作-新建项目-原版模式": ["新建项目", "原版模式", "高级模式", "项目根目录", "字幕文件 *", "旁白音频 *"],
            "创作-新建项目-高级模式": ["新建项目", "高级模式", "项目目录", "自动创建"],
            "项目详情-空态": ["角色与场景资产", "尚未生成角色表", "导入 CSV", "导出到剪映"],
            "项目详情-角色分镜与剪映": ["林川", "雨夜车站", "未推理角色", "待补设定", "青年男性，清俊面容", "项目目录", "更改目录", "导出到剪映", "Vidu Q3"],
            "项目详情-批量修改": ["修改范围", "已选择", "全部可编辑", "待生成与失败", "查找提示词", "统一时长", "确认修改"],
            "批量": ["批量执行", "项目队列", "开始队列"],
            "批量-底层任务": ["批量执行", "底层任务", "全部状态"],
            "开头-通用版-QQ阅读": ["开头优化", "通用版", "增强版", "QQ 阅读链接"],
            "开头-增强版-文件": ["开头优化", "增强版", "文件", "选择 TXT/DOCX"],
            "开头-增强版-粘贴": ["开头优化", "增强版", "粘贴", "输入文案"],
            "开头-失败任务恢复": ["待修复", "重试"],
            "捋文-原版模式": ["捋文", "原版模式", "高级模式", "选择 TXT"],
            "捋文-高级模式": ["捋文", "高级模式", "选择 TXT/DOCX"],
            "捋文-失败任务恢复": ["待修复", "重试"],
            "推理": ["小说转分镜", "题材", "开始生成"],
            "生图": ["批量出图", "提示词批次", "参考图", "独立生成结果"],
            "生图-失败任务恢复": ["恢复卡片", "失败"],
            "视频-自定义API": ["视频生成", "自定义 API", "生成缺失视频", "UI 动态验收"],
            "视频-Vidu无账号": ["当前没有可用的 Vidu 账号", "Vidu Q3", "使用积分"],
            "设置-浏览器账号": ["浏览器账号", "添加账号", "还没有 Vidu 浏览器账号"],
            "设置-添加浏览器账号": ["单个添加", "批量 JWT", "会员账号", "积分账号"],
            "设置-批量JWT": ["批量 JWT", "积分账号 JWT", "SSUID", "开始导入"],
            "设置-项目文件夹": ["项目文件夹"],
            "设置-开头优化": ["开头优化"],
            "设置-捋文设置": ["捋文设置"],
            "设置-推理设置": ["推理设置"],
            "设置-出图设置": ["出图设置"],
            "设置-剪映路径": ["剪映路径"],
            "设置-通知设置": ["通知设置"],
            "关于": ["AI工具", "版本", "使用文档", "新手教程", "反馈问题", "检查更新"],
            "关于-使用文档": ["使用文档", "创作与批量", "文本与生图", "模型与 Vidu", "数据与备份"],
            "关于-新手教程": ["首次使用流程", "配置模型", "准备账号", "创建项目", "生成与导出"],
            "关于-检查更新": ["源码部署版", "新版安装包直接覆盖", "现有本地数据会保留"],
            "关于-诊断完成": ["重新检测", "SQLite", "运行环境正常"],
          };
          const failures = [];
          for (const [name, needles] of Object.entries(requiredText)) {
            const page = pages.find((item) => item.name === name);
            if (!page) failures.push(name + ": snapshot missing");
            else for (const needle of needles) if (!page.text.includes(needle)) failures.push(name + ": missing " + needle);
          }
          const requiredFieldValues = {
            "开头-失败任务恢复": ["审计开头恢复文案", "开头恢复测试"],
            "捋文-失败任务恢复": ["审计捋文恢复文案", "捋文恢复测试"],
          };
          for (const [name, values] of Object.entries(requiredFieldValues)) {
            const page = pages.find((item) => item.name === name);
            if (!page) failures.push(name + ": snapshot missing");
            else for (const value of values) if (!page.fields.some((field) => field.value === value)) failures.push(name + ": missing field value " + value);
          }
          const requiredFieldPlaceholders = {
            "设置-批量JWT": ["每行一个 JWT"],
          };
          for (const [name, placeholders] of Object.entries(requiredFieldPlaceholders)) {
            const page = pages.find((item) => item.name === name);
            if (!page) failures.push(name + ": snapshot missing");
            else for (const placeholder of placeholders) if (!page.fields.some((field) => field.placeholder === placeholder)) failures.push(name + ": missing field placeholder " + placeholder);
          }
          const projectDetailPage = pages.find((item) => item.name === "项目详情-角色分镜与剪映");
          if (!projectDetailPage?.buttons.some((button) => button.title === "打开资产图文件夹")) {
            failures.push("项目详情-角色分镜与剪映: missing asset directory button");
          }
          return { pages, failures, projectFolderPath: createdProject.folderPath };
        })()
      `);

      if (!fs.existsSync(path.join(result.projectFolderPath, "资产图"))) {
        result.failures.push("项目详情-角色分镜与剪映: asset directory missing on disk");
      }

      const networkEvents = fs.existsSync(networkLogPath)
        ? fs.readFileSync(networkLogPath, "utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
        : [];
      const audit = {
        status: result.failures.length === 0 ? "ok" : "failed",
        generatedAt: new Date().toISOString(),
        target: development ? "development-build" : "packaged-win-unpacked",
        executablePath,
        isolatedDataRoot: auditRoot,
        networkGuardActive: networkEvents.some((event) => event.event === "active"),
        blockedExternalRequests: networkEvents.filter((event) => event.event === "blocked"),
        failures: result.failures,
        pages: result.pages,
      };
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({
        status: audit.status,
        outputPath,
        pageSnapshots: audit.pages.length,
        failures: audit.failures,
        networkGuardActive: audit.networkGuardActive,
        blockedExternalRequests: audit.blockedExternalRequests.length,
      }, null, 2));
      if (audit.failures.length > 0) process.exitCode = 1;
    } finally {
      cdp.close();
    }
  } finally {
    if (child.pid && exit === null) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
    await delay(500);
    fs.rmSync(auditRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForRenderer(port, currentExit) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const exit = currentExit();
    if (exit) throw new Error(`Packaged app exited during startup: ${JSON.stringify(exit)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await delay(150);
  }
  throw new Error("Timed out waiting for packaged renderer DevTools endpoint");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Unable to connect to packaged renderer CDP")), { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  return {
    call(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function waitForOfflineApi(cdp) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await cdp.call("Runtime.evaluate", {
      expression: "typeof window.offline?.projects?.create === 'function'",
      returnByValue: true,
    });
    if (result.result?.value === true) return;
    await delay(100);
  }
  throw new Error("Packaged preload API was not exposed");
}

async function evaluate(cdp, expression) {
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(detail || "Renderer evaluation failed");
  }
  return result.result.value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
