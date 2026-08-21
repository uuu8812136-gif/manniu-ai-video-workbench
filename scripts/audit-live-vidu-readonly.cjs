const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(root, "..", "..");
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const positional = process.argv.slice(2).filter((value) => !value.startsWith("--"));
const developmentMode = process.argv.slice(2).includes("--development");
const loginOnly = process.argv.slice(2).includes("--login-only");
const jwtSessionArgument = process.argv.slice(2).find((value) => value.startsWith("--jwt-session="));
const jwtSessionPath = jwtSessionArgument ? path.resolve(jwtSessionArgument.slice("--jwt-session=".length)) : null;
const executable = developmentMode
  ? path.join(root, "node_modules", ".pnpm", "electron@43.2.0", "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "dist", "win-unpacked", "ai-tool.exe");
const reportSlug = developmentMode ? "current-source" : `packaged-${packageVersion}`;
const sourceUserData = path.resolve(positional[0] || path.join(workspaceRoot, "outputs", "ai-tool-data"));
const outputPath = path.resolve(positional[1] || path.join(root, "audit", "evidence", `live-vidu-readonly-${reportSlug}-2026-07-27.json`));
const markdownPath = path.resolve(positional[2] || path.join(root, "audit", `LIVE-VIDU-READONLY-${reportSlug.toUpperCase()}-2026-07-27.md`));

main().catch((error) => {
  console.error(redact(error instanceof Error ? error.stack || error.message : String(error)));
  process.exitCode = 1;
});

async function main() {
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);
  if (!fs.existsSync(path.join(sourceUserData, "ai-tool.db"))) throw new Error(`AI tool userData not found: ${sourceUserData}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-tool-vidu-readonly-"));
  const clonedUserData = path.join(tempRoot, "ai-tool-data");
  let child = null;
  let cdp = null;
  let childExit = null;
  try {
    fs.cpSync(sourceUserData, clonedUserData, {
      recursive: true,
      filter(source) {
        return !/[\\/](?:SingletonCookie|SingletonLock|SingletonSocket|DevToolsActivePort)$/u.test(source);
      },
    });

    const port = await availablePort();
    const launchArgs = [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
    ];
    if (developmentMode) {
      launchArgs.unshift(root);
      launchArgs.push(`--user-data-dir=${clonedUserData}`);
    }
    child = spawn(executable, launchArgs, {
      cwd: path.dirname(executable),
      env: {
        ...process.env,
        ...(developmentMode ? {} : { PORTABLE_EXECUTABLE_DIR: tempRoot }),
      },
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("exit", (code, signal) => { childExit = { code, signal }; });

    const mainTarget = await waitForTarget(port, (target) => target.type === "page" && !/vidu\.cn/i.test(target.url), () => childExit);
    cdp = await connectCdp(mainTarget.webSocketDebuggerUrl);
    await waitForOfflineApi(cdp);

    let requestedJwtCount = 0;
    let importedJwtCount = 0;
    let jwtImportResults = [];
    if (jwtSessionPath) {
      const tokens = readCurrentSessionJwts(jwtSessionPath);
      requestedJwtCount = tokens.length;
      const imported = await evaluate(
        cdp,
        `window.offline.vidu.importJwtAccounts({ tokens: ${JSON.stringify(tokens.join("\n"))} })`,
      );
      importedJwtCount = imported.results.filter((item) => item.status === "success").length;
      jwtImportResults = imported.results.map((item) => ({
        lineNumber: item.lineNumber,
        status: item.status,
        message: redact(item.message),
      }));
    }

    const accounts = await evaluate(cdp, `window.offline.vidu.listAccounts().then((items) => items.map((item, index) => ({
      index: index + 1,
      id: item.id,
      enabled: item.enabled,
      accountType: item.accountType,
      defaultQuota: item.defaultQuota,
      usageCount: item.usageCount,
      disabledReason: item.disabledReason || null
    })))`);

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: `${reportSlug}-cloned-userdata-readonly-remote`,
      executable: path.relative(root, executable),
      sourceUserData: "outputs/ai-tool-data",
      protections: {
        originalUserDataModified: false,
        videoSubmitted: false,
        subjectCreated: false,
        subjectDeleted: false,
        jwtOrCookiePersistedInReport: false,
        temporaryUserDataRemoved: false,
      },
      loginOnly,
      requestedJwtCount,
      importedJwtCount,
      jwtImportResults,
      accountCount: accounts.length,
      accounts: [],
    };

    for (const account of accounts) {
      const statusResult = await safeEvaluate(cdp, `window.offline.vidu.checkAccount(${JSON.stringify(account.id)})`);
      const status = statusResult.ok ? statusResult.value : null;
      const item = {
        accountIndex: account.index,
        enabled: Boolean(account.enabled),
        accountType: account.accountType,
        configuredQuota: account.defaultQuota,
        localUsageCount: account.usageCount,
        disabledReason: account.disabledReason,
        loginCheck: status
          ? {
              status: status.status,
              httpStatus: status.httpStatus,
              creditsReturned: Number.isFinite(status.availableCredits),
              availableCredits: Number.isFinite(status.availableCredits) ? status.availableCredits : null,
              error: null,
            }
          : {
              status: "error",
              httpStatus: null,
              creditsReturned: false,
              availableCredits: null,
              error: statusResult.error,
            },
        subjectLibrary: {
          attempted: false,
          copyReadCount: null,
          pages: [],
          pageCount: 0,
          subjectCount: null,
          complete: false,
          error: null,
        },
        taskPollProbe: {
          attempted: false,
          httpStatus: null,
          responded: false,
        },
        postWindowLoginCheck: null,
      };

      if (status?.status === "logged-in" && !loginOnly) {
        item.subjectLibrary.attempted = true;
        const copyResult = await safeEvaluate(cdp, `window.offline.vidu.copySubjectLibrary(${JSON.stringify(account.id)})`);
        if (copyResult.ok) item.subjectLibrary.copyReadCount = Number(copyResult.value?.count ?? 0);
        else item.subjectLibrary.error = copyResult.error;

        const viduTarget = await waitForTarget(port, (target) => target.type === "page" && /vidu\.cn\//i.test(target.url), () => childExit, 30_000).catch(() => null);
        if (viduTarget) {
          const viduCdp = await connectCdp(viduTarget.webSocketDebuggerUrl);
          try {
            const remote = await safeEvaluate(viduCdp, subjectAuditExpression());
            if (remote.ok) {
              item.subjectLibrary.pages = remote.value.pages;
              item.subjectLibrary.pageCount = remote.value.pages.length;
              item.subjectLibrary.subjectCount = remote.value.subjectCount;
              item.subjectLibrary.complete = remote.value.complete;
              item.subjectLibrary.creditsStatus = remote.value.creditsStatus;
              item.subjectLibrary.creditsReturned = remote.value.creditsReturned;
              item.subjectLibrary.remoteAvailableCredits = remote.value.availableCredits;
              if (remote.value.error) item.subjectLibrary.error = remote.value.error;
              item.taskPollProbe = {
                attempted: true,
                httpStatus: remote.value.taskPollStatus,
                responded: Number.isFinite(remote.value.taskPollStatus) && remote.value.taskPollStatus > 0,
              };
            } else if (!item.subjectLibrary.error) {
              item.subjectLibrary.error = remote.error;
            }
          } finally {
            viduCdp.close();
          }
        } else if (!item.subjectLibrary.error) {
          item.subjectLibrary.error = "Vidu hidden browser target was not available";
        }
        const postWindowStatus = await safeEvaluate(cdp, `window.offline.vidu.checkAccount(${JSON.stringify(account.id)})`);
        if (postWindowStatus.ok) {
          item.postWindowLoginCheck = {
            status: postWindowStatus.value.status,
            httpStatus: postWindowStatus.value.httpStatus,
            creditsReturned: Number.isFinite(postWindowStatus.value.availableCredits),
            availableCredits: Number.isFinite(postWindowStatus.value.availableCredits)
              ? postWindowStatus.value.availableCredits
              : null,
            error: null,
          };
        } else {
          item.postWindowLoginCheck = {
            status: "error",
            httpStatus: null,
            creditsReturned: false,
            availableCredits: null,
            error: postWindowStatus.error,
          };
        }
      }
      report.accounts.push(item);
    }

    report.summary = {
      configuredAccounts: report.accounts.length,
      enabledAccounts: report.accounts.filter((item) => item.enabled).length,
      loggedInAccounts: report.accounts.filter((item) => item.loginCheck.status === "logged-in").length,
      creditsReturnedAccounts: report.accounts.filter((item) => item.loginCheck.creditsReturned
        || item.postWindowLoginCheck?.creditsReturned
        || item.subjectLibrary.creditsReturned).length,
      subjectQueriesCompleted: report.accounts.filter((item) => item.subjectLibrary.complete).length,
      taskPollEndpointResponses: report.accounts.filter((item) => item.taskPollProbe.responded).length,
      totalSubjects: report.accounts.reduce((sum, item) => sum + (item.subjectLibrary.subjectCount ?? 0), 0),
      errors: report.accounts.flatMap((item) => [item.loginCheck.error, item.subjectLibrary.error].filter(Boolean)),
    };
    report.summary.errors.push(...jwtImportResults.filter((item) => item.status !== "success").map((item) => item.message));

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.writeFileSync(markdownPath, renderMarkdown(report), "utf8");
  } finally {
    cdp?.close();
    if (child?.pid && childExit === null) spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await delay(500);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }

  const report = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  report.protections.temporaryUserDataRemoved = true;
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, renderMarkdown(report), "utf8");
  console.log(JSON.stringify({ outputPath, markdownPath, summary: report.summary }, null, 2));
  if ((jwtSessionPath && report.importedJwtCount !== report.requestedJwtCount)
    || report.summary.loggedInAccounts === 0
    || (!loginOnly && report.summary.subjectQueriesCompleted === 0)) process.exitCode = 2;
}

function readCurrentSessionJwts(sessionPath) {
  if (!fs.existsSync(sessionPath)) throw new Error(`JWT session file not found: ${sessionPath}`);
  const descriptor = fs.openSync(sessionPath, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    const readSize = Math.min(size, 4 * 1024 * 1024);
    const buffer = Buffer.allocUnsafe(readSize);
    const bytesRead = fs.readSync(descriptor, buffer, 0, readSize, size - readSize);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const candidates = text.match(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu) || [];
    const valid = [...new Set(candidates)].filter((candidate) => {
      try {
        const payload = JSON.parse(Buffer.from(candidate.split(".")[1], "base64url").toString("utf8"));
        return payload?.iss === "iam" && Number.isFinite(payload.exp) && payload.exp * 1_000 > Date.now();
      } catch {
        return false;
      }
    });
    if (valid.length !== 2) throw new Error(`Expected exactly 2 current valid Vidu JWTs, found ${valid.length}`);
    return valid;
  } finally {
    fs.closeSync(descriptor);
  }
}

function subjectAuditExpression() {
  return `(async () => {
    const service = "https://service.vidu.cn";
    const request = async (url) => {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json, text/plain, */*", "x-platform": "web" },
          credentials: "include",
        });
        return { status: response.status, text: (await response.text()).slice(0, 2000000) };
      } catch (error) {
        return { status: 0, text: String(error && error.message ? error.message : error) };
      }
    };
    const creditKeys = ["credits_free", "credits_subscribed", "credits_purchased", "credits_permanent"];
    const creditsValue = (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      if (creditKeys.some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
        return creditKeys.reduce((sum, key) => sum + (Number.isFinite(Number(value[key])) ? Number(value[key]) : 0), 0);
      }
      for (const key of ["data", "credits", "result"]) {
        const nested = creditsValue(value[key]);
        if (nested !== null) return nested;
      }
      return null;
    };
    const credits = await request(service + "/credit/v1/credits/me");
    const taskPoll = await request(service + "/vidu/v1/tasks/codex-readonly-probe-do-not-exist");
    let parsedCredits = null;
    try { parsedCredits = JSON.parse(credits.text); } catch {}
    const availableCredits = credits.status === 200 ? creditsValue(parsedCredits) : null;
    const pages = [];
    let token = "";
    let subjectCount = 0;
    const seen = new Set();
    let complete = false;
    let error = null;
    for (let page = 1; page <= 100; page += 1) {
      const suffix = token ? "&pager.page_token=" + encodeURIComponent(token) : "";
      const response = await request(service + "/vidu/v1/material/elements/personal?pager.pagesz=100" + suffix);
      if (response.status !== 200) {
        pages.push({ page, httpStatus: response.status, subjects: 0 });
        error = "Subject page request failed: HTTP " + response.status;
        break;
      }
      let payload;
      try { payload = JSON.parse(response.text); } catch {
        pages.push({ page, httpStatus: response.status, subjects: 0 });
        error = "Subject page returned non-JSON data";
        break;
      }
      const elements = Array.isArray(payload && payload.elements) ? payload.elements : [];
      const count = elements.filter((element) => element && element.type === "user").length;
      pages.push({ page, httpStatus: response.status, subjects: count });
      subjectCount += count;
      const next = payload && payload.pager && typeof payload.pager.next_page_token === "string"
        ? payload.pager.next_page_token
        : "";
      if (!next) { complete = true; break; }
      if (seen.has(next)) { error = "Subject pagination repeated a page token"; break; }
      seen.add(next);
      token = next;
    }
    return {
      creditsStatus: credits.status,
      creditsReturned: Number.isFinite(availableCredits),
      availableCredits: Number.isFinite(availableCredits) ? availableCredits : null,
      taskPollStatus: taskPoll.status,
      pages,
      subjectCount,
      complete,
      error,
    };
  })()`;
}

function renderMarkdown(report) {
  const lines = [
    "# 当前版 Vidu 自有账号非付费动态验收",
    "",
    `生成时间：${report.generatedAt}`,
    "",
    "## 结论",
    "",
    `- 配置账号：\`${report.summary.configuredAccounts}\`，启用：\`${report.summary.enabledAccounts}\`。`,
    `- 登录有效：\`${report.summary.loggedInAccounts}\`；返回积分：\`${report.summary.creditsReturnedAccounts}\`。`,
    `- 主体库分页完成：\`${report.summary.subjectQueriesCompleted}\`；主体总数：\`${report.summary.totalSubjects}\`。`,
    `- Vidu 任务查询接口收到 HTTP 响应：\`${report.summary.taskPollEndpointResponses}\` 个账号。`,
    "- 未提交视频，未创建、粘贴或删除主体；原 userData 未修改。",
    "- 报告不包含账号 ID、账号名、JWT、Cookie、session key、主体名称或素材 URL。",
    "",
    "## 账号结果",
    "",
    "| 账号 | 启用 | 登录 | 登录 HTTP | 积分返回 | 主体分页 | 主体数量 | 错误 |",
    "|---|---:|---|---:|---:|---:|---:|---|",
  ];
  for (const item of report.accounts) {
    const errors = [item.loginCheck.error, item.postWindowLoginCheck?.error, item.subjectLibrary.error].filter(Boolean).join("; ") || "";
    const availableCredits = item.loginCheck.creditsReturned
      ? item.loginCheck.availableCredits
      : item.postWindowLoginCheck?.creditsReturned
        ? item.postWindowLoginCheck.availableCredits
        : item.subjectLibrary.creditsReturned
          ? item.subjectLibrary.remoteAvailableCredits
          : "否";
    lines.push(`| #${item.accountIndex} | ${item.enabled ? "是" : "否"} | ${item.loginCheck.status} | ${item.loginCheck.httpStatus ?? ""} | ${availableCredits} | ${item.subjectLibrary.pageCount} | ${item.subjectLibrary.subjectCount ?? ""} | ${escapeTable(errors)} |`);
  }
  lines.push(
    "",
    "## 请求证据",
    "",
  );
  for (const item of report.accounts) {
    lines.push(`- 账号 #${item.accountIndex}：主体分页状态 ${item.subjectLibrary.pages.map((page) => `p${page.page}=HTTP ${page.httpStatus} (${page.subjects})`).join(", ") || "未执行"}；同 session 积分接口 HTTP ${item.subjectLibrary.creditsStatus ?? "未执行"}，积分 ${item.subjectLibrary.creditsReturned ? item.subjectLibrary.remoteAvailableCredits : "未解析"}；任务查询只读探测 HTTP ${item.taskPollProbe.httpStatus ?? "未执行"}。`);
    if (item.postWindowLoginCheck) {
      lines.push(`- 账号 #${item.accountIndex}：Vidu 隐藏窗口建立后再次检查为 ${item.postWindowLoginCheck.status} / HTTP ${item.postWindowLoginCheck.httpStatus ?? "无"}，检查结果积分 ${item.postWindowLoginCheck.creditsReturned ? item.postWindowLoginCheck.availableCredits : "未返回"}。`);
    }
  }
  lines.push("", `- 临时 userData 已删除：\`${report.protections.temporaryUserDataRemoved}\`。`, "");
  return lines.join("\n");
}

function escapeTable(value) {
  return redact(String(value)).replaceAll("|", "\\|").replace(/\r?\n/gu, " ");
}

function redact(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/giu, "sk-[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu, "[jwt-redacted]")
    .replace(/(?:JWT|SSUID|Cookie|Authorization)\s*[=:]\s*[^\s,;]+/giu, "$1=[redacted]")
    .slice(0, 800);
}

async function safeEvaluate(cdp, expression) {
  try {
    return { ok: true, value: await evaluate(cdp, expression) };
  } catch (error) {
    return { ok: false, error: redact(error instanceof Error ? error.message : String(error)) };
  }
}

async function waitForOfflineApi(cdp) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = await safeEvaluate(cdp, "Boolean(window.offline?.vidu?.listAccounts && window.offline?.vidu?.checkAccount && window.offline?.vidu?.copySubjectLibrary)");
    if (ready.ok && ready.value) return;
    await delay(250);
  }
  throw new Error("Timed out waiting for the packaged AI tool API");
}

async function waitForTarget(port, predicate, exited, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited()) throw new Error(`Packaged app exited before audit: ${JSON.stringify(exited())}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find(predicate);
      if (target?.webSocketDebuggerUrl) return target;
    } catch {}
    await delay(250);
  }
  throw new Error("Timed out waiting for Electron debugger target");
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  return opened.then(() => ({
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      for (const { reject } of pending.values()) reject(new Error("CDP connection closed"));
      pending.clear();
      socket.close();
    },
  }));
}

async function evaluate(cdp, expression) {
  const result = await cdp.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
