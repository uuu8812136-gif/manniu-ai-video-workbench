const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const Database = require("better-sqlite3");
const JSZip = require("jszip");

const root = path.resolve(__dirname, "..");
const electron = path.join(root, "node_modules", ".pnpm", "electron@43.2.0", "node_modules", "electron", "dist", "electron.exe");
const originalEvidencePath = path.resolve(root, "..", "original-harness", "evidence", "original-ui-interactions.json");
const originalFixtureRoot = path.resolve(root, "..", "original-harness", "fixtures");
const outputPath = path.resolve(process.argv[2] || path.join(root, "audit", "evidence", "current-ui-interactions.json"));
const artifactRoot = path.resolve(process.argv[4] || path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}-artifacts`));
const fixtureRoot = path.join(artifactRoot, "_fixture");
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const pausedInferenceJobId = "00000000-0000-4000-8000-000000000004";
const polishExportJobId = "00000000-0000-4000-8000-000000000005";
const completedImageJobId = "00000000-0000-4000-8000-000000000006";
const imageBatchName = "audit-image-batch";
const imageWorkbenchKey = "audit-image-card-1";
const polishEditedResult = "你在雨夜推开车站的大门，冷风带着旧铁轨的气味迎面而来。\n";
const configuredCaseIds = [
  "project-create", "project-import-csv", "project-update-media", "project-batch-edit",
  "project-edit-prompt", "project-uncertain-clear-delete", "project-force-delete-tracked", "project-resend", "project-check", "project-start", "project-pause", "project-stop-one",
  "project-q2-q3", "jianying-normal", "jianying-auto-srt", "inference-submit", "polish-submit", "image-submit",
  "settings-inference-save", "settings-polish-save",
  "batch-add-remove", "batch-start", "batch-stop", "batch-skip", "batch-reorder", "batch-custom-schedule", "batch-clear-completed",
  "opening-fetch", "opening-submit", "opening-stop", "opening-export",
  "opening-docx", "opening-enhanced", "opening-copy-expand", "opening-select-output", "opening-export-open-dir",
  "inference-stop-one", "inference-genre", "inference-paused-open", "polish-stop", "polish-export-open",
  "image-reference", "image-edit-prompt", "image-resend", "image-open-dir", "image-stop-one",
  "settings-account-add", "settings-account-delete-one", "settings-account-reorder", "settings-account-toggle",
  "settings-account-edit", "settings-account-daily-reset", "settings-account-clear-flags", "settings-account-unblock",
  "theme-toggle", "logout", "updater-check",
  "settings-webhook-save-test", "settings-account-login-check", "settings-account-jwt-import",
  "project-delete", "project-reset", "project-check-all", "project-force-stop", "project-open-video",
  "inference-stop", "inference-multi-file", "inference-open-output",
  "settings-folder-save", "settings-opening-save", "settings-image-save", "settings-jianying-save",
  "settings-account-batch-delete",
];
const currentOnlyCaseIds = new Set(["project-uncertain-clear-delete", "project-force-delete-tracked"]);
const selectedCaseIds = new Set((process.env.CURRENT_AUDIT_CASES ?? process.argv[3] ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const caseIds = configuredCaseIds.filter((id) => selectedCaseIds.size === 0 || selectedCaseIds.has(id));

if (!fs.existsSync(electron)) throw new Error(`Electron executable not found: ${electron}`);
if (!fs.existsSync(originalEvidencePath)) throw new Error(`Original interaction evidence not found: ${originalEvidencePath}`);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  fs.rmSync(artifactRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
  await ensureFixtureMedia();
  const original = JSON.parse(fs.readFileSync(originalEvidencePath, "utf8"));
  const originalIds = original.cases.map((item) => item.id);
  const absentOriginalCases = caseIds.filter((id) => !currentOnlyCaseIds.has(id) && !originalIds.includes(id));
  if (absentOriginalCases.length > 0) throw new Error(`Original interaction cases missing: ${absentOriginalCases.join(", ")}`);

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: `current-${packageVersion}-development-electron-same-original-fixture`,
    target: { executable: electron, main: path.join(root, "out", "main", "index.js") },
    originalEvidence: originalEvidencePath,
    originalEvidenceCaseCount: originalIds.length,
    auditedOriginalCaseIds: caseIds.filter((id) => !currentOnlyCaseIds.has(id)),
    auditedCurrentOnlyCaseIds: caseIds.filter((id) => currentOnlyCaseIds.has(id)),
    fixture: fixtureDescription(),
    cases: [],
  };
  for (const id of caseIds) {
    process.stdout.write(`[current interaction] ${id} ... `);
    const result = await runCase(id);
    report.cases.push(result);
    console.log(result.status);
  }
  report.summary = {
    total: report.cases.length,
    passed: report.cases.filter((item) => item.status === "passed").length,
    failed: report.cases.filter((item) => item.status === "failed").length,
    realUiClicks: report.cases.filter((item) => item.uiAction?.clicked).length,
    casesWithIpcEvidence: report.cases.filter((item) => item.calls?.length > 0 || item.expectedChannels?.length === 0).length,
    externalRequestsBlocked: report.cases.reduce((sum, item) => sum + item.blockedExternalRequests.length, 0),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, summary: report.summary }, null, 2));
  if (report.summary.failed > 0) process.exitCode = 1;
}

async function runCase(id) {
  const caseRoot = path.join(artifactRoot, id);
  const userData = path.join(caseRoot, "user-data");
  const projectDir = path.join(caseRoot, "project");
  const draftRoot = path.join(caseRoot, "jianying-drafts");
  const selectedOutputDir = path.join(caseRoot, "selected-output");
  const networkLog = path.join(caseRoot, "network.jsonl");
  const appLog = path.join(caseRoot, "electron.log");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(draftRoot, { recursive: true });
  fs.mkdirSync(selectedOutputDir, { recursive: true });
  copyFixtureFiles(projectDir);
  const documentPath = id === "opening-docx"
    ? path.join(fixtureRoot, "audit-novel.docx")
    : ["polish-submit", "polish-stop"].includes(id)
    ? path.join(originalFixtureRoot, "audit-polish.txt")
    : path.join(originalFixtureRoot, "audit-novel.txt");
  const port = await availablePort();
  const imageModelCase = ["image-reference", "image-resend", "image-stop-one"].includes(id);
  const modelServer = ["opening-stop", "inference-stop", "inference-stop-one", "inference-genre", "polish-stop", "image-stop-one"].includes(id)
    ? await startStalledModelServer()
    : ["opening-docx", "opening-enhanced"].includes(id)
      ? await startOpeningFixtureModelServer()
      : ["image-reference", "image-resend"].includes(id)
        ? await startImageFixtureModelServer()
      : null;
  const log = fs.openSync(appLog, "w");
  const child = spawn(electron, [root, "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    cwd: root,
    env: {
      ...process.env,
      AI_TOOL_TEST_INTERACTION_AUDIT: "1",
      AI_TOOL_TEST_OPENING_FIXTURE_FAST_PATH: ["opening-docx", "opening-enhanced"].includes(id) ? "1" : "",
      AI_TOOL_TEST_DOCUMENT_PATH: documentPath,
      AI_TOOL_TEST_DIRECTORY_PATH: selectedOutputDir,
      AI_TOOL_TEST_DOCUMENT_PATHS_JSON: ["inference-multi-file", "inference-stop-one"].includes(id) ? JSON.stringify([
        path.join(originalFixtureRoot, "audit-novel.txt"),
        path.join(fixtureRoot, "audit-novel-second.txt"),
      ]) : "",
      AI_TOOL_TEST_QQ_NOVEL_PATH: path.join(originalFixtureRoot, "audit-novel.txt"),
      AI_TOOL_TEST_CSV_PATH: path.join(fixtureRoot, "审计导入.csv"),
      AI_TOOL_TEST_AUDIO_PATH: path.join(projectDir, "替换旁白.mp3"),
      AI_TOOL_TEST_SUBTITLE_PATH: path.join(projectDir, "替换字幕.srt"),
      AI_TOOL_TEST_VISUAL_PATH: id === "image-reference" ? path.join(fixtureRoot, "角色.png") : path.join(projectDir, "1.mp4"),
      AI_TOOL_TEST_BLOCK_EXTERNAL_NETWORK: "1",
      AI_TOOL_TEST_NETWORK_LOG: networkLog,
    },
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  let exited = null;
  child.once("exit", (code, signal) => { exited = { code, signal }; });
  let cdp;
  let result;
  try {
    const page = await waitForRenderer(port, () => exited);
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    await waitForAuditApi(cdp);
    const seed = await evaluate(cdp, seedExpression(
      projectDir,
      draftRoot,
      imageModelCase ? null : modelServer?.baseUrl,
      imageModelCase ? modelServer?.baseUrl : null,
    ));
    seedHiddenFixture(seed.database, seed.project.id, seed.storyboards, seed.account.id, id, projectDir);
    await evaluate(cdp, prepareCaseExpression(id, seed));
    if (id.startsWith("batch-") || id === "project-delete") {
      await cdp.call("Page.reload", { ignoreCache: true });
      await waitForAuditApi(cdp);
    }
    if (id === "inference-paused-open") await evaluate(cdp, "window.__AI_TOOL_INTERACTION_AUDIT__.clear(); true");
    await evaluate(cdp, navigateExpression(id, seed.project.id));
    await waitForBody(cdp, routeNeedle(id));
    prepareCaseAfterNavigation(seed.database, id);
    if (["opening-export", "opening-copy-expand", "opening-export-open-dir"].includes(id)) await delay(1_200);
    const before = databaseSnapshot(seed.database);
    const filesBefore = fileSnapshot(caseRoot);
    await evaluate(cdp, `${id === "inference-paused-open" ? "" : "window.__AI_TOOL_INTERACTION_AUDIT__.clear();"} window.confirm = () => true; true`);
    const uiAction = await evaluate(cdp, actionExpression(id));
    await waitForExpectedChannels(cdp, expectedChannels(id), 8_000);
    await delay(postActionDelay(id));
    const calls = await evaluate(cdp, "window.__AI_TOOL_INTERACTION_AUDIT__.snapshot()");
    const bodyText = await evaluate(cdp, "document.body.innerText.replace(/\\s+/gu, ' ').trim()");
    const after = databaseSnapshot(seed.database);
    const filesAfter = fileSnapshot(caseRoot);
    const missing = expectedChannels(id).filter((channel) => !calls.some((call) => call.channel === channel));
    const createdFiles = fileDelta(filesBefore, filesAfter);
    const processAliveAfterAction = exited === null;
    const blockedExternalRequests = readJsonLines(networkLog).filter((item) => item.event === "blocked");
    const evidenceFailures = validateCaseEvidence(id, calls, before, after, createdFiles, uiAction, processAliveAfterAction, blockedExternalRequests);
    result = {
      id,
      status: missing.length === 0 && evidenceFailures.length === 0 && uiAction.clicked ? "passed" : "failed",
      expectedChannels: expectedChannels(id),
      missingChannels: missing,
      evidenceFailures,
      uiAction,
      calls,
      database: { path: seed.database, before, after, delta: databaseDelta(before, after) },
      outputFiles: { before: filesBefore, after: filesAfter, created: createdFiles },
      modelRequests: modelServer?.requests ?? [],
      processAliveAfterAction,
      bodyText,
      blockedExternalRequests,
      interception: interceptionNote(id),
    };
  } catch (error) {
    result = {
      id,
      status: "failed",
      expectedChannels: expectedChannels(id),
      missingChannels: expectedChannels(id),
      error: error instanceof Error ? error.stack || error.message : String(error),
      blockedExternalRequests: readJsonLines(networkLog).filter((item) => item.event === "blocked"),
    };
  } finally {
    cdp?.close();
    if (child.pid && exited === null) spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    fs.closeSync(log);
    await modelServer?.close();
    await delay(300);
    retainEvidenceArtifacts(caseRoot, userData, projectDir, result);
  }
  return result;
}

function fixtureDescription() {
  return {
    "project-create": ["projects:create"],
    "project-import-csv": ["files:pick-csv", "files:copy-into-directory", "storyboards:replace", "projects:update"],
    "project-update-media": ["files:pick-file", "projects:update"],
    "project-batch-edit": ["storyboards:update"],
    projectName: "原版动态审计项目",
    storyboards: [
      { displayIndex: 1, currentIndex: 0, originalText: "林默在旧车站醒来，抬头看向站台尽头。", subjects: ["林默"], prompt: "中景，旧车站清晨，林默缓慢起身，电影感光影", duration: 4, status: "done" },
      { displayIndex: 2, currentIndex: 1, originalText: "苏晚从雾中走来，停在林默面前。", subjects: ["林默", "苏晚"], prompt: "全景，薄雾站台，苏晚走向林默，镜头轻微推进", duration: 5, status: "generating" },
      { displayIndex: 3, currentIndex: 2, originalText: "广播突然响起，两人同时望向候车室。", subjects: ["林默", "苏晚"], prompt: "双人中景，两人同时回头，候车室灯光闪烁，悬疑氛围", duration: 4, status: "pending" },
    ],
    subtitle: "three cues at 0-4s, 4-9s, 9-13s with exact storyboard source text",
    media: "4-second black H.264 video and 13-second silent MP3 generated locally",
    network: "external requests blocked by AI_TOOL_TEST_BLOCK_EXTERNAL_NETWORK",
    viduAccounts: [
      { displayIndex: 1, name: "审计会员号", accountType: "member", defaultQuota: 200 },
      { displayIndex: 2, name: "审计积分号", accountType: "points", defaultQuota: 46 },
    ],
    q3: { enabled: true, leadingCount: 2, q2UseCredits: true },
  };
}

async function ensureFixtureMedia() {
  const video = path.join(fixtureRoot, "1.mp4");
  const audio = path.join(fixtureRoot, "旁白.mp3");
  const asset = path.join(fixtureRoot, "角色.png");
  const ffmpeg = path.join(root, "vendor", "ffmpeg", "win-x64", "bin", "ffmpeg.exe");
  if (!fs.existsSync(video)) {
    const result = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", video], { stdio: "pipe", windowsHide: true });
    if (result.status !== 0) throw new Error(`Fixture video generation failed (${result.error?.message ?? result.status}): ${String(result.stderr ?? "")}`);
  }
  if (!fs.existsSync(audio)) {
    const result = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "13", "-q:a", "9", "-acodec", "libmp3lame", audio], { stdio: "pipe", windowsHide: true });
    if (result.status !== 0) throw new Error(`Fixture audio generation failed (${result.error?.message ?? result.status}): ${String(result.stderr ?? "")}`);
  }
  fs.writeFileSync(path.join(fixtureRoot, "审计导入.csv"), [
    "编号,原声,秒数,画面提示词",
    "1,审计导入第一镜,4,雨夜车站入口",
    "2,审计导入第二镜,5,候车室暖光",
  ].join("\r\n"), "utf8");
  fs.writeFileSync(path.join(fixtureRoot, "audit-novel-second.txt"), "第二篇动态审计小说。\n夜班列车驶入空无一人的终点站。\n", "utf8");
  const docx = new JSZip();
  docx.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  docx.folder("_rels").file(".rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  docx.folder("word").file("document.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>审计 DOCX 文本</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
  fs.writeFileSync(path.join(fixtureRoot, "audit-novel.docx"), await docx.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const imageResult = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=0x3b82f6:s=64x64:d=0.1", "-frames:v", "1", "-update", "1", asset], { stdio: "pipe", windowsHide: true });
  if (imageResult.status !== 0) throw new Error(`Fixture image generation failed (${imageResult.error?.message ?? imageResult.status}): ${String(imageResult.stderr ?? "")}`);
}

function copyFixtureFiles(projectDir) {
  fs.copyFileSync(path.join(fixtureRoot, "1.mp4"), path.join(projectDir, "1.mp4"));
  fs.copyFileSync(path.join(fixtureRoot, "旁白.mp3"), path.join(projectDir, "旁白.mp3"));
  fs.copyFileSync(path.join(fixtureRoot, "旁白.mp3"), path.join(projectDir, "替换旁白.mp3"));
  fs.writeFileSync(path.join(projectDir, "字幕.srt"), [
    "1", "00:00:00,000 --> 00:00:04,000", "林默在旧车站醒来，抬头看向站台尽头。", "",
    "2", "00:00:04,000 --> 00:00:09,000", "苏晚从雾中走来，停在林默面前。", "",
    "3", "00:00:09,000 --> 00:00:13,000", "广播突然响起，两人同时望向候车室。", "",
  ].join("\r\n"), "utf8");
  fs.copyFileSync(path.join(projectDir, "字幕.srt"), path.join(projectDir, "替换字幕.srt"));
  fs.mkdirSync(path.join(projectDir, "资产图"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "推理"), { recursive: true });
  fs.copyFileSync(path.join(fixtureRoot, "角色.png"), path.join(projectDir, "资产图", "林默.png"));
  fs.copyFileSync(path.join(fixtureRoot, "角色.png"), path.join(projectDir, "资产图", "苏晚.png"));
}

function seedExpression(projectDir, draftRoot, inferBaseUrl, imageBaseUrl) {
  const project = {
    name: "原版动态审计项目",
    folderPath: projectDir,
    csvPath: path.join(projectDir, "分镜.csv"),
    rosterPath: path.join(projectDir, "角色表.txt"),
    subtitlePath: path.join(projectDir, "字幕.srt"),
    audioPath: path.join(projectDir, "旁白.mp3"),
  };
  const settings = {
    project_base_folder: projectDir,
    infer_api_base_url: inferBaseUrl ?? "https://api.deepseek.com",
    infer_api_key: "sk-audit-placeholder-key",
    infer_model: "deepseek-chat",
    infer_output_dir: path.join(projectDir, "推理"),
    infer_concurrency_per_key: "2",
    opening_output_dir: path.join(projectDir, "开头"),
    text_polish_api_base_url: inferBaseUrl ?? "https://api.deepseek.com",
    text_polish_api_key: "sk-audit-placeholder-key",
    text_polish_model: "deepseek-chat",
    text_polish_output_dir: path.join(projectDir, "捋文"),
    imagegen_api_base_url: imageBaseUrl ?? "https://example.invalid/v1",
    imagegen_api_key: "sk-audit-placeholder-key",
    imagegen_model: "gpt-image-2",
    imagegen_output_dir: path.join(projectDir, "图片"),
    jianying_draft_path: draftRoot,
    ffmpeg_path: path.join(root, "vendor", "ffmpeg", "win-x64", "bin", "ffmpeg.exe"),
    ffprobe_path: path.join(root, "vendor", "ffmpeg", "win-x64", "bin", "ffprobe.exe"),
    video_provider: "vidu-browser",
    vidu_model: "Q3",
    vidu_use_credits: "true",
    video_aspect_ratio: "16:9",
  };
  return `(async () => {
    const projectInput = ${JSON.stringify(project)};
    const settings = ${JSON.stringify(settings)};
    for (const [key, value] of Object.entries(settings)) await window.offline.settings.set(key, value);
    const project = await window.offline.projects.create(projectInput);
    const secondaryProject = await window.offline.projects.create({
      name: "原版动态审计项目二",
      folderPath: ${JSON.stringify(path.join(projectDir, "secondary"))},
    });
    await window.offline.settings.set('project_' + project.id + '_vidu_q3_enabled', 'true');
    await window.offline.settings.set('project_' + project.id + '_vidu_q3_pre_count', '2');
    await window.offline.characterProfiles.replace(project.id, [
      { name: "林默", identity: "男主角", gender: "男", age: "青年", appearance: "清俊面容", hair: "黑色短发", clothing: "深色风衣", personality: "沉静", visualPrompt: "青年男性，清俊面容，黑色短发，深色风衣，沉静克制", assetType: "character" },
      { name: "苏晚", identity: "女主角", gender: "女", age: "青年", appearance: "清冷面容", hair: "黑色长发", clothing: "浅色大衣", personality: "冷静", visualPrompt: "青年女性，清冷面容，黑色长发，浅色大衣，冷静", assetType: "character" },
    ]);
    let storyboards = await window.offline.storyboards.replace(project.id, ${JSON.stringify(fixtureDescription().storyboards.map((item) => ({
      index: item.currentIndex, originalText: item.originalText, subjects: item.subjects, prompt: item.prompt, duration: item.duration,
    })))});
    storyboards[0] = await window.offline.storyboards.update(storyboards[0].id, { status: "done", videoPath: ${JSON.stringify(path.join(projectDir, "1.mp4"))} });
    storyboards[1] = await window.offline.storyboards.update(storyboards[1].id, { status: "generating" });
    const account = await window.offline.vidu.createAccount({ name: "审计会员号", accountType: "member", defaultQuota: 200 });
    const pointsAccount = await window.offline.vidu.createAccount({ name: "审计积分号", accountType: "points", defaultQuota: 46 });
    await window.offline.settings.set("vidu_default_account_id", account.id);
    await window.offline.storyboards.appendEvent(storyboards[1].id, { eventType: "submitted", message: "已提交到 Vidu", detail: "audit fixture", taskId: "audit-task-2", browserIndex: 1 });
    const paths = await window.offline.app.paths();
    return { project, secondaryProject, storyboards, account, pointsAccount, database: paths.database };
  })()`;
}

function seedHiddenFixture(databasePath, projectId, storyboards, accountId, id, projectDir) {
  const db = new Database(databasePath);
  try {
    db.pragma("busy_timeout = 5000");
    if (!["project-import-csv", "project-delete", "project-reset"].includes(id)) {
      db.prepare(`UPDATE storyboards SET task_id=?, video_task_id=?, video_provider='vidu-browser', video_account_id=?, video_submission_state='submitted', video_recovery_state='processing', submit_count=1 WHERE id=?`)
        .run("audit-task-2", "audit-task-2", accountId, storyboards[1].id);
    }
    if (id === "project-uncertain-clear-delete") {
      db.prepare(`UPDATE storyboards SET task_id=NULL, video_task_id=NULL, video_provider='vidu-browser', video_account_id=?, video_submission_state='uncertain', video_recovery_state='idle', submit_count=1 WHERE id=?`)
        .run(accountId, storyboards[2].id);
    }
    if (id === "project-force-delete-tracked") {
      const now = new Date().toISOString();
      db.prepare(`UPDATE storyboards SET status='error', video_recovery_state='unavailable', video_recovery_message='Vidu 暂时不可用' WHERE id=?`)
        .run(storyboards[1].id);
      db.prepare(`INSERT INTO jobs(id,type,status,progress,input_json,output_json,error,attempts,priority,created_at,updated_at) VALUES(?, 'video.generate', 'error', 0, ?, NULL, 'Vidu 暂时不可用', 1, 0, ?, ?)`)
        .run("00000000-0000-4000-8000-000000000007", JSON.stringify({ storyboardId: storyboards[1].id, provider: "vidu-browser" }), now, now);
    }
    if (["project-stop-one", "project-force-stop"].includes(id)) insertPausedVideoJob(db, storyboards[1].id, accountId);
    if (["opening-export", "opening-copy-expand", "opening-export-open-dir"].includes(id)) insertOpeningAuditJob(db);
    if (id === "inference-paused-open") insertPausedInferenceAuditJob(db, projectId, projectDir);
    if (id === "polish-export-open") insertCompletedPolishAuditJob(db, projectDir);
    if (["image-edit-prompt", "image-resend", "image-open-dir"].includes(id)) insertCompletedImageAuditJob(db, projectDir);
    if (id === "settings-account-daily-reset") {
      db.prepare("UPDATE vidu_accounts SET usage_count=9, usage_date='2026-07-27' WHERE id=?").run(accountId);
      db.prepare("UPDATE vidu_accounts SET usage_count=7, usage_date='2026-07-01' WHERE account_type='points'").run();
    }
    if (["settings-account-clear-flags", "settings-account-unblock"].includes(id)) {
      const reason = id === "settings-account-clear-flags" ? "subject_limit" : "credits_exhausted";
      db.prepare("UPDATE vidu_accounts SET enabled=0, disabled_reason=?, disabled_message='isolated audit reason', disabled_at=? WHERE id=?")
        .run(reason, new Date().toISOString(), accountId);
    }
  } finally { db.close(); }
}

function insertCompletedImageAuditJob(db, projectDir) {
  const now = new Date().toISOString();
  const outputRoot = path.join(projectDir, "图片");
  const outputDirectory = path.join(outputRoot, imageBatchName);
  const imagePath = path.join(outputDirectory, "审计角色-初始.png");
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.copyFileSync(path.join(fixtureRoot, "角色.png"), imagePath);
  db.prepare(`INSERT INTO jobs(id,type,status,progress,input_json,output_json,error,attempts,priority,created_at,updated_at) VALUES(?, 'image.standalone', 'done', 100, ?, ?, NULL, 1, 0, ?, ?)`)
    .run(
      completedImageJobId,
      JSON.stringify({
        prompt: "原始提示词",
        name: "审计角色",
        batchName: imageBatchName,
        outputDirectory: outputRoot,
        workbenchKey: imageWorkbenchKey,
        model: "gpt-image-2",
        count: 1,
        aspectRatio: "16:9",
        size: "1920x1080",
      }),
      JSON.stringify({ imagePath, imagePaths: [imagePath], outputDirectory, provider: "audit-fixture" }),
      now,
      now,
    );
  db.prepare(`INSERT INTO job_events(job_id,level,message,detail_json,created_at) VALUES(?, 'info', 'Job completed', NULL, ?)`)
    .run(completedImageJobId, now);
}

function insertPausedInferenceAuditJob(db, projectId, projectDir) {
  const now = new Date().toISOString();
  const workDir = path.join(projectDir, ".ai-tool-inference", pausedInferenceJobId);
  const reportPath = path.join(workDir, "dcol_validation_report.json");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({ status: "paused", remainingErrors: 5 }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(workDir, "已完成分镜.csv"), "编号,原文\n1,审计暂停现场\n", "utf8");
  db.prepare(`INSERT INTO jobs(id,type,status,progress,input_json,output_json,error,attempts,priority,created_at,updated_at) VALUES(?, 'storyboard.infer', 'paused', 68, ?, NULL, ?, 1, 0, ?, ?)`)
    .run(
      pausedInferenceJobId,
      JSON.stringify({ text: "审计暂停推理正文", genre: "玄幻", projectId }),
      "校验未清零，草稿已保留",
      now,
      now,
    );
  db.prepare(`INSERT INTO job_events(job_id,level,message,detail_json,created_at) VALUES(?, 'warning', 'Job paused for attention', ?, ?)`)
    .run(pausedInferenceJobId, JSON.stringify({
      stage: "full-table-repair",
      workDir,
      reportPaths: [reportPath],
      errorCategory: "DCOL.UNCLASSIFIED",
      completedIndexes: [1, 2, 3],
      error: "校验未清零，草稿已保留",
    }), now);
}

function insertCompletedPolishAuditJob(db, projectDir) {
  const now = new Date().toISOString();
  const outputDirectory = path.join(projectDir, "捋文");
  const outputPath = path.join(outputDirectory, "audit-polish_捋文.txt");
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(outputPath, "初始审计捋文\n", "utf8");
  db.prepare(`INSERT INTO jobs(id,type,status,progress,input_json,output_json,error,attempts,priority,created_at,updated_at) VALUES(?, 'text.polish', 'done', 100, ?, ?, NULL, 1, 0, ?, ?)`)
    .run(
      polishExportJobId,
      JSON.stringify({
        text: "林默推开雨夜车站的大门，风里带着旧铁轨的气味。\n",
        title: "audit-polish",
        outDir: outputDirectory,
        mode: "original",
        sourceFormat: "txt",
      }),
      JSON.stringify({ text: "初始审计捋文\n", content: "初始审计捋文\n", outputPath, mode: "original", model: "audit-fixture" }),
      now,
      now,
    );
  db.prepare(`INSERT INTO job_events(job_id,level,message,detail_json,created_at) VALUES(?, 'info', 'Job completed', NULL, ?)`)
    .run(polishExportJobId, now);
}

function insertOpeningAuditJob(db) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs(id,type,status,progress,input_json,output_json,error,attempts,priority,created_at,updated_at) VALUES(?, 'opening.optimize', 'paused', 72, ?, NULL, NULL, 0, 0, ?, ?)`)
    .run(
      "00000000-0000-4000-8000-000000000003",
      JSON.stringify({ text: "审计小说正文", title: "审计小说", mode: "general", outDir: "C:\\AI审计\\开头输出" }),
      now,
      now,
    );
}

function prepareCaseExpression(id, seed) {
  const now = new Date().toISOString();
  const waiting = (entryId, project) => ({
    id: entryId,
    projectId: project.id,
    projectName: project.name,
    status: "waiting",
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  let snapshot = null;
  if (["batch-start", "batch-stop", "batch-skip"].includes(id)) {
    snapshot = { version: 1, entries: [waiting("audit-batch-1", seed.project)], running: false, currentProjectId: null, scheduledAt: null };
  } else if (id === "batch-reorder") {
    snapshot = { version: 1, entries: [waiting("audit-batch-1", seed.project), waiting("audit-batch-2", seed.secondaryProject)], running: false, currentProjectId: null, scheduledAt: null };
  } else if (id === "batch-clear-completed") {
    snapshot = {
      version: 1,
      entries: [
        { ...waiting("audit-batch-done", seed.project), status: "done" },
        waiting("audit-batch-waiting", seed.secondaryProject),
      ],
      running: false,
      currentProjectId: null,
      scheduledAt: null,
    };
  }
  const entries = [];
  if (snapshot) entries.push(`localStorage.setItem('ai-tool.batch-queue.v1', ${JSON.stringify(JSON.stringify(snapshot))})`);
  else if (id.startsWith("batch-")) entries.push("localStorage.removeItem('ai-tool.batch-queue.v1')");
  if (["opening-export", "opening-copy-expand", "opening-export-open-dir"].includes(id)) entries.push("localStorage.setItem('ai-tool.text-workbench.opening.job.v1', '00000000-0000-4000-8000-000000000003')");
  if (id === "polish-export-open") entries.push(`localStorage.setItem('ai-tool.text-workbench.polish.job.v1', ${JSON.stringify(polishExportJobId)})`);
  if (["image-edit-prompt", "image-resend", "image-open-dir"].includes(id)) entries.push(`localStorage.setItem('ai-tool.image-workbench.batch.v1', ${JSON.stringify(imageBatchName)})`);
  if (id === "logout") entries.push("localStorage.removeItem('token');localStorage.removeItem('user');localStorage.removeItem('deviceId')");
  return `(async()=>{${entries.join(";")};return true})()`;
}

function prepareCaseAfterNavigation(databasePath, id) {
  if (!["opening-export", "opening-copy-expand", "opening-export-open-dir"].includes(id)) return;
  const db = new Database(databasePath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare("UPDATE jobs SET status='done', progress=100, output_json=?, updated_at=? WHERE id=?").run(
      JSON.stringify({
        text: "【题材】悬疑\n\n开头1（方向：危机，结构：悬念，得分：96）\n审计开头：旧车站的广播突然叫出了林默的名字。\n\n抓取正文\n这是隔离审计环境中的小说正文，用于验证复制正文与展开收起。",
        outputPath: "C:\\AI审计\\开头输出\\output_kaitou.txt",
      }),
      new Date().toISOString(),
      "00000000-0000-4000-8000-000000000003",
    );
  } finally { db.close(); }
}

function insertPausedVideoJob(db, storyboardId, accountId) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs(id,type,status,progress,input_json,output_json,error,attempts,priority,created_at,updated_at) VALUES(?, 'video.generate', 'paused', 10, ?, NULL, NULL, 0, 0, ?, ?)`)
    .run("00000000-0000-4000-8000-000000000002", JSON.stringify({ storyboardId, provider: "vidu-browser", accountId, viduModel: "Q3", useCredits: true, durationSeconds: 5, aspectRatio: "16:9" }), now, now);
  db.prepare(`INSERT INTO job_events(job_id,level,message,detail_json,created_at) VALUES(?, 'info', 'Job paused', ?, ?)`)
    .run("00000000-0000-4000-8000-000000000002", JSON.stringify({ auditFixture: true }), now);
}

function navigateExpression(id, projectId) {
  const hash = ["project-create", "project-delete", "theme-toggle", "logout"].includes(id) ? "#/"
    : id === "updater-check" ? "#/about"
    : id.startsWith("project-") || id.startsWith("jianying-") ? `#/project/${projectId}`
    : id.startsWith("batch-") ? "#/batch"
      : id.startsWith("opening-") ? "#/novel-optimizer"
    : id.startsWith("inference-") ? "#/inference"
      : id.startsWith("polish-") ? "#/text-polish"
        : id.startsWith("image-") ? "#/image"
          : id === "settings-inference-save" ? "#/settings?tab=inference"
            : id === "settings-polish-save" ? "#/settings?tab=text-polish"
              : id === "settings-webhook-save-test" ? "#/settings?tab=notifications"
                : id === "settings-folder-save" ? "#/settings?tab=folder"
                  : id === "settings-opening-save" ? "#/settings?tab=novel-optimizer"
                    : id === "settings-image-save" ? "#/settings?tab=imagegen"
                      : id === "settings-jianying-save" ? "#/settings?tab=jianying"
                : "#/settings?tab=video";
  return `window.location.hash=${JSON.stringify(hash)}; window.dispatchEvent(new HashChangeEvent('hashchange')); true`;
}

function routeNeedle(id) {
  if (["project-create", "project-delete", "theme-toggle", "logout"].includes(id)) return "创作";
  if (id === "updater-check") return "使用文档";
  if (id.startsWith("project-") || id.startsWith("jianying-")) return "原版动态审计项目";
  if (id.startsWith("batch-")) return "批量执行";
  if (id.startsWith("opening-")) return "开头优化";
  if (id.startsWith("inference-")) return "小说转分镜";
  if (id.startsWith("polish-")) return "开始捋文";
  if (id.startsWith("image-")) return "批量出图";
  if (id === "settings-inference-save") return "小说转分镜";
  if (id === "settings-polish-save") return "捋文设置";
  if (id === "settings-webhook-save-test") return "Webhook URL";
  if (id === "settings-folder-save") return "项目根目录";
  if (id === "settings-opening-save") return "开头优化";
  if (id === "settings-image-save") return "生图输出目录";
  if (id === "settings-jianying-save") return "剪映草稿目录";
  return "浏览器账号池";
}

function actionExpression(id) {
  const common = `
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    const norm = (v) => String(v ?? '').replace(/\\s+/gu, ' ').trim();
    const buttons = () => [...document.querySelectorAll('button')];
    const click = (text) => { const b=buttons().find(x=>norm(x.textContent)===text); if(!b) throw new Error('button not found: '+text); b.click(); return b; };
    const clickTitle = (title) => { const b=buttons().find(x=>x.title===title); if(!b) throw new Error('button title not found: '+title); b.click(); return b; };
    const setValue = (el,value) => { const p=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(el,value); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
    const setSelect = (el,value) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,value); el.dispatchEvent(new Event('change',{bubbles:true})); };
    const row = (index) => document.querySelectorAll('.storyboard-card-row')[index];
    const rowButton = (index,text) => { const b=[...row(index).querySelectorAll('button')].find(x=>norm(x.textContent)===text); if(!b) throw new Error('row button not found '+index+' '+text); b.click(); return b; };
    const waitCall = async (channel,ms=5000) => { const end=Date.now()+ms; while(Date.now()<end){if(window.__AI_TOOL_INTERACTION_AUDIT__.snapshot().some(x=>x.channel===channel))return;await delay(40);}throw new Error('IPC not observed: '+channel); };
    const waitSettled = async (channel,ms=5000) => { const end=Date.now()+ms; while(Date.now()<end){const call=[...window.__AI_TOOL_INTERACTION_AUDIT__.snapshot()].reverse().find(x=>x.channel===channel);if(call&&call.status!=='pending')return call;await delay(40);}throw new Error('IPC did not settle: '+channel); };
    const waitCallCount = async (channel,count,ms=5000) => { const end=Date.now()+ms; while(Date.now()<end){const calls=window.__AI_TOOL_INTERACTION_AUDIT__.snapshot().filter(x=>x.channel===channel&&x.status!=='pending');if(calls.length>=count)return calls;await delay(40);}throw new Error('IPC count not reached: '+channel+' '+count); };
  `;
  const actions = {
    "project-create": `click('新建项目');await delay(80);setValue(document.querySelector('input[placeholder="输入项目名称"]'),'动态审计新建项目');clickTitle('选择字幕文件');await waitCall('files:pick-file');await delay(60);clickTitle('选择旁白音频');await delay(80);window.__AI_TOOL_INTERACTION_AUDIT__.clear();click('创建并进入');await waitCall('projects:create');return {clicked:true,control:'新建项目 -> 选择字幕/旁白 -> 创建并进入'};`,
    "project-import-csv": `click('导入 CSV');await waitCall('files:pick-csv');await waitCall('files:copy-into-directory');await waitCall('storyboards:replace');await waitCall('projects:update');return {clicked:true,control:'导入 CSV'};`,
    "project-update-media": `click('旁白已选');await waitCall('files:pick-file');await waitCall('projects:update');await delay(80);window.__AI_TOOL_INTERACTION_AUDIT__.clear();click('字幕已选');await waitCall('files:pick-file');await waitCall('projects:update');return {clicked:true,control:'替换旁白和字幕'};`,
    "project-batch-edit": `click('批量修改');await delay(80);setValue(document.querySelector('input[placeholder="要替换的内容"]'),'旧车站');setValue(document.querySelector('input[placeholder="留空表示删除"]'),'雨夜车站');await delay(80);click('确认修改');await waitCall('storyboards:update');return {clicked:true,control:'批量修改提示词'};`,
    "project-edit-prompt": `const trigger=row(0).querySelector('.storyboard-static-field.prompt');if(!trigger)throw new Error('prompt edit trigger missing');trigger.click();await delay(80);const modal=document.querySelector('.app-modal');if(!modal)throw new Error('storyboard edit modal missing');const fields=[...modal.querySelectorAll('.storyboard-edit-form label')];const promptField=fields.find(label=>norm(label.querySelector('span')?.textContent)==='画面提示词')?.querySelector('textarea');if(!promptField)throw new Error('prompt editor missing');setValue(promptField,'原版动态审计：修改后的电影感提示词');await delay(50);const save=[...modal.querySelectorAll('button')].find(button=>norm(button.textContent)==='保存');if(!save||save.disabled)throw new Error('storyboard save unavailable');save.click();await waitCall('storyboards:update');return {clicked:true,control:'storyboard row 1 prompt -> modal save'};`,
    "project-uncertain-clear-delete": `const target=row(2);const trash=target?.querySelector('button[title="删除分镜"]');if(!trash)throw new Error('uncertain storyboard delete trigger missing');trash.click();await delay(100);const resolution=document.querySelector('.uncertain-resolution-form')?.closest('.app-modal');if(!resolution)throw new Error('uncertain resolution modal missing');const clear=[...resolution.querySelectorAll('button')].find(button=>norm(button.textContent)==='确认无此任务并清除');const checkbox=resolution.querySelector('.uncertain-clear-confirmation input');if(!clear||!checkbox)throw new Error('explicit uncertain clear controls missing');const clearInitiallyDisabled=clear.disabled;checkbox.click();await delay(60);const clearEnabledAfterConfirmation=!clear.disabled;clear.click();await waitSettled('vidu-submission:resolve');const end=Date.now()+3000;let deletion=null;while(Date.now()<end){deletion=[...document.querySelectorAll('.app-modal')].find(modal=>norm(modal.querySelector('h2')?.textContent).startsWith('删除分镜'));if(deletion)break;await delay(40);}if(!deletion)throw new Error('delete confirmation modal missing after uncertain clear');const remove=[...deletion.querySelectorAll('button')].find(button=>norm(button.textContent)==='删除');if(!remove||remove.disabled)throw new Error('confirmed storyboard delete unavailable');remove.click();await waitSettled('storyboards:delete');return {clicked:true,control:'待确认分镜 删除 -> 确认无网站任务 -> 删除',clearInitiallyDisabled,clearEnabledAfterConfirmation};`,
    "project-force-delete-tracked": `const target=row(1);if(!norm(target?.textContent).includes('暂不可用'))throw new Error('tracked unavailable storyboard fixture missing');const trash=target.querySelector('button[title="删除分镜"]');if(!trash)throw new Error('tracked storyboard delete trigger missing');trash.click();await delay(100);const deletion=[...document.querySelectorAll('.app-modal')].find(modal=>norm(modal.querySelector('h2')?.textContent).startsWith('删除分镜'));if(!deletion)throw new Error('tracked delete confirmation modal missing');const warning=norm(deletion.textContent);const remove=[...deletion.querySelectorAll('button')].find(button=>norm(button.textContent)==='停止跟踪并删除');if(!remove||remove.disabled)throw new Error('force delete action unavailable');remove.click();await waitSettled('storyboards:force-stop-video');await waitSettled('storyboards:delete');return {clicked:true,control:'暂不可用分镜 删除 -> 停止跟踪并删除',warningVisible:warning.includes('不会删除 Vidu 网站上的任务')&&warning.includes('不会自动检查或下载')};`,
    "project-resend": `rowButton(0,'重发');await waitCall('jobs:enqueue');return {clicked:true,control:'storyboard row 1 重发'};`,
    "project-check": `rowButton(1,'检查');await waitCall('vidu-submission:check');return {clicked:true,control:'storyboard row 2 检查'};`,
    "project-start": `click(buttons().find(b=>norm(b.textContent).startsWith('开始生成'))?norm(buttons().find(b=>norm(b.textContent).startsWith('开始生成')).textContent):'');await waitCall('jobs:enqueue');return {clicked:true,control:'开始生成'};`,
    "project-pause": `const start=buttons().find(b=>norm(b.textContent).startsWith('开始生成'));if(!start)throw new Error('start missing');start.click();await waitCall('jobs:enqueue');const pause=()=>document.querySelector('button[title="暂停全部"]');for(let end=Date.now()+5000;Date.now()<end&&pause()?.disabled;)await delay(25);if(!pause()||pause().disabled)throw new Error('pause remained disabled');pause().click();await waitCall('jobs:pause');return {clicked:true,control:'开始生成 -> 暂停全部'};`,
    "project-stop-one": `clickTitle('停止当前任务');await waitCall('storyboards:force-stop-video');return {clicked:true,control:'storyboard row 2 停止当前任务'};`,
    "project-q2-q3": `const labels=[...document.querySelectorAll('.toggle-row')];const q2=labels.find(x=>norm(x.textContent).includes('Q2 积分')).querySelector('input');const q3=labels.find(x=>norm(x.textContent).includes('Q3 前置')).querySelector('input');q2.click();q3.click();await delay(60);q3.click();await delay(60);const n=document.querySelector('.q3-pre-count-row input');setValue(n,'1');await delay(40);setValue(n,'0');await delay(200);return {clicked:true,control:'Q2积分/Q3前置/前置数量'};`,
    "jianying-normal": `click('导出到剪映');await waitCall('jianying:export');return {clicked:true,control:'导出到剪映'};`,
    "jianying-auto-srt": `const t=[...document.querySelectorAll('.toggle-row')].find(x=>norm(x.textContent).includes('自动剪辑')).querySelector('input');if(!t.checked)t.click();await delay(80);window.__AI_TOOL_INTERACTION_AUDIT__.clear();click('导出到剪映');await waitCall('jianying:export');return {clicked:true,control:'自动剪辑 -> 导出到剪映'};`,
    "inference-submit": `click('选择或拖入多个 TXT/DOCX');await waitCall('files:pick-documents');await delay(250);window.__AI_TOOL_INTERACTION_AUDIT__.clear();click('开始生成');await waitCall('jobs:enqueue');return {clicked:true,control:'选择 fixture -> 开始生成'};`,
    "polish-submit": `click('选择 TXT');await waitCall('files:pick-documents');await delay(250);window.__AI_TOOL_INTERACTION_AUDIT__.clear();click('开始捋文');await waitCall('jobs:enqueue');return {clicked:true,control:'选择 fixture -> 开始捋文'};`,
    "image-submit": `const el=document.querySelector('.image-workbench-prompts textarea');setValue(el,'审计角色\\n电影感青年角色全身设定');await delay(100);const b=buttons().find(x=>norm(x.textContent).startsWith('开始生成'));if(!b)throw new Error('image start missing');b.click();await waitCall('jobs:enqueue');return {clicked:true,control:'提示词批次 -> 开始生成'};`,
    "image-reference": `const prompt='使用上传参考图保持人物一致性';setValue(document.querySelector('.image-workbench-prompts textarea'),'审计参考图角色\\n'+prompt);await delay(100);const add=[...document.querySelectorAll('.image-workbench-references button')].find(b=>norm(b.textContent)==='添加 (0/4)');if(!add||add.disabled)throw new Error('reference add button unavailable');add.click();const pickCall=await waitSettled('files:pick-file');const referenceEnd=Date.now()+3000;let reference=null;while(Date.now()<referenceEnd){reference=document.querySelector('.image-workbench-reference');if(reference)break;await delay(40);}if(!reference)throw new Error('selected reference was not rendered');const referencePath=reference.title;const startEnd=Date.now()+5000;let start=null;while(Date.now()<startEnd){start=buttons().find(b=>norm(b.textContent).startsWith('开始生成'));if(start&&!start.disabled)break;await delay(40);}if(!start||start.disabled)throw new Error('image start unavailable');start.click();await waitSettled('jobs:enqueue',8000);const doneEnd=Date.now()+15000;let liveJobs=[];let target=null;while(Date.now()<doneEnd){liveJobs=await window.offline.jobs.list();target=liveJobs.find(job=>job.type==='image.standalone'&&job.input?.prompt===prompt);const card=document.querySelector('.image-workbench-result');if(target?.status==='done'&&card?.classList.contains('done')&&card.querySelector('.image-workbench-thumbnails img'))break;await delay(80);}const card=document.querySelector('.image-workbench-result');return {clicked:true,control:'添加参考图 -> 开始生成',prompt,referencePath,pickKind:pickCall?.args?.[0]??null,selectedReferenceVisible:Boolean(reference&&reference.title===referencePath),cardDone:Boolean(card?.classList.contains('done')),imageRendered:Boolean(card?.querySelector('.image-workbench-thumbnails img')),trackedBatch:localStorage.getItem('ai-tool.image-workbench.batch.v1'),mainResponsive:Boolean(target?.status==='done'),rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "image-edit-prompt": `const card=()=>document.querySelector('.image-workbench-result');const end=Date.now()+8000;while(Date.now()<end&&!card()?.classList.contains('done'))await delay(50);if(!card()?.classList.contains('done'))throw new Error('restored image card missing');const batchBefore=localStorage.getItem('ai-tool.image-workbench.batch.v1');const oldPrompt=norm(card().querySelector('.image-workbench-result-prompt')?.textContent);[...card().querySelectorAll('button')].find(b=>norm(b.textContent)==='编辑').click();await delay(60);setValue(card().querySelector('textarea'),'   ');await delay(60);const blankDisabled=Boolean([...card().querySelectorAll('button')].find(b=>norm(b.textContent)==='保存')?.disabled);setValue(card().querySelector('textarea'),'取消不保存提示词');await delay(40);[...card().querySelectorAll('button')].find(b=>norm(b.textContent)==='取消').click();await delay(60);const cancelRestored=norm(card().querySelector('.image-workbench-result-prompt')?.textContent)===oldPrompt;[...card().querySelectorAll('button')].find(b=>norm(b.textContent)==='编辑').click();await delay(50);setValue(card().querySelector('textarea'),'  保存后的角色提示词  ');await delay(50);[...card().querySelectorAll('button')].find(b=>norm(b.textContent)==='保存').click();await delay(80);const savedPrompt=norm(card().querySelector('.image-workbench-result-prompt')?.textContent);const editModeClosed=!card().querySelector('textarea');return {clicked:true,control:'编辑 -> 空白禁用 -> 取消 -> 编辑保存',oldPrompt,blankDisabled,cancelRestored,savedPrompt,editModeClosed,noticeVisible:document.body.innerText.includes('提示词已保存'),batchBefore,batchAfter:localStorage.getItem('ai-tool.image-workbench.batch.v1'),ipcCallCount:window.__AI_TOOL_INTERACTION_AUDIT__.snapshot().length,rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "image-resend": `const editedPrompt='重发提示词';const card=()=>document.querySelector('.image-workbench-result');const restoreEnd=Date.now()+8000;while(Date.now()<restoreEnd&&!card()?.classList.contains('done'))await delay(50);if(!card()?.classList.contains('done'))throw new Error('restored image card missing');const batchBefore=localStorage.getItem('ai-tool.image-workbench.batch.v1');[...card().querySelectorAll('button')].find(b=>norm(b.textContent)==='编辑').click();await delay(50);setValue(card().querySelector('textarea'),'  '+editedPrompt+'  ');await delay(50);[...card().querySelectorAll('button')].find(b=>norm(b.textContent)==='保存').click();await delay(70);[...card().querySelectorAll('button')].find(b=>norm(b.textContent)==='重发').click();const enqueueCall=await waitSettled('jobs:enqueue',8000);const doneEnd=Date.now()+15000;let liveJobs=[];let resent=null;while(Date.now()<doneEnd){liveJobs=await window.offline.jobs.list();resent=liveJobs.find(job=>job.type==='image.standalone'&&job.input?.prompt===editedPrompt);if(resent?.status==='done'&&card()?.classList.contains('done')&&norm(card().querySelector('.image-workbench-result-prompt')?.textContent)===editedPrompt)break;await delay(80);}return {clicked:true,control:'编辑保存提示词 -> 同卡重发',editedPrompt,enqueueType:enqueueCall?.args?.[0]??null,enqueueInput:enqueueCall?.args?.[1]??null,resentJobId:resent?.id??null,resentStatus:resent?.status??null,resentOutput:resent?.output??null,cardPrompt:norm(card()?.querySelector('.image-workbench-result-prompt')?.textContent),trackedBatchBefore:batchBefore,trackedBatchAfter:localStorage.getItem('ai-tool.image-workbench.batch.v1'),mainResponsive:Boolean(resent?.status==='done'),rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "image-open-dir": `const end=Date.now()+8000;while(Date.now()<end&&!document.querySelector('.image-workbench-result.done'))await delay(50);if(!document.querySelector('.image-workbench-result.done'))throw new Error('restored image result missing');click('打开保存目录');const openCall=await waitSettled('files:open-path');const liveJobs=await window.offline.jobs.list();return {clicked:true,control:'完成结果 -> 打开保存目录',openedPath:openCall?.args?.[0]??null,openedPathExists:Boolean(openCall?.status==='fulfilled'),trackedBatch:localStorage.getItem('ai-tool.image-workbench.batch.v1'),mainResponsive:liveJobs.some(job=>job.id==='00000000-0000-4000-8000-000000000006'&&job.status==='done'),rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "image-stop-one": `const firstPrompt='第一张停止测试';const secondPrompt='第二张继续运行';setValue(document.querySelector('.image-workbench-prompts textarea'),'审计停止甲\\n'+firstPrompt+'\\n###\\n审计停止乙\\n'+secondPrompt);await delay(100);const batchBefore=localStorage.getItem('ai-tool.image-workbench.batch.v1');const startEnd=Date.now()+5000;let start=null;while(Date.now()<startEnd){start=buttons().find(b=>norm(b.textContent).startsWith('开始生成'));if(start&&!start.disabled)break;await delay(40);}if(!start||start.disabled)throw new Error('image start unavailable');start.click();const enqueueEnd=Date.now()+8000;while(Date.now()<enqueueEnd&&window.__AI_TOOL_INTERACTION_AUDIT__.snapshot().filter(call=>call.channel==='jobs:enqueue'&&call.status==='fulfilled').length<2)await delay(40);const cardsEnd=Date.now()+5000;let cards=[];while(Date.now()<cardsEnd){cards=[...document.querySelectorAll('.image-workbench-result')];if(cards.length===2&&cards.every(card=>card.querySelector('button[title="停止"]')))break;await delay(40);}if(cards.length!==2)throw new Error('two active image cards were not rendered');let liveJobs=await window.offline.jobs.list();const target=liveJobs.find(job=>job.type==='image.standalone'&&job.input?.prompt===firstPrompt);const other=liveJobs.find(job=>job.type==='image.standalone'&&job.input?.prompt===secondPrompt);if(!target||!other)throw new Error('two durable image jobs were not found');cards[0].querySelector('button[title="停止"]').click();const cancelCall=await waitSettled('jobs:cancel');const stoppedEnd=Date.now()+4000;while(Date.now()<stoppedEnd){cards=[...document.querySelectorAll('.image-workbench-result')];if(cards[0]?.classList.contains('cancelled'))break;await delay(40);}liveJobs=await window.offline.jobs.list();cards=[...document.querySelectorAll('.image-workbench-result')];const targetHasStop=Boolean(cards[0]?.querySelector('button[title="停止"]'));const otherStillStoppable=Boolean(cards[1]?.querySelector('button[title="停止"]'));const targetState=cards[0]?.querySelector('.job-state');return {clicked:true,control:'两个独立生图任务 -> 第一张卡停止',targetJobId:target.id,otherJobId:other.id,cancelledJobId:cancelCall?.args?.[0]??null,targetStoppedUi:Boolean(cards[0]?.classList.contains('cancelled')&&norm(targetState?.textContent)==='已停止'&&!targetHasStop),otherStillStoppable,batchBefore,batchAfter:localStorage.getItem('ai-tool.image-workbench.batch.v1'),mainResponsive:Boolean(liveJobs.find(job=>job.id===target.id)?.status==='cancelled'&&['queued','running'].includes(liveJobs.find(job=>job.id===other.id)?.status)),rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "settings-inference-save": `const panel=document.querySelector('#settings-panel-inference');const labels=[...panel.querySelectorAll('label')];const field=(name)=>{const l=labels.find(x=>norm(x.querySelector('span')?.textContent)===name);return l?.querySelector('input,textarea,select')};setValue(field('API 地址'),'https://audit.invalid/v1');setValue(field('模型'),'audit-model');setValue(field('分镜输出目录'),'C:\\\\AI审计\\\\推理新目录');click('保存设置');await waitCall('settings:set');return {clicked:true,control:'推理设置 保存设置'};`,
    "settings-polish-save": `const panel=document.querySelector('#settings-panel-text-polish');const labels=[...panel.querySelectorAll('label')];const field=(name)=>{const l=labels.find(x=>norm(x.querySelector('span')?.textContent)===name);return l?.querySelector('input,textarea,select')};setValue(field('API 地址'),'https://audit.invalid/v1');setValue(field('模型'),'deepseek-chat');setValue(field('输出目录'),'C:\\\\AI审计\\\\捋文新目录');click('保存设置');await waitCall('settings:set');return {clicked:true,control:'捋文设置 保存设置'};`,
    "batch-add-remove": `const select=document.querySelector('.project-batch-add select');select.options[0].selected=true;select.dispatchEvent(new Event('change',{bubbles:true}));await delay(60);buttons().find(x=>norm(x.textContent).startsWith('加入队列')).click();await delay(80);click('今晚 00:10');await delay(60);clickTitle('取消定时');document.querySelector('.project-batch-checkbox').click();await delay(40);buttons().find(x=>norm(x.textContent).startsWith('批量删除')).click();await delay(80);return {clicked:true,control:'加入队列 -> 定时/取消 -> 批量删除',snapshot:JSON.parse(localStorage.getItem('ai-tool.batch-queue.v1'))};`,
    "batch-start": `click('开始队列');await waitCall('jobs:enqueue');return {clicked:true,control:'开始队列'};`,
    "batch-stop": `click('开始队列');await waitCall('jobs:enqueue');const end=Date.now()+3000;while(Date.now()<end&&!buttons().some(x=>norm(x.textContent)==='停止队列'))await delay(40);click('停止队列');await delay(1300);return {clicked:true,control:'开始队列 -> 停止队列',snapshot:JSON.parse(localStorage.getItem('ai-tool.batch-queue.v1'))};`,
    "batch-skip": `click('开始队列');await waitCall('jobs:enqueue');const end=Date.now()+3000;while(Date.now()<end&&!buttons().some(x=>norm(x.textContent)==='跳过当前'))await delay(40);click('跳过当前');await delay(1300);return {clicked:true,control:'开始队列 -> 跳过当前',snapshot:JSON.parse(localStorage.getItem('ai-tool.batch-queue.v1'))};`,
    "batch-reorder": `clickTitle('下移');await delay(150);return {clicked:true,control:'队列首项下移',snapshot:JSON.parse(localStorage.getItem('ai-tool.batch-queue.v1'))};`,
    "batch-custom-schedule": `const input=document.querySelector('.project-batch-schedule input[type="datetime-local"]');const future=new Date(Date.now()+86400000);const local=new Date(future.getTime()-future.getTimezoneOffset()*60000).toISOString().slice(0,16);setValue(input,local);await delay(150);return {clicked:true,control:'自定义定时',snapshot:JSON.parse(localStorage.getItem('ai-tool.batch-queue.v1'))};`,
    "batch-clear-completed": `click('清空已处理');await delay(150);return {clicked:true,control:'清空已处理',snapshot:JSON.parse(localStorage.getItem('ai-tool.batch-queue.v1'))};`,
    "opening-fetch": `const input=document.querySelector('input[placeholder^="https://book.qq.com"]');setValue(input,'https://book.qq.com/book-detail/audit');click('抓取');await waitCall('files:fetch-qq-novel');return {clicked:true,control:'QQ阅读抓取'};`,
    "opening-submit": `click('文件');await delay(60);click('选择 TXT/DOCX');await waitCall('files:pick-document');await delay(150);window.__AI_TOOL_INTERACTION_AUDIT__.clear();click('生成开头');await waitCall('jobs:enqueue');return {clicked:true,control:'文件 -> 生成开头'};`,
    "opening-stop": `click('文件');await delay(60);click('选择 TXT/DOCX');await waitCall('files:pick-document');await delay(150);window.__AI_TOOL_INTERACTION_AUDIT__.clear();click('生成开头');await waitCall('jobs:enqueue');const end=Date.now()+3000;while(Date.now()<end&&!buttons().some(x=>norm(x.textContent)==='停止'))await delay(30);click('停止');await waitCall('jobs:cancel');return {clicked:true,control:'生成开头 -> 停止'};`,
    "opening-export": `const end=Date.now()+4000;while(Date.now()<end&&document.querySelector('button[title="导出 TXT"]')?.disabled)await delay(60);clickTitle('导出 TXT');await waitCall('files:write-text');return {clicked:true,control:'导出 TXT'};`,
    "opening-docx": `click('文件');await delay(60);click('选择 TXT/DOCX');await waitCall('files:pick-document');await delay(150);window.__AI_TOOL_INTERACTION_AUDIT__.clear();click('生成开头');await waitCall('jobs:enqueue');const end=Date.now()+12000;while(Date.now()<end&&!document.body.innerText.includes('候选开头 · 5 个'))await delay(80);return {clicked:true,control:'DOCX -> 生成开头',docxResultCaptured:document.body.innerText.includes('候选开头 · 5 个'),trackedJobId:localStorage.getItem('ai-tool.text-workbench.opening.job.v1')};`,
    "opening-enhanced": `click('增强版');click('文件');await delay(60);click('选择 TXT/DOCX');await waitCall('files:pick-document');await delay(150);window.__AI_TOOL_INTERACTION_AUDIT__.clear();click('生成开头');await waitCall('jobs:enqueue');const end=Date.now()+12000;while(Date.now()<end&&!document.body.innerText.includes('候选开头 · 10 个'))await delay(80);return {clicked:true,control:'增强版 -> 文件 -> 生成开头',enhancedResultCaptured:document.body.innerText.includes('候选开头 · 10 个'),trackedJobId:localStorage.getItem('ai-tool.text-workbench.opening.job.v1')};`,
    "opening-copy-expand": `const clipboardWrites=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value)=>{clipboardWrites.push(String(value));}}});const trackedBefore=localStorage.getItem('ai-tool.text-workbench.opening.job.v1');clickTitle('复制开头 1');await delay(80);clickTitle('只复制正文');await delay(80);const details=document.querySelector('.opening-body-result details');if(!details)throw new Error('opening body details missing');details.querySelector('summary').click();await delay(40);const expanded=details.open;details.querySelector('summary').click();await delay(40);const collapsed=!details.open;return {clicked:true,control:'复制开头1 -> 只复制正文 -> 展开/收起正文',clipboardWrites,bodyExpandedThenCollapsed:expanded&&collapsed,trackedJobIdBefore:trackedBefore,trackedJobIdAfter:localStorage.getItem('ai-tool.text-workbench.opening.job.v1')};`,
    "opening-select-output": `click('更换输出目录');await waitCall('files:pick-directory');await waitCall('settings:set');const call=[...window.__AI_TOOL_INTERACTION_AUDIT__.snapshot()].reverse().find(x=>x.channel==='settings:set');return {clicked:true,control:'更换输出目录',selectedOutputDirectory:call?.args?.[1]??null};`,
    "opening-export-open-dir": `const end=Date.now()+5000;while(Date.now()<end&&document.querySelector('button[title="导出 TXT"]')?.disabled)await delay(60);clickTitle('导出 TXT');await waitSettled('files:write-text');const openEnd=Date.now()+3000;while(Date.now()<openEnd&&!document.querySelector('button[title="打开输出目录"]'))await delay(40);clickTitle('打开输出目录');const openCall=await waitSettled('files:open-path');return {clicked:true,control:'导出 TXT -> 打开输出目录',openedPathExists:Boolean(openCall&&openCall.status==='fulfilled'),openedPath:openCall?.args?.[0]??null};`,
    "settings-webhook-save-test": `const input=document.querySelector('input[placeholder^="https://qyapi.weixin.qq.com"]');setValue(input,'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=audit');const toggle=[...document.querySelectorAll('#settings-panel-notifications input[type="checkbox"]')][0];if(!toggle.checked)toggle.click();await delay(50);click('发送测试消息');await waitCall('notifications:test');return {clicked:true,control:'Webhook 保存并发送测试消息'};`,
    "settings-account-add": `const add=()=>buttons().find(b=>norm(b.textContent)==='添加账号');for(let end=Date.now()+5000;Date.now()<end&&add()?.disabled;)await delay(50);if(!add()||add().disabled)throw new Error('add account remained disabled');add().click();await delay(80);const modal=document.querySelector('.vidu-account-modal');if(!modal)throw new Error('account creator missing');setValue(modal.querySelector('input:not([type]),input[type="text"]'),'新增积分审计号');setSelect(modal.querySelector('select'),'points');await delay(80);setValue(modal.querySelector('input[type="number"]'),'88');await delay(50);click('添加');await waitSettled('vidu-accounts:create');await delay(120);const accounts=await window.offline.vidu.listAccounts();return {clicked:true,control:'添加账号 -> 单个添加',createdVisible:accounts.some(a=>a.name==='新增积分审计号'&&a.accountType==='points'&&a.defaultQuota===88),sessionKeyUnique:new Set(accounts.map(a=>a.sessionKey)).size===accounts.length,mainResponsive:true,rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "settings-account-delete-one": `const getRows=()=>[...document.querySelectorAll('.vidu-account-row')];const beforeAccounts=await window.offline.vidu.listAccounts();const target=beforeAccounts[1];const getDelete=()=>getRows()[1]?.querySelector('button[title="删除账号和本地会话"]');for(let end=Date.now()+5000;Date.now()<end&&getDelete()?.disabled;)await delay(50);if(!getDelete()||getDelete().disabled)throw new Error('selected account delete remained disabled');getDelete().click();const deleteCall=await waitSettled('vidu-accounts:delete',10000);await delay(100);const afterAccounts=await window.offline.vidu.listAccounts();return {clicked:true,control:'第二个账号 -> 删除账号和本地会话',deletedAccountId:target?.id??null,targetRemoved:Boolean(target&&!afterAccounts.some(a=>a.id===target.id)),otherAccountsPreserved:beforeAccounts.filter(a=>a.id!==target?.id).every(a=>afterAccounts.some(b=>b.id===a.id)),sessionCleanupVerified:Boolean(deleteCall?.status==='fulfilled'&&target&&!afterAccounts.some(a=>a.id===target.id)),mainResponsive:true,rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "settings-account-reorder": `const beforeAccounts=await window.offline.vidu.listAccounts();const getMove=()=>document.querySelectorAll('.vidu-account-row')[1]?.querySelector('button[title="上移账号"]');for(let end=Date.now()+5000;Date.now()<end&&getMove()?.disabled;)await delay(50);if(!getMove()||getMove().disabled)throw new Error('move account remained disabled');getMove().click();await waitSettled('vidu-accounts:move');await delay(120);const afterAccounts=await window.offline.vidu.listAccounts();return {clicked:true,control:'第二个账号 -> 上移账号',beforeOrder:beforeAccounts.map(a=>a.id),afterOrder:afterAccounts.map(a=>a.id),mainResponsive:true,rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "settings-account-toggle": `const getCheckbox=()=>document.querySelector('.vidu-account-row .vidu-account-enabled input');for(let end=Date.now()+5000;Date.now()<end&&getCheckbox()?.disabled;)await delay(50);let checkbox=getCheckbox();if(!checkbox||checkbox.disabled)throw new Error('account toggle remained disabled');checkbox.click();await waitCallCount('vidu-accounts:update',1);await delay(100);checkbox=getCheckbox();if(!checkbox||checkbox.disabled)throw new Error('account re-enable remained disabled');checkbox.click();const updates=await waitCallCount('vidu-accounts:update',2);await delay(100);const account=(await window.offline.vidu.listAccounts())[0];return {clicked:true,control:'账号停用 -> 重新启用',updatePatches:updates.map(call=>call.args?.[1]),finalEnabled:account?.enabled===true,disabledFieldsCleared:account?.disabledReason===null&&account?.disabledMessage===null&&account?.disabledAt===null,mainResponsive:true,rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "settings-account-edit": `const getRow=()=>document.querySelector('.vidu-account-row');for(let end=Date.now()+5000;Date.now()<end&&getRow()?.querySelector('.vidu-account-name')?.disabled;)await delay(50);let accountRow=getRow();let nameInput=accountRow?.querySelector('.vidu-account-name');if(!nameInput||nameInput.disabled)throw new Error('account edit remained disabled');nameInput.focus();setValue(nameInput,'已编辑审计号');await delay(80);accountRow=getRow();nameInput=accountRow.querySelector('.vidu-account-name');nameInput.focus();nameInput.blur();await waitCallCount('vidu-accounts:update',1);await delay(100);accountRow=getRow();setSelect(accountRow.querySelector('.vidu-account-config select'),'points');await waitCallCount('vidu-accounts:update',2);await delay(100);accountRow=getRow();let quota=accountRow.querySelector('input[type="number"]');quota.focus();setValue(quota,'77');await delay(80);accountRow=getRow();quota=accountRow.querySelector('input[type="number"]');quota.focus();quota.blur();const updates=await waitCallCount('vidu-accounts:update',3);await delay(100);const account=(await window.offline.vidu.listAccounts())[0];return {clicked:true,control:'编辑账号名称/类型/额度',updateCount:updates.length,finalAccount:{name:account?.name,accountType:account?.accountType,defaultQuota:account?.defaultQuota},mainResponsive:true,rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "settings-account-daily-reset": `const reset=()=>buttons().find(b=>norm(b.textContent)==='重置每日用量');for(let end=Date.now()+5000;Date.now()<end&&reset()?.disabled;)await delay(50);if(!reset()||reset().disabled)throw new Error('daily reset remained disabled');reset().click();await waitSettled('vidu-accounts:reset-daily-usage');await delay(100);const accounts=await window.offline.vidu.listAccounts();return {clicked:true,control:'重置每日用量',memberUsage:accounts.find(a=>a.accountType==='member')?.usageCount,pointsUsage:accounts.find(a=>a.accountType==='points')?.usageCount,mainResponsive:true,rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "settings-account-clear-flags": `const getReason=()=>document.querySelector('.account-disabled-reason');for(let end=Date.now()+5000;Date.now()<end&&getReason()?.disabled;)await delay(50);const reason=getReason();if(!reason||reason.disabled||!norm(reason.textContent).includes('主体限频'))throw new Error('subject-limit reason control missing');reason.click();await waitSettled('vidu-accounts:update');await delay(100);const account=(await window.offline.vidu.listAccounts())[0];const legacyAccountIssuesAbsent=!Object.keys(localStorage).some(key=>/accountIssues/iu.test(key));return {clicked:true,control:'主体限频 -> 解除',legacyAccountIssuesAbsent,cleared:Boolean(account?.enabled&&account.disabledReason===null&&account.disabledMessage===null&&account.disabledAt===null),mainResponsive:true,rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "settings-account-unblock": `const getReason=()=>document.querySelector('.account-disabled-reason');for(let end=Date.now()+5000;Date.now()<end&&getReason()?.disabled;)await delay(50);const reason=getReason();if(!reason||reason.disabled||!norm(reason.textContent).includes('积分耗尽'))throw new Error('credits-exhausted reason control missing');reason.click();await waitSettled('vidu-accounts:update');await delay(100);const account=(await window.offline.vidu.listAccounts())[0];const legacyAccountIssuesAbsent=!Object.keys(localStorage).some(key=>/accountIssues/iu.test(key));return {clicked:true,control:'积分耗尽 -> 解除',legacyAccountIssuesAbsent,cleared:Boolean(account?.enabled&&account.disabledReason===null&&account.disabledMessage===null&&account.disabledAt===null),mainResponsive:true,rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "settings-account-login-check": `const accountRow=document.querySelector('.vidu-account-row');[...accountRow.querySelectorAll('button')].find(x=>norm(x.textContent)==='登录').click();await waitCall('vidu-accounts:open-login');const end=Date.now()+5000;const check=()=>[...accountRow.querySelectorAll('button')].find(x=>x.title==='检测登录状态');while(Date.now()<end&&check().disabled)await delay(80);check().click();await waitCall('vidu-accounts:check');return {clicked:true,control:'账号登录 -> 检测登录状态'};`,
    "settings-account-jwt-import": `click('添加账号');await delay(80);click('批量 JWT');await delay(80);const textarea=document.querySelector('.vidu-jwt-import textarea');return {clicked:Boolean(textarea&&buttons().find(x=>norm(x.textContent)==='开始导入')?.disabled),control:'打开批量JWT界面（未注入凭据）'};`,
    "theme-toggle": `const sequence=[];clickTitle('切换到深色模式');await delay(100);sequence.push(localStorage.getItem('ai-tool-theme'));const darkModeReached=document.documentElement.dataset.theme==='dark';clickTitle('切换到浅色模式');await delay(100);sequence.push(localStorage.getItem('ai-tool-theme'));const lightModeRestored=document.documentElement.dataset.theme==='light';const liveJobs=await window.offline.jobs.list();return {clicked:true,control:'浅色 -> 深色 -> 浅色',darkModeReached,lightModeRestored,persistedThemeSequence:sequence,domThemeSynchronized:darkModeReached&&lightModeRestored&&sequence.join(',')==='dark,light',mainResponsive:Array.isArray(liveJobs),rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "logout": `const logoutControlPresent=Boolean(document.querySelector('[title="退出登录"]')||buttons().some(b=>norm(b.textContent)==='退出登录'));const authKeysRequired=['token','user','deviceId'].some(key=>localStorage.getItem(key)!==null);window.location.hash='#/inference';window.dispatchEvent(new HashChangeEvent('hashchange'));await delay(500);const inferenceHash=window.location.hash;const inferenceReachable=document.body.innerText.includes('小说转分镜')&&inferenceHash.startsWith('#/inference');window.location.hash='#/settings?tab=browsers';window.dispatchEvent(new HashChangeEvent('hashchange'));await delay(500);const settingsHash=window.location.hash;const settingsReachable=document.body.innerText.includes('浏览器账号池')&&settingsHash.startsWith('#/settings');const liveJobs=await window.offline.jobs.list();return {clicked:true,control:'无登录门禁直接访问业务路由',logoutControlPresent,authKeysRequired,businessRoutesDirectlyAccessible:inferenceReachable&&settingsReachable,authDatabaseDependency:false,autoLogoutAbsent:inferenceReachable&&settingsReachable,inferenceHash,settingsHash,mainResponsive:Array.isArray(liveJobs),rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "updater-check": `click('检查更新');await delay(100);const text=document.body.innerText;const localDeploymentNoticeVisible=text.includes('源码部署版')&&text.includes('更新不依赖原作者服务器')&&text.includes('新版安装包直接覆盖');const mentionsDataRetention=text.includes('本地数据会保留');const liveJobs=await window.offline.jobs.list();return {clicked:true,control:'检查更新 -> 本地覆盖安装说明',localDeploymentNoticeVisible,mentionsDataRetention,mainResponsive:Array.isArray(liveJobs),rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "project-delete": `const card=document.querySelectorAll('.project-card')[0];const b=[...card.querySelectorAll('button')].find(x=>x.title==='删除项目');if(!b||b.disabled)throw new Error('deletable project button missing');b.click();await waitCall('projects:delete');return {clicked:true,control:'项目卡片 删除项目'};`,
    "project-reset": `click('清空重来');await delay(80);click('确认清空');await waitCall('storyboards:reset-project');return {clicked:true,control:'清空重来 -> 确认清空'};`,
    "project-check-all": `click('一键检查');await waitCall('vidu-submission:check');return {clicked:true,control:'一键检查'};`,
    "project-force-stop": `clickTitle('强制停止全部');await waitCall('storyboards:force-stop-video');return {clicked:true,control:'强制停止全部'};`,
    "project-open-video": `const b=row(0).querySelector('button[title="用系统播放器或看图工具打开"]');if(!b)throw new Error('video open button missing');b.click();await waitCall('media:open');return {clicked:true,control:'视频预览 使用系统播放器打开'};`,
    "inference-stop": `click('选择或拖入多个 TXT/DOCX');await waitCall('files:pick-documents');await delay(200);window.__AI_TOOL_INTERACTION_AUDIT__.clear();click('开始生成');await waitCall('jobs:enqueue');const end=Date.now()+5000;while(Date.now()<end&&!buttons().some(x=>norm(x.textContent)==='停止'))await delay(20);click('停止');await waitCall('jobs:cancel');return {clicked:true,control:'开始生成 -> 单任务停止'};`,
    "inference-multi-file": `click('选择或拖入多个 TXT/DOCX');await waitCall('files:pick-documents');await delay(250);const cards=[...document.querySelectorAll('.inference-source-list > div')];return {clicked:cards.length===2,control:'多选两个 TXT 文案',sourceCount:cards.length,titles:cards.map(x=>norm(x.querySelector('span')?.textContent))};`,
    "inference-open-output": `clickTitle('打开输出目录');await waitCall('files:open-path');return {clicked:true,control:'打开输出目录'};`,
    "inference-stop-one": `click('选择或拖入多个 TXT/DOCX');await waitSettled('files:pick-documents');await delay(200);window.__AI_TOOL_INTERACTION_AUDIT__.clear();click('开始生成');const enqueueEnd=Date.now()+8000;while(Date.now()<enqueueEnd&&window.__AI_TOOL_INTERACTION_AUDIT__.snapshot().filter(x=>x.channel==='jobs:enqueue'&&x.status==='fulfilled').length<2)await delay(40);const cardEnd=Date.now()+5000;let cards=[];while(Date.now()<cardEnd){cards=[...document.querySelectorAll('.inference-task-card')];if(cards.length>=2&&cards.every(card=>[...card.querySelectorAll('button')].some(b=>norm(b.textContent)==='停止')))break;await delay(40);}if(cards.length<2)throw new Error('two inference task cards were not rendered');const target=cards[0];const targetTitle=norm(target.querySelector('strong')?.textContent);const otherTitle=norm(cards[1].querySelector('strong')?.textContent);const stop=[...target.querySelectorAll('button')].find(b=>norm(b.textContent)==='停止');if(!stop)throw new Error('target task stop button missing');stop.click();const cancelCall=await waitSettled('jobs:cancel');await delay(300);const liveJobs=await window.offline.jobs.list();cards=[...document.querySelectorAll('.inference-task-card')];const targetAfter=cards.find(card=>norm(card.querySelector('strong')?.textContent)===targetTitle);const otherAfter=cards.find(card=>norm(card.querySelector('strong')?.textContent)===otherTitle);const targetState=targetAfter?.querySelector('.job-state');const targetHasStop=Boolean(targetAfter&&[...targetAfter.querySelectorAll('button')].some(b=>norm(b.textContent)==='停止'));const otherStillStoppable=Boolean(otherAfter&&[...otherAfter.querySelectorAll('button')].some(b=>norm(b.textContent)==='停止'));return {clicked:true,control:'两个推理任务 -> 第一张任务卡停止',cancelledJobId:cancelCall?.args?.[0]??null,targetTitle,otherTitle,targetStatus:norm(targetState?.textContent),targetStoppedUi:Boolean(targetState?.classList.contains('cancelled')&&norm(targetState.textContent)==='已停止'&&!targetHasStop),otherStillStoppable,mainResponsive:liveJobs.some(job=>job.id===cancelCall?.args?.[0]),rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "inference-genre": `const select=document.querySelector('.inference-control-panel select');if(!select)throw new Error('inference genre select missing');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'玄幻');select.dispatchEvent(new Event('change',{bubbles:true}));await delay(80);click('选择或拖入多个 TXT/DOCX');await waitSettled('files:pick-documents');await delay(160);const title=norm(document.querySelector('.inference-source-list > div span')?.textContent);window.__AI_TOOL_INTERACTION_AUDIT__.clear();click('开始生成');await waitSettled('jobs:enqueue',8000);const liveJobs=await window.offline.jobs.list();const mainResponsive=liveJobs.some(job=>job.type==='storyboard.infer');return {clicked:true,control:'题材选择玄幻/修真 -> 文档 -> 开始生成',title,selectedGenre:select.value,selectedGenreLabel:select.selectedOptions[0]?.textContent??'',durableJobVisible:mainResponsive,mainResponsive,rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "inference-paused-open": `const end=Date.now()+8000;let button=null;while(Date.now()<end){button=[...document.querySelectorAll('.inference-task-retained button')].find(b=>norm(b.textContent)==='打开待修复目录');if(button)break;await delay(50);}if(!button)throw new Error('retained inference directory button missing');const card=button.closest('.inference-task-card');const retainedSpan=card?.querySelector('.inference-task-retained span');const state=card?.querySelector('.job-state');const retainedDirectory=retainedSpan?.title||norm(retainedSpan?.textContent).replace(/^待修复目录：/u,'');button.click();const openCall=await waitSettled('files:open-path');const liveJobs=await window.offline.jobs.list();const actualPaused=Boolean(state?.classList.contains('paused')&&norm(state.textContent)==='已暂停');return {clicked:true,control:'恢复暂停推理任务 -> 打开待修复目录',retainedDirectory,openedPath:openCall?.args?.[0]??null,openedPathExists:Boolean(openCall?.status==='fulfilled'),retainedJobStatus:actualPaused?'paused/retained':norm(state?.textContent),actualPaused,mainResponsive:liveJobs.some(job=>job.id===${JSON.stringify(pausedInferenceJobId)}&&job.status==='paused'),rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "polish-stop": `click('选择 TXT');await waitSettled('files:pick-documents');await delay(180);window.__AI_TOOL_INTERACTION_AUDIT__.clear();click('开始捋文');await waitSettled('jobs:enqueue');const end=Date.now()+5000;while(Date.now()<end&&!buttons().some(b=>norm(b.textContent)==='停止'))await delay(40);click('停止');const cancelCall=await waitSettled('jobs:cancel');await delay(300);const trackedJobId=localStorage.getItem('ai-tool.text-workbench.polish.job.v1');const liveJobs=await window.offline.jobs.list();const hasRetry=buttons().some(b=>norm(b.textContent)==='重试');const hasStop=buttons().some(b=>norm(b.textContent)==='停止');return {clicked:true,control:'原版 TXT -> 开始捋文 -> 停止',cancelledJobId:cancelCall?.args?.[0]??null,trackedJobId,retryStateRetained:Boolean(trackedJobId&&trackedJobId===cancelCall?.args?.[0]&&hasRetry),notStuck:Boolean(document.body.innerText.includes('已停止')&&!hasStop),mainResponsive:liveJobs.some(job=>job.id===cancelCall?.args?.[0]&&job.status==='cancelled'),rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "polish-export-open": `const end=Date.now()+8000;let editor=null;while(Date.now()<end){editor=document.querySelector('textarea.document-editor.result');if(editor&&!editor.readOnly)break;await delay(50);}if(!editor||editor.readOnly)throw new Error('restored polish result editor missing');const editedResult=${JSON.stringify(polishEditedResult)};setValue(editor,editedResult);await delay(100);const clipboardWrites=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value)=>{clipboardWrites.push(String(value));}}});const trackedJobIdBefore=localStorage.getItem('ai-tool.text-workbench.polish.job.v1');clickTitle('复制结果');await delay(80);clickTitle('导出 TXT');const writeCall=await waitSettled('files:write-text');const openEnd=Date.now()+3000;while(Date.now()<openEnd&&!document.querySelector('button[title="打开输出目录"]'))await delay(40);clickTitle('打开输出目录');const openCall=await waitSettled('files:open-path');const liveJobs=await window.offline.jobs.list();return {clicked:true,control:'编辑捋文结果 -> 复制 -> 导出 TXT -> 打开输出目录',editedResult,clipboardWrites,writeDirectory:writeCall?.args?.[0]?.directory??null,openedPath:openCall?.args?.[0]??null,openedPathExists:Boolean(openCall?.status==='fulfilled'),trackedJobIdBefore,trackedJobIdAfter:localStorage.getItem('ai-tool.text-workbench.polish.job.v1'),mainResponsive:liveJobs.some(job=>job.id===${JSON.stringify(polishExportJobId)}&&job.status==='done'),rendererAlive:Boolean(document.body.isConnected&&window.offline)};`,
    "settings-folder-save": `const panel=document.querySelector('#settings-panel-folder');setValue(panel.querySelector('input'),'C:\\\\AI审计\\\\选择目录');click('保存设置');await waitCall('settings:set');return {clicked:true,control:'项目文件夹 保存设置'};`,
    "settings-opening-save": `const panel=document.querySelector('#settings-panel-novel-optimizer');setValue(panel.querySelector('input'),'C:\\\\AI审计\\\\开头新目录');click('保存设置');await waitCall('settings:set');return {clicked:true,control:'开头优化 保存设置'};`,
    "settings-image-save": `const panel=document.querySelector('#settings-panel-imagegen');const labels=[...panel.querySelectorAll('label')];const field=(name)=>labels.find(x=>norm(x.querySelector('span')?.textContent)===name)?.querySelector('input,textarea,select');setValue(field('API 地址'),'https://example.invalid/v1');setValue(field('模型'),'gpt-image-2');setValue(field('生图输出目录'),'C:\\\\AI审计\\\\图片新目录');click('保存设置');await waitCall('settings:set');return {clicked:true,control:'出图设置 保存设置'};`,
    "settings-jianying-save": `const panel=document.querySelector('#settings-panel-jianying');setValue(panel.querySelector('input'),'C:\\\\AI审计\\\\剪映新目录');click('保存设置');await waitCall('settings:set');return {clicked:true,control:'剪映路径 保存设置'};`,
    "settings-account-batch-delete": `const end=Date.now()+5000;const get=()=>buttons().find(x=>norm(x.textContent)==='删除全部积分账号');while(Date.now()<end&&get()?.disabled)await delay(50);const b=get();if(!b||b.disabled)throw new Error('batch points delete button unavailable');b.click();await waitSettled('vidu-accounts:delete');return {clicked:true,control:'删除全部积分账号'};`,
  };
  return `(async()=>{${common}${actions[id]}})()`;
}

function expectedChannels(id) {
  return {
    "project-create": ["projects:create"],
    "project-import-csv": ["files:pick-csv", "files:copy-into-directory", "storyboards:replace", "projects:update"],
    "project-update-media": ["files:pick-file", "projects:update"],
    "project-batch-edit": ["storyboards:update"],
    "project-edit-prompt": ["storyboards:update"],
    "project-uncertain-clear-delete": ["vidu-submission:resolve", "storyboards:delete"],
    "project-force-delete-tracked": ["storyboards:force-stop-video", "storyboards:delete"],
    "project-resend": ["jobs:enqueue"],
    "project-check": ["vidu-submission:check"],
    "project-start": ["jobs:enqueue"],
    "project-pause": ["jobs:enqueue", "jobs:pause"],
    "project-stop-one": ["storyboards:force-stop-video"],
    "project-q2-q3": ["settings:set"],
    "jianying-normal": ["jianying:export"],
    "jianying-auto-srt": ["files:read-subtitle", "jianying:export"],
    "inference-submit": ["projects:create", "files:write-text", "jobs:enqueue"],
    "polish-submit": ["jobs:enqueue"],
    "image-submit": ["jobs:enqueue"],
    "image-reference": ["files:pick-file", "jobs:enqueue"],
    "image-edit-prompt": [],
    "image-resend": ["jobs:enqueue"],
    "image-open-dir": ["files:open-path"],
    "image-stop-one": ["jobs:enqueue", "jobs:cancel"],
    "settings-inference-save": ["settings:set"],
    "settings-polish-save": ["settings:set"],
    "batch-add-remove": [],
    "batch-start": ["jobs:enqueue"],
    "batch-stop": ["jobs:enqueue"],
    "batch-skip": ["jobs:enqueue"],
    "batch-reorder": [],
    "batch-custom-schedule": [],
    "batch-clear-completed": [],
    "opening-fetch": ["files:fetch-qq-novel"],
    "opening-submit": ["jobs:enqueue"],
    "opening-stop": ["jobs:enqueue", "jobs:cancel"],
    "opening-export": ["files:write-text"],
    "opening-docx": ["jobs:enqueue"],
    "opening-enhanced": ["jobs:enqueue"],
    "opening-copy-expand": [],
    "opening-select-output": ["files:pick-directory", "settings:set"],
    "opening-export-open-dir": ["files:write-text", "files:open-path"],
    "settings-webhook-save-test": ["settings:set", "notifications:test"],
    "settings-account-add": ["vidu-accounts:create"],
    "settings-account-delete-one": ["vidu-accounts:delete"],
    "settings-account-reorder": ["vidu-accounts:move"],
    "settings-account-toggle": ["vidu-accounts:update"],
    "settings-account-edit": ["vidu-accounts:update"],
    "settings-account-daily-reset": ["vidu-accounts:reset-daily-usage"],
    "settings-account-clear-flags": ["vidu-accounts:update"],
    "settings-account-unblock": ["vidu-accounts:update"],
    "settings-account-login-check": ["vidu-accounts:open-login", "vidu-accounts:check"],
    "settings-account-jwt-import": [],
    "theme-toggle": [],
    "logout": [],
    "updater-check": [],
    "project-delete": ["projects:delete"],
    "project-reset": ["storyboards:reset-project"],
    "project-check-all": ["vidu-submission:check"],
    "project-force-stop": ["storyboards:force-stop-video"],
    "project-open-video": ["media:open"],
    "inference-stop": ["jobs:enqueue", "jobs:cancel"],
    "inference-multi-file": ["files:pick-documents"],
    "inference-open-output": ["files:open-path"],
    "inference-stop-one": ["projects:create", "files:write-text", "jobs:enqueue", "jobs:cancel"],
    "inference-genre": ["projects:create", "files:write-text", "jobs:enqueue"],
    "inference-paused-open": ["jobs:list", "jobs:events", "files:open-path"],
    "polish-stop": ["jobs:enqueue", "jobs:cancel"],
    "polish-export-open": ["files:write-text", "files:open-path"],
    "settings-folder-save": ["settings:set"],
    "settings-opening-save": ["settings:set"],
    "settings-image-save": ["settings:set"],
    "settings-jianying-save": ["settings:set"],
    "settings-account-batch-delete": ["vidu-accounts:delete"],
  }[id];
}

function interceptionNote(id) {
  if (["project-resend", "project-check", "project-check-all", "project-start", "project-pause", "batch-start", "batch-stop", "batch-skip", "opening-submit", "opening-stop", "settings-webhook-save-test", "settings-account-login-check", "image-submit", "inference-submit", "inference-stop", "inference-stop-one", "inference-genre", "polish-submit", "polish-stop"].includes(id)) {
    return "The real UI and IPC/job handler ran; only external HTTP was blocked by the existing offline network guard. The resulting queued/running/error state is retained as runtime evidence.";
  }
  if (["opening-docx", "opening-enhanced"].includes(id)) return "The real document parser, UI, IPC, persistent job queue, original opening validator, and output writer ran against a deterministic local Responses-compatible fixture server.";
  if (["image-reference", "image-resend"].includes(id)) return "The real image workbench, IPC, persistent job queue, reference-image decoder, model client, and atomic output writer ran against a deterministic local OpenAI-compatible image fixture server.";
  if (id === "image-stop-one") return "The real image workbench, IPC, cancellation controller, and persistent job queue ran against a local stalled image endpoint so one card could be cancelled while the other remained active.";
  if (id === "opening-select-output") return "The real directory-picker IPC returned an interaction-audit-only isolated directory fixture; the setting write and directory evidence were real.";
  if (["project-create", "project-import-csv", "project-update-media", "opening-fetch", "opening-submit", "opening-stop", "inference-submit", "polish-submit"].includes(id)) return "The fixed local fixture was selected by an interaction-audit-only environment flag; parsing, IPC, SQLite, and file operations were real.";
  if (id === "settings-account-jwt-import") return "The real JWT import UI was opened and validated without supplying or injecting any credential.";
  return "No business call was mocked or replaced.";
}

function postActionDelay(id) {
  return ["project-check", "project-check-all", "project-start", "project-resend", "image-submit", "image-reference", "image-resend", "image-stop-one", "inference-submit", "inference-stop-one", "inference-genre", "polish-submit", "polish-stop", "opening-docx", "opening-enhanced"].includes(id) ? 900 : 250;
}

function validateCaseEvidence(id, calls, before, after, createdFiles, uiAction, processAliveAfterAction = true, blockedExternalRequests = []) {
  const failures = [];
  const settings = new Map(after.settings.map((row) => [row.key, row.value]));
  const jobs = after.jobs.map((row) => {
    let input = null;
    let output = null;
    try { input = JSON.parse(row.input_json); } catch {}
    try { output = JSON.parse(row.output_json); } catch {}
    return { ...row, input, output };
  });
  const storyboard = (index) => after.storyboards.find((row) => row.idx === index);
  const fulfilled = (channel) => calls.some((call) => call.channel === channel && call.status === "fulfilled");
  const created = (pattern) => createdFiles.some((file) => pattern.test(file.path));
  const businessCreatedFiles = createdFiles.filter((file) => !/(?:electron\.log|network\.jsonl)$/iu.test(file.path));
  if (id === "project-create") {
    const added = after.projects.find((project) => project.name === "动态审计新建项目");
    if (after.projects.length !== before.projects.length + 1 || !added) failures.push("new project was not persisted in SQLite");
    if (!added?.subtitle_path?.endsWith("替换字幕.srt") || !added?.audio_path?.endsWith("替换旁白.mp3")) failures.push("new project media paths were not persisted");
  }
  if (id === "project-import-csv") {
    const rows = after.storyboards.filter((row) => row.project_id === 1);
    if (rows.length !== 2 || rows[0]?.original_text !== "审计导入第一镜" || rows[1]?.prompt !== "候车室暖光") failures.push("CSV rows were not atomically persisted");
    if (!after.projects.find((project) => project.id === 1)?.csv_path?.endsWith("审计导入.csv")) failures.push("copied CSV path was not persisted");
    if (!created(/project[\\/]审计导入\.csv$/u)) failures.push("CSV was not copied into the project directory");
  }
  if (id === "project-update-media") {
    const project = after.projects.find((row) => row.id === 1);
    if (!project?.audio_path?.endsWith("替换旁白.mp3")) failures.push("replacement audio path was not persisted");
    if (!project?.subtitle_path?.endsWith("替换字幕.srt")) failures.push("replacement subtitle path was not persisted");
  }
  if (id === "project-batch-edit" && !after.storyboards.some((row) => row.prompt.includes("雨夜车站") && !row.prompt.includes("旧车站"))) failures.push("batch prompt edit was not persisted");
  if (id === "project-uncertain-clear-delete") {
    if (!uiAction.clearInitiallyDisabled || !uiAction.clearEnabledAfterConfirmation) failures.push("uncertain clear did not require explicit website-history confirmation");
    if (after.storyboards.some((row) => row.id === before.storyboards.find((entry) => entry.idx === 2)?.id)) failures.push("resolved uncertain storyboard remains in SQLite after confirmed deletion");
    if (!fulfilled("vidu-submission:resolve") || !fulfilled("storyboards:delete")) failures.push("uncertain resolution and deletion IPC chain did not fulfill");
  }
  if (id === "project-force-delete-tracked") {
    if (!uiAction.warningVisible) failures.push("tracked video deletion warning was not visible");
    if (after.storyboards.some((row) => row.id === before.storyboards.find((entry) => entry.idx === 1)?.id)) failures.push("tracked unavailable storyboard remains after force deletion");
    if (!fulfilled("storyboards:force-stop-video") || !fulfilled("storyboards:delete")) failures.push("force stop and storyboard deletion IPC chain did not fulfill");
  }
  if (id === "batch-add-remove" && (uiAction.snapshot?.entries?.length !== 0 || uiAction.snapshot?.scheduledAt !== null)) failures.push("batch add/remove or schedule cancellation did not persist");
  if (["batch-start", "batch-stop", "batch-skip"].includes(id) && !jobs.some((job) => job.type === "video.generate")) failures.push("batch queue did not persist a video job");
  if (id === "batch-stop" && (uiAction.snapshot?.running !== false || uiAction.snapshot?.entries?.[0]?.status !== "waiting")) failures.push("batch stop did not restore the current project to waiting");
  if (id === "batch-skip" && (uiAction.snapshot?.running !== false || uiAction.snapshot?.entries?.[0]?.status !== "skipped")) failures.push("batch skip did not persist the skipped state");
  if (id === "batch-reorder" && uiAction.snapshot?.entries?.map((entry) => entry.projectId).join(",") !== "2,1") failures.push("batch reorder was not persisted");
  if (id === "batch-custom-schedule" && !(uiAction.snapshot?.scheduledAt > Date.now())) failures.push("custom batch schedule was not persisted");
  if (id === "batch-clear-completed" && (uiAction.snapshot?.entries?.length !== 1 || uiAction.snapshot.entries[0]?.status !== "waiting")) failures.push("completed batch rows were not cleared");
  if (id === "opening-fetch" && !fulfilled("files:fetch-qq-novel")) failures.push("QQ novel fixture fetch did not fulfill");
  if (id === "opening-submit" && !jobs.some((job) => job.type === "opening.optimize")) failures.push("opening.optimize job missing from SQLite");
  if (id === "opening-stop" && !jobs.some((job) => job.type === "opening.optimize" && job.status === "cancelled")) failures.push("opening job was not cancelled");
  if (id === "opening-export" && !created(/开头[\\/]审计小说_开头优化\.txt$/u)) failures.push("opening TXT export was not written");
  if (id === "opening-docx") {
    const openingJob = jobs.find((job) => job.type === "opening.optimize" && job.input?.text?.trim() === "审计 DOCX 文本");
    if (!openingJob) failures.push("DOCX text was not persisted in the opening job input");
    if (openingJob?.input?.mode !== "general") failures.push("DOCX opening job did not retain general mode");
    if (openingJob?.status !== "done" || !uiAction.docxResultCaptured) failures.push("DOCX opening workflow did not reach a rendered done result");
    if (!created(/开头[\\/]output_kaitou\.txt$/u)) failures.push("DOCX opening output file was not written");
  }
  if (id === "opening-enhanced") {
    const openingJob = jobs.find((job) => job.type === "opening.optimize" && job.input?.mode === "enhanced");
    if (!openingJob) failures.push("enhanced mode was not persisted in the opening job input");
    if (openingJob?.status !== "done" || !uiAction.enhancedResultCaptured) failures.push("enhanced opening workflow did not render ten candidates");
    if (!created(/开头[\\/]output_kaitou\.txt$/u)) failures.push("enhanced opening output file was not written");
  }
  if (id === "opening-copy-expand") {
    if (uiAction.clipboardWrites?.length !== 2) failures.push("opening and body copy did not produce exactly two clipboard writes");
    if (uiAction.clipboardWrites?.[0] !== "审计开头：旧车站的广播突然叫出了林默的名字。") failures.push("single opening clipboard content was incorrect");
    if (uiAction.clipboardWrites?.[1] !== "这是隔离审计环境中的小说正文，用于验证复制正文与展开收起。") failures.push("body-only clipboard content was incorrect");
    if (!uiAction.bodyExpandedThenCollapsed) failures.push("opening body did not expand and collapse through the real details control");
    if (uiAction.trackedJobIdBefore !== uiAction.trackedJobIdAfter) failures.push("copy/expand unexpectedly changed the tracked opening job");
    if (createdFiles.length > 0) failures.push("copy/expand unexpectedly created files");
  }
  if (id === "opening-select-output") {
    if (!fulfilled("files:pick-directory") || !fulfilled("settings:set")) failures.push("output directory picker/settings IPC chain did not fulfill");
    if (!settings.get("opening_output_dir")?.endsWith("selected-output")) failures.push("selected opening output directory was not persisted");
  }
  if (id === "opening-export-open-dir") {
    const exported = createdFiles.find((file) => /开头[\\/]审计小说_开头优化\.txt$/u.test(file.path));
    if (!exported || exported.size <= 0) failures.push("opening export file was missing or empty");
    if (!fulfilled("files:open-path") || !uiAction.openedPathExists) failures.push("exported opening output directory was not opened through IPC");
    if (!String(uiAction.openedPath ?? "").endsWith(`${path.sep}开头`)) failures.push("opened path was not the configured opening output directory");
  }
  if (id === "settings-webhook-save-test" && !calls.some((call) => call.channel === "notifications:test")) failures.push("Webhook test IPC was not invoked");
  if (id === "settings-account-login-check" && (!calls.some((call) => call.channel === "vidu-accounts:open-login") || !calls.some((call) => call.channel === "vidu-accounts:check"))) failures.push("Vidu login/check IPC chain was incomplete");
  if (id === "settings-account-jwt-import" && !uiAction.clicked) failures.push("JWT import UI was not exposed in a credential-free state");
  if (id === "project-delete") {
    if (after.projects.some((row) => row.id === 1)) failures.push("deleted project remains in SQLite");
    if (after.storyboards.some((row) => row.project_id === 1)) failures.push("deleted project storyboards remain in SQLite");
  }
  if (id === "project-reset") {
    const resetRows = after.storyboards.filter((row) => row.project_id === 1);
    if (resetRows.length !== 3 || resetRows.some((row) => row.status !== "pending" || row.video_task_id !== null || row.video_path !== null)) failures.push("project storyboards were not reset to clean pending state");
    if (after.jobs.some((job) => JSON.stringify(job).includes('"projectId":1') || resetRows.some((row) => job.input?.storyboardId === row.id))) failures.push("project jobs were not cleared by reset");
  }
  if (id === "project-check-all" && !calls.some((entry) => entry.channel === "vidu-submission:check")) failures.push("bulk check did not invoke provider recovery");
  if (id === "project-force-stop") {
    if (!after.jobs.some((job) => job.type === "video.generate" && job.status === "cancelled")) failures.push("force stop all did not cancel the active video job");
    if (storyboard(1)?.video_task_id !== null) failures.push("force stop all did not clear the provider task ID");
  }
  if (id === "project-open-video" && !fulfilled("media:open")) failures.push("bound video was not validated and opened through media IPC");
  if (id === "inference-stop" && !jobs.some((job) => job.type === "storyboard.infer" && job.status === "cancelled")) failures.push("inference task was not cancelled in SQLite");
  if (id === "inference-multi-file" && (uiAction.sourceCount !== 2 || uiAction.titles?.length !== 2)) failures.push("multi-file picker did not load both fixture documents");
  if (id === "inference-open-output" && !fulfilled("files:open-path")) failures.push("configured inference output directory was not validated through open-path IPC");
  if (["inference-stop-one", "inference-genre", "inference-paused-open", "polish-stop", "polish-export-open"].includes(id)) {
    if (!processAliveAfterAction || !uiAction.rendererAlive || !uiAction.mainResponsive) failures.push("Electron main/renderer did not remain responsive after the interaction");
  }
  if (id === "inference-stop-one") {
    const cancelCall = [...calls].reverse().find((call) => call.channel === "jobs:cancel" && call.status === "fulfilled");
    const targetId = cancelCall?.args?.[0];
    const inferenceJobs = jobs.filter((job) => job.type === "storyboard.infer");
    const target = inferenceJobs.find((job) => job.id === targetId);
    const unaffected = inferenceJobs.filter((job) => job.id !== targetId);
    const enqueueCount = calls.filter((call) => call.channel === "jobs:enqueue" && call.status === "fulfilled").length;
    if (enqueueCount !== 2 || inferenceJobs.length !== 2) failures.push("two independent inference jobs were not durably enqueued");
    if (!target || target.status !== "cancelled" || target.error !== null) failures.push("clicked inference job was not cleanly cancelled");
    if (unaffected.length !== 1 || !["queued", "running", "paused"].includes(unaffected[0]?.status)) failures.push("non-target inference job was cancelled or became terminal");
    const targetEvents = after.jobEvents.filter((event) => event.job_id === targetId);
    if (targetEvents.at(-1)?.message !== "Job cancelled") failures.push("cancelled inference job did not retain the cancellation event");
    if (!uiAction.targetStoppedUi || !uiAction.otherStillStoppable) failures.push("single-task stop UI remained stuck or affected the other task card");
    if (!created(/audit-novel_原文\.txt$/u) || !created(/audit-novel-second_原文\.txt$/u)) failures.push("both inference source documents were not materialized");
    if (created(/(?:角色表\.txt|分镜\.csv)$/u)) failures.push("cancelled/stalled inference unexpectedly left final artifacts");
  }
  if (id === "inference-genre") {
    const fixtureText = fs.readFileSync(path.join(originalFixtureRoot, "audit-novel.txt"), "utf8").trim();
    const inferenceJobs = jobs.filter((job) => job.type === "storyboard.infer");
    const target = inferenceJobs.find((job) => job.input?.genre === "玄幻");
    const project = target ? after.projects.find((item) => item.id === target.input?.projectId) : null;
    if (!target || target.input?.text?.trim() !== fixtureText) failures.push("selected genre/text did not reach storyboard.infer input");
    if (!target || !["queued", "running"].includes(target.status)) failures.push("genre audit inference did not remain active on the isolated model fixture");
    if (uiAction.selectedGenre !== "玄幻" || uiAction.selectedGenreLabel?.trim() !== "玄幻/修真" || uiAction.title !== "audit-novel") failures.push("genre/title DOM evidence was incorrect");
    if (!project?.folder_path?.endsWith(`${path.sep}推理${path.sep}audit-novel`)) failures.push("genre inference project directory was not created under the configured output root");
    if (!created(/audit-novel_原文\.txt$/u)) failures.push("genre inference source document was not written");
  }
  if (id === "inference-paused-open") {
    const paused = after.jobs.find((job) => job.id === pausedInferenceJobId);
    const event = after.jobEvents.filter((item) => item.job_id === pausedInferenceJobId).at(-1);
    let diagnostics = null;
    try { diagnostics = JSON.parse(event?.detail_json ?? "null"); } catch { diagnostics = null; }
    const changedTables = Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    if (paused?.status !== "paused" || paused?.error !== "校验未清零，草稿已保留") failures.push("retained inference job did not stay paused");
    if (event?.message !== "Job paused for attention" || diagnostics?.errorCategory !== "DCOL.UNCLASSIFIED" || diagnostics?.completedIndexes?.join(",") !== "1,2,3") failures.push("pause diagnostics were not fully persisted");
    if (diagnostics?.workDir !== uiAction.retainedDirectory || uiAction.openedPath !== diagnostics?.workDir) failures.push("retained directory DOM/open-path evidence did not match diagnostics");
    if (!uiAction.actualPaused || uiAction.retainedJobStatus !== "paused/retained" || !uiAction.openedPathExists || !fulfilled("files:open-path")) failures.push("paused task was not rendered and opened through the real control");
    if (!diagnostics?.workDir || !fs.existsSync(diagnostics.workDir) || !diagnostics.reportPaths?.every((filePath) => fs.existsSync(filePath))) failures.push("retained inference work/report files do not exist");
    if (changedTables.length > 0) failures.push(`opening retained directory unexpectedly changed SQLite tables: ${changedTables.join(", ")}`);
  }
  if (id === "polish-stop") {
    const cancelCall = [...calls].reverse().find((call) => call.channel === "jobs:cancel" && call.status === "fulfilled");
    const targetId = cancelCall?.args?.[0];
    const target = jobs.find((job) => job.id === targetId);
    const events = after.jobEvents.filter((event) => event.job_id === targetId);
    if (target?.type !== "text.polish" || target.status !== "cancelled" || target.error !== null) failures.push("text polish job was not cleanly cancelled");
    if (events.at(-1)?.message !== "Job cancelled") failures.push("text polish cancellation event was not persisted");
    if (!uiAction.retryStateRetained || uiAction.trackedJobId !== targetId) failures.push("cancelled polish job was not retained for retry");
    if (!uiAction.notStuck) failures.push("polish UI remained in a generating/stoppable state after cancellation");
    if (created(/捋文[\\/]audit-polish_捋文\.txt$/u)) failures.push("cancelled polish job left a partial final TXT");
  }
  if (id === "polish-export-open") {
    const writeCall = [...calls].reverse().find((call) => call.channel === "files:write-text" && call.status === "fulfilled");
    const openCall = [...calls].reverse().find((call) => call.channel === "files:open-path" && call.status === "fulfilled");
    const write = writeCall?.args?.[0];
    const exported = createdFiles.find((file) => /捋文[\\/]audit-polish_捋文\.txt$/u.test(file.path));
    const tracked = after.jobs.find((job) => job.id === polishExportJobId);
    const changedTables = Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    if (uiAction.clipboardWrites?.length !== 1 || uiAction.clipboardWrites[0] !== polishEditedResult) failures.push("edited polish result was not copied exactly once");
    if (write?.text !== polishEditedResult || write?.defaultName !== "audit-polish_捋文.txt") failures.push("edited polish result was not exported with the expected content/name");
    if (!exported || exported.size <= 0 || fs.readFileSync(path.join(write.directory, write.defaultName), "utf8") !== polishEditedResult) failures.push("polish export artifact was missing, empty, or contained stale text");
    if (openCall?.args?.[0] !== write?.directory || !uiAction.openedPathExists) failures.push("polish output directory was not opened through fulfilled IPC");
    if (tracked?.status !== "done" || uiAction.trackedJobIdBefore !== polishExportJobId || uiAction.trackedJobIdAfter !== polishExportJobId) failures.push("completed polish job/tracking state was not retained");
    if (changedTables.length > 0) failures.push(`polish copy/export unexpectedly changed SQLite tables: ${changedTables.join(", ")}`);
  }
  if (["image-reference", "image-edit-prompt", "image-resend", "image-open-dir", "image-stop-one"].includes(id)) {
    if (!processAliveAfterAction || !uiAction.rendererAlive) failures.push("Electron main/renderer did not remain alive after the image interaction");
  }
  if (id === "image-reference") {
    const pickCall = calls.find((call) => call.channel === "files:pick-file" && call.status === "fulfilled");
    const enqueueCall = calls.find((call) => call.channel === "jobs:enqueue" && call.status === "fulfilled");
    const target = jobs.find((job) => job.type === "image.standalone" && job.input?.prompt === uiAction.prompt);
    const outputPaths = target?.output?.imagePaths ?? [];
    if (pickCall?.args?.[0] !== "visual" || uiAction.pickKind !== "visual" || !uiAction.selectedReferenceVisible) failures.push("visual reference picker/DOM evidence was incomplete");
    if (enqueueCall?.args?.[0] !== "image.standalone" || enqueueCall?.args?.[1]?.referenceImagePaths?.length !== 1) failures.push("reference image was not sent through image.standalone enqueue IPC");
    if (!target || target.input?.referenceImagePaths?.length !== 1 || target.input.referenceImagePaths[0] !== uiAction.referencePath) failures.push("selected reference path was not persisted in the image job input");
    if (target?.status !== "done" || !uiAction.cardDone || !uiAction.imageRendered || !uiAction.mainResponsive) failures.push("reference-image workflow did not reach a rendered durable done state");
    if (!target?.output?.outputDirectory || !fs.existsSync(target.output.outputDirectory) || outputPaths.length !== 1 || !outputPaths.every((filePath) => fs.existsSync(filePath))) failures.push("reference-image output directory/files were not atomically persisted");
    if (!outputPaths.some((filePath) => businessCreatedFiles.some((file) => filePath.endsWith(file.path)))) failures.push("reference-image output PNG was not captured in the file delta");
    if (uiAction.trackedBatch !== target?.input?.batchName) failures.push("reference-image batch tracking key did not retain the generated batch");
  }
  if (id === "image-edit-prompt") {
    const changedTables = Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    if (!uiAction.blankDisabled || !uiAction.cancelRestored) failures.push("blank prompt prevention or cancel rollback did not work");
    if (uiAction.oldPrompt !== "原始提示词" || uiAction.savedPrompt !== "保存后的角色提示词" || !uiAction.editModeClosed || !uiAction.noticeVisible) failures.push("trimmed prompt save was not rendered correctly");
    if (uiAction.batchBefore !== imageBatchName || uiAction.batchAfter !== imageBatchName) failures.push("editing unexpectedly changed the tracked image batch");
    if (uiAction.ipcCallCount !== 0 || calls.length !== 0) failures.push("prompt edit/save unexpectedly emitted IPC");
    if (changedTables.length > 0) failures.push(`prompt edit/save unexpectedly changed SQLite tables: ${changedTables.join(", ")}`);
    if (businessCreatedFiles.length > 0) failures.push("prompt edit/save unexpectedly created or modified business files");
  }
  if (id === "image-resend") {
    const enqueueCall = calls.find((call) => call.channel === "jobs:enqueue" && call.status === "fulfilled");
    const beforeIds = new Set(before.jobs.filter((job) => job.type === "image.standalone").map((job) => job.id));
    const newJobs = jobs.filter((job) => job.type === "image.standalone" && !beforeIds.has(job.id));
    const resent = newJobs.find((job) => job.id === uiAction.resentJobId);
    const outputPaths = resent?.output?.imagePaths ?? [];
    const initial = jobs.find((job) => job.id === completedImageJobId);
    if (enqueueCall?.args?.[0] !== "image.standalone" || enqueueCall?.args?.[1]?.prompt !== "重发提示词" || enqueueCall?.args?.[1]?.workbenchKey !== imageWorkbenchKey) failures.push("saved prompt/workbench key did not reach resend enqueue IPC");
    if (newJobs.length !== 1 || !resent || resent.status !== "done" || resent.input?.batchName !== imageBatchName || resent.input?.workbenchKey !== imageWorkbenchKey) failures.push("resend did not append exactly one durable completed image job");
    if (initial?.status !== "done" || after.jobs.length !== before.jobs.length + 1) failures.push("resend overwrote the historical image job instead of appending");
    if (uiAction.cardPrompt !== "重发提示词" || uiAction.resentStatus !== "done" || !uiAction.mainResponsive) failures.push("resent card did not show the saved prompt and completed state");
    if (uiAction.trackedBatchBefore !== imageBatchName || uiAction.trackedBatchAfter !== imageBatchName) failures.push("resend changed the tracked image batch");
    if (outputPaths.length !== 1 || !outputPaths.every((filePath) => fs.existsSync(filePath)) || outputPaths.some((filePath) => initial?.output?.imagePaths?.includes(filePath))) failures.push("resend did not persist a distinct new output image");
    if (!outputPaths.some((filePath) => businessCreatedFiles.some((file) => filePath.endsWith(file.path)))) failures.push("resent output PNG was not captured in the file delta");
  }
  if (id === "image-open-dir") {
    const openCall = calls.find((call) => call.channel === "files:open-path" && call.status === "fulfilled");
    const completed = jobs.find((job) => job.id === completedImageJobId);
    const changedTables = Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    if (!openCall || openCall.args?.[0] !== completed?.output?.outputDirectory || uiAction.openedPath !== completed?.output?.outputDirectory || !uiAction.openedPathExists) failures.push("open directory did not prefer the completed result outputDirectory");
    if (!uiAction.openedPath || !fs.existsSync(uiAction.openedPath) || !uiAction.mainResponsive) failures.push("opened image result directory/main process was unavailable");
    if (uiAction.trackedBatch !== imageBatchName) failures.push("opening the directory changed or lost image batch tracking");
    if (changedTables.length > 0) failures.push(`opening the image directory unexpectedly changed SQLite tables: ${changedTables.join(", ")}`);
    if (businessCreatedFiles.length > 0) failures.push("opening the image directory unexpectedly changed business files");
  }
  if (id === "image-stop-one") {
    const cancelCalls = calls.filter((call) => call.channel === "jobs:cancel" && call.status === "fulfilled");
    const enqueueCalls = calls.filter((call) => call.channel === "jobs:enqueue" && call.status === "fulfilled");
    const target = jobs.find((job) => job.id === uiAction.targetJobId);
    const other = jobs.find((job) => job.id === uiAction.otherJobId);
    const targetEvents = after.jobEvents.filter((event) => event.job_id === uiAction.targetJobId);
    if (enqueueCalls.length !== 2 || jobs.filter((job) => job.type === "image.standalone").length !== 2) failures.push("two independent image jobs were not durably enqueued");
    if (cancelCalls.length !== 1 || cancelCalls[0]?.args?.[0] !== uiAction.targetJobId || uiAction.cancelledJobId !== uiAction.targetJobId) failures.push("single-card stop did not cancel exactly the clicked image job");
    if (target?.status !== "cancelled" || target?.error !== null || targetEvents.at(-1)?.message !== "Job cancelled") failures.push("clicked image job was not cleanly cancelled with a durable event");
    if (!other || !["queued", "running"].includes(other.status)) failures.push("non-target image job was cancelled or became terminal");
    if (!uiAction.targetStoppedUi || !uiAction.otherStillStoppable || !uiAction.mainResponsive) failures.push("single-card stop UI remained stuck or affected the other card");
    if (!uiAction.batchAfter || uiAction.batchAfter !== target?.input?.batchName || uiAction.batchAfter !== other?.input?.batchName) failures.push("stopping one image changed or lost the current batch");
    if (businessCreatedFiles.length > 0) failures.push("stalled/cancelled image jobs left a partial output file");
  }
  const accountAndGlobalCases = [
    "settings-account-add", "settings-account-delete-one", "settings-account-reorder", "settings-account-toggle",
    "settings-account-edit", "settings-account-daily-reset", "settings-account-clear-flags", "settings-account-unblock",
    "theme-toggle", "logout", "updater-check",
  ];
  if (accountAndGlobalCases.includes(id)) {
    if (!processAliveAfterAction || !uiAction.rendererAlive || !uiAction.mainResponsive) failures.push("Electron main/renderer did not remain responsive after the account/global interaction");
    if (blockedExternalRequests.length > 0) failures.push(`account/global interaction attempted ${blockedExternalRequests.length} external request(s)`);
    if (JSON.stringify(before.jobs) !== JSON.stringify(after.jobs)) failures.push("account/global interaction unexpectedly changed durable jobs or left an inference task stuck");
    if (businessCreatedFiles.length > 0) failures.push("account/global interaction unexpectedly changed business files");
  }
  if (id === "settings-account-add") {
    const createCall = calls.find((call) => call.channel === "vidu-accounts:create" && call.status === "fulfilled");
    const payload = createCall?.args?.[0];
    const createdAccount = after.viduAccounts.find((account) => account.name === "新增积分审计号");
    const maxBeforeOrder = Math.max(-1, ...before.viduAccounts.map((account) => account.sort_order));
    if (after.viduAccounts.length !== before.viduAccounts.length + 1 || !createdAccount) failures.push("single-account add did not append exactly one SQLite row");
    if (payload?.name !== "新增积分审计号" || payload?.accountType !== "points" || payload?.defaultQuota !== 88) failures.push("single-account create IPC payload did not match the edited controls");
    if (createdAccount?.account_type !== "points" || createdAccount?.default_quota !== 88 || createdAccount?.enabled !== 1) failures.push("new account editable fields/default enabled state were not persisted");
    if (!(createdAccount?.sort_order > maxBeforeOrder) || !createdAccount?.session_key || !uiAction.sessionKeyUnique || !uiAction.createdVisible) failures.push("new account order/session identity or rendered state was invalid");
  }
  if (id === "settings-account-delete-one") {
    const deleteCall = calls.find((call) => call.channel === "vidu-accounts:delete" && call.status === "fulfilled");
    const deletedId = deleteCall?.args?.[0];
    const peersBefore = before.viduAccounts.filter((account) => account.id !== deletedId);
    const peersAfter = after.viduAccounts.filter((account) => account.id !== deletedId);
    if (!deletedId || after.viduAccounts.some((account) => account.id === deletedId) || after.viduAccounts.length !== before.viduAccounts.length - 1) failures.push("selected account row was not exclusively deleted");
    if (JSON.stringify(peersBefore) !== JSON.stringify(peersAfter) || !uiAction.otherAccountsPreserved) failures.push("deleting one account changed or globally cleared peer accounts");
    if (!uiAction.targetRemoved || !uiAction.sessionCleanupVerified || uiAction.deletedAccountId !== deletedId) failures.push("isolated selected-account session cleanup/delete completion was not verified");
  }
  if (id === "settings-account-reorder") {
    const moveCall = calls.find((call) => call.channel === "vidu-accounts:move" && call.status === "fulfilled");
    const beforeIds = before.viduAccounts.map((account) => account.id);
    const afterIds = after.viduAccounts.map((account) => account.id);
    const expected = beforeIds.length >= 2 ? [beforeIds[1], beforeIds[0], ...beforeIds.slice(2)] : beforeIds;
    if (moveCall?.args?.[0] !== beforeIds[1] || moveCall?.args?.[1] !== "up") failures.push("account reorder IPC did not move the second row up");
    if (afterIds.join(",") !== expected.join(",") || uiAction.afterOrder?.join(",") !== expected.join(",")) failures.push("persisted/rendered account order did not swap only the first two rows");
    if (new Set(after.viduAccounts.map((account) => account.sort_order)).size !== after.viduAccounts.length) failures.push("persisted account sort_order values are not unique");
  }
  if (id === "settings-account-toggle") {
    const updates = calls.filter((call) => call.channel === "vidu-accounts:update" && call.status === "fulfilled");
    const firstPatch = updates[0]?.args?.[1];
    const lastPatch = updates.at(-1)?.args?.[1];
    const targetId = updates[0]?.args?.[0];
    const target = after.viduAccounts.find((account) => account.id === targetId);
    if (updates.length !== 2 || firstPatch?.enabled !== false || lastPatch?.enabled !== true || lastPatch?.clearDisabled !== true) failures.push("account disable/re-enable IPC transition was incomplete");
    if (target?.enabled !== 1 || target?.disabled_reason !== null || target?.disabled_message !== null || target?.disabled_at !== null || !uiAction.disabledFieldsCleared) failures.push("re-enabled account did not clear all durable disabled metadata");
  }
  if (id === "settings-account-edit") {
    const updates = calls.filter((call) => call.channel === "vidu-accounts:update" && call.status === "fulfilled");
    const targetId = updates[0]?.args?.[0];
    const target = after.viduAccounts.find((account) => account.id === targetId);
    if (updates.length !== 3 || updates.some((call) => call.args?.[0] !== targetId)) failures.push("account edit did not persist exactly three updates to one selected row");
    if (updates[0]?.args?.[1]?.name !== "已编辑审计号" || updates[1]?.args?.[1]?.accountType !== "points" || updates[2]?.args?.[1]?.defaultQuota !== 77) failures.push("account name/type/quota edit IPC payloads were incorrect");
    if (target?.name !== "已编辑审计号" || target?.account_type !== "points" || target?.default_quota !== 77 || uiAction.finalAccount?.name !== "已编辑审计号") failures.push("edited account values were not persisted and rendered");
  }
  if (id === "settings-account-daily-reset") {
    const beforeMember = before.viduAccounts.find((account) => account.account_type === "member");
    const afterMember = after.viduAccounts.find((account) => account.id === beforeMember?.id);
    const beforePoints = before.viduAccounts.find((account) => account.account_type === "points");
    const afterPoints = after.viduAccounts.find((account) => account.id === beforePoints?.id);
    if (!fulfilled("vidu-accounts:reset-daily-usage") || beforeMember?.usage_count !== 9 || afterMember?.usage_count !== 0 || afterMember?.usage_date !== "") failures.push("member daily usage was not reset from the seeded nonzero state");
    if (beforePoints?.usage_count !== 7 || afterPoints?.usage_count !== beforePoints.usage_count || afterPoints?.usage_date !== beforePoints.usage_date || uiAction.pointsUsage !== 7) failures.push("points-account cumulative usage changed during daily reset");
  }
  if (["settings-account-clear-flags", "settings-account-unblock"].includes(id)) {
    const updateCall = calls.find((call) => call.channel === "vidu-accounts:update" && call.status === "fulfilled");
    const targetId = updateCall?.args?.[0];
    const patch = updateCall?.args?.[1];
    const beforeTarget = before.viduAccounts.find((account) => account.id === targetId);
    const afterTarget = after.viduAccounts.find((account) => account.id === targetId);
    const peersBefore = before.viduAccounts.filter((account) => account.id !== targetId);
    const peersAfter = after.viduAccounts.filter((account) => account.id !== targetId);
    const expectedReason = id === "settings-account-clear-flags" ? "subject_limit" : "credits_exhausted";
    if (beforeTarget?.disabled_reason !== expectedReason || patch?.enabled !== true || patch?.clearDisabled !== true) failures.push("disabled-account unblock entry point or IPC patch did not match the seeded reason");
    if (afterTarget?.enabled !== 1 || afterTarget?.disabled_reason !== null || afterTarget?.disabled_message !== null || afterTarget?.disabled_at !== null || !uiAction.cleared) failures.push("selected account disabled metadata was not fully cleared");
    if (JSON.stringify(peersBefore) !== JSON.stringify(peersAfter)) failures.push("clearing one account flag changed or globally cleared peer accounts");
    if (!uiAction.legacyAccountIssuesAbsent) failures.push("legacy global accountIssues state was created unexpectedly");
  }
  if (id === "theme-toggle") {
    const changed = Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    if (!uiAction.darkModeReached || !uiAction.lightModeRestored || !uiAction.domThemeSynchronized) failures.push("theme DOM did not complete the dark/light round trip");
    if (uiAction.persistedThemeSequence?.join(",") !== "dark,light") failures.push("ai-tool-theme localStorage sequence was not dark then light");
    if (changed.length > 0 || calls.some((call) => call.channel !== "jobs:list")) failures.push(`theme toggle unexpectedly used IPC or changed SQLite: ${changed.join(", ")}`);
  }
  if (id === "logout") {
    const changed = Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    const authLikeTables = (after.schemaTables ?? []).filter((name) => /(?:^|_)(?:auth|users?|licenses?|tokens?|devices?)(?:_|$)/iu.test(name));
    const readOnlyChannels = new Set(["settings:get", "settings:list", "settings:status", "app:paths", "jobs:list", "projects:list", "backup:restore-status", "vidu-accounts:list", "vidu-subjects:clipboard-status"]);
    if (uiAction.logoutControlPresent || uiAction.authKeysRequired || uiAction.authDatabaseDependency) failures.push("removed author login/logout contract is still exposed or required");
    if (!uiAction.businessRoutesDirectlyAccessible || !uiAction.autoLogoutAbsent) failures.push("business routes redirected, auto-logged-out, or became inaccessible without author auth keys");
    if (authLikeTables.length > 0) failures.push(`application auth-like database dependency exists: ${authLikeTables.join(", ")}`);
    if (changed.length > 0 || calls.some((call) => !readOnlyChannels.has(call.channel))) failures.push(`auth-free navigation unexpectedly used mutation/session-clear IPC or changed SQLite: ${changed.join(", ")}`);
  }
  if (id === "updater-check") {
    const changed = Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    if (calls.some((call) => call.channel === "plugin:updater|check") || !uiAction.localDeploymentNoticeVisible || !uiAction.mentionsDataRetention) failures.push("local update notice invoked the author updater or omitted deployment/data-retention guidance");
    if (changed.length > 0 || calls.some((call) => call.channel !== "jobs:list")) failures.push(`local update notice unexpectedly used IPC or changed SQLite: ${changed.join(", ")}`);
  }
  if (id === "settings-folder-save" && settings.get("project_base_folder") !== "C:\\AI审计\\选择目录") failures.push("project root directory setting missing");
  if (id === "settings-opening-save" && settings.get("opening_output_dir") !== "C:\\AI审计\\开头新目录") failures.push("opening output directory setting missing");
  if (id === "settings-image-save") {
    if (settings.get("imagegen_api_base_url") !== "https://example.invalid/v1") failures.push("image API base URL missing");
    if (settings.get("imagegen_model") !== "gpt-image-2") failures.push("image model missing");
    if (settings.get("imagegen_output_dir") !== "C:\\AI审计\\图片新目录") failures.push("image output directory missing");
  }
  if (id === "settings-jianying-save" && settings.get("jianying_draft_path") !== "C:\\AI审计\\剪映新目录") failures.push("Jianying draft directory setting missing");
  if (id === "settings-account-batch-delete") {
    if (after.viduAccounts.some((account) => account.account_type === "points")) failures.push("points accounts were not batch deleted");
    if (!after.viduAccounts.some((account) => account.account_type === "member")) failures.push("member account should survive points-account batch deletion");
  }
  if (id === "project-edit-prompt" && storyboard(0)?.prompt !== "原版动态审计：修改后的电影感提示词") failures.push("edited prompt was not persisted in SQLite");
  if (id === "project-resend" && !jobs.some((job) => job.type === "video.generate" && job.input?.storyboardId === storyboard(0)?.id)) failures.push("resend video job missing from SQLite");
  if (id === "project-start" && jobs.filter((job) => job.type === "video.generate").length < 2) failures.push("project start did not persist both runnable video jobs");
  if (id === "project-pause" && !jobs.some((job) => job.type === "video.generate" && job.status === "paused")) failures.push("pause did not persist a paused video job");
  if (id === "project-stop-one") {
    const stopped = storyboard(1);
    if (stopped?.video_task_id !== null || stopped?.video_recovery_state !== "failed" || stopped?.status !== "error") failures.push("single stop did not clear provider task and persist failed/error state");
    if (!jobs.some((job) => job.type === "video.generate" && job.status === "cancelled")) failures.push("single stop did not cancel the active video job internally");
  }
  if (id === "project-q2-q3") {
    if (settings.get("vidu_use_credits") !== "false") failures.push("Q2 credit toggle was not persisted as false");
    if (settings.get("project_1_vidu_q3_enabled") !== "true") failures.push("Q3 enabled state was not persisted");
    if (settings.get("project_1_vidu_q3_pre_count") !== "0") failures.push("Q3 leading count=0 was not persisted");
  }
  if (id === "jianying-normal" || id === "jianying-auto-srt") {
    if (!fulfilled("jianying:export")) failures.push("Jianying IPC did not fulfill");
    if (!created(/jianying-drafts[\\/].+[\\/]draft_content\.json$/iu)) failures.push("draft_content.json was not generated");
    if (!created(/jianying-drafts[\\/].+[\\/]draft_meta_info\.json$/iu)) failures.push("draft_meta_info.json was not generated");
  }
  if (id === "inference-submit") {
    if (!jobs.some((job) => job.type === "storyboard.infer")) failures.push("storyboard.infer job missing from SQLite");
    if (!created(/audit-novel_原文\.txt$/u)) failures.push("inference original-text output was not generated");
  }
  if (id === "polish-submit" && !jobs.some((job) => job.type === "text.polish")) failures.push("text.polish job missing from SQLite");
  if (id === "image-submit" && !jobs.some((job) => job.type === "image.standalone")) failures.push("image.standalone job missing from SQLite");
  if (id === "settings-inference-save") {
    if (settings.get("infer_api_base_url") !== "https://audit.invalid/v1") failures.push("inference API base URL missing");
    if (settings.get("infer_model") !== "audit-model") failures.push("inference model missing");
    if (settings.get("infer_output_dir") !== "C:\\AI审计\\推理新目录") failures.push("inference output directory missing");
  }
  if (id === "settings-polish-save") {
    if (settings.get("text_polish_api_base_url") !== "https://audit.invalid/v1") failures.push("polish API base URL missing");
    if (settings.get("text_polish_model") !== "deepseek-chat") failures.push("polish model missing");
    if (settings.get("text_polish_output_dir") !== "C:\\AI审计\\捋文新目录") failures.push("polish output directory missing");
  }
  return failures;
}

function databaseSnapshot(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    const table = (name, order = "rowid") => db.prepare(`SELECT * FROM ${name} ORDER BY ${order}`).all().map(sanitizeRow);
    return {
      projects: table("projects", "id"),
      characterProfiles: table("character_profiles", "id"),
      storyboards: table("storyboards", "id"),
      storyboardEvents: table("storyboard_events", "id"),
      recoveryState: table("storyboard_recovery_state", "project_id, idx"),
      jobs: table("jobs", "created_at, id"),
      jobEvents: table("job_events", "id"),
      settings: table("settings", "key"),
      viduAccounts: table("vidu_accounts", "sort_order, id"),
      schemaTables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name),
    };
  } finally { db.close(); }
}

function sanitizeRow(row) {
  const next = { ...row };
  if (typeof next.key === "string" && /(?:api_key|api_keys|token|jwt)/iu.test(next.key)) next.value = next.value ? "[CONFIGURED_REDACTED]" : "";
  if (typeof next.session_key === "string") next.session_key = "[SESSION_KEY_REDACTED]";
  return next;
}

function databaseDelta(before, after) {
  return Object.fromEntries(Object.keys(after).map((key) => {
    const previous = JSON.stringify(before[key]);
    const current = JSON.stringify(after[key]);
    return [key, previous === current ? { changed: false } : { changed: true, beforeCount: before[key].length, afterCount: after[key].length }];
  }));
}

function fileSnapshot(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(directory, full);
      if (entry.isDirectory() && relative !== "user-data" && !relative.startsWith(`user-data${path.sep}`)) visit(full);
      else if (!/[\\/]user-data[\\/](?:Cache|Code Cache|GPUCache)[\\/]/u.test(full)) {
        if (entry.isDirectory()) continue;
        try {
          const data = fs.readFileSync(full);
          result.push({ path: relative, size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") });
        } catch (error) {
          if (error?.code !== "EBUSY" && error?.code !== "EACCES") throw error;
        }
      }
    }
  };
  visit(directory);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function fileDelta(before, after) {
  const old = new Map(before.map((item) => [item.path, item]));
  return after.filter((item) => !old.has(item.path) || old.get(item.path).sha256 !== item.sha256);
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function retainEvidenceArtifacts(caseRoot, userData, projectDir, result) {
  const liveDatabase = path.join(userData, "ai-tool.db");
  const evidenceDirectory = path.join(caseRoot, "evidence");
  const retainedDatabase = path.join(evidenceDirectory, "ai-tool.db");
  if (fs.existsSync(liveDatabase)) {
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    try {
      const db = new Database(liveDatabase);
      try { db.pragma("wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
      fs.copyFileSync(liveDatabase, retainedDatabase);
      if (result?.database) result.database.retainedSnapshot = retainedDatabase;
    } catch (error) {
      if (result) result.retentionWarning = `SQLite snapshot retention failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  removeNamedDirectories(projectDir, new Set([".ai-tool-inference", "__pycache__"]));
}

function removeNamedDirectories(rootDirectory, names) {
  if (!fs.existsSync(rootDirectory)) return;
  for (const entry of fs.readdirSync(rootDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(rootDirectory, entry.name);
    if (names.has(entry.name)) fs.rmSync(full, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    else removeNamedDirectories(full, names);
  }
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startStalledModelServer() {
  const sockets = new Set();
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method ?? null, url: request.url ?? null, mode: "stalled" });
    if (/\/models(?:\?|$)/u.test(request.url ?? "")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-chat", object: "model", created: 0, owned_by: "audit" }] }));
    }
    // All inference requests stay pending until the UI cancellation aborts them.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

async function startImageFixtureModelServer() {
  const sockets = new Set();
  const requests = [];
  const imageBase64 = fs.readFileSync(path.join(fixtureRoot, "角色.png")).toString("base64");
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch {}
      requests.push({ method: request.method ?? null, url: request.url ?? null, body });
      if (request.method !== "POST" || !/\/images\/generations(?:\?|$)/u.test(request.url ?? "")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "fixture route not found" } }));
        return;
      }
      const count = Number.isInteger(body?.n) && body.n > 0 ? Math.min(body.n, 10) : 1;
      response.writeHead(200, { "content-type": "application/json", "x-request-id": "audit-image-fixture" });
      response.end(JSON.stringify({ data: Array.from({ length: count }, () => ({ b64_json: imageBase64 })) }));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

async function startOpeningFixtureModelServer() {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (/\/models(?:\?|$)/u.test(request.url ?? "")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-chat", object: "model", created: 0, owned_by: "audit" }] }));
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let enhanced = false;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        enhanced = JSON.stringify(body).includes("增强版");
      } catch {}
      const count = enhanced ? 10 : 5;
      const entries = Array.from({ length: count }, (_, index) => {
        const header = `—— 开头 ${index + 1}（方向：方向${index + 1}，结构：结构${index + 1}，得分：${96 - index}） ——`;
        if (!enhanced) return `${header}\n隔离动态审计开头 ${index + 1}。`;
        return `${header}\n隔离动态审计增强开头 ${index + 1}。\n【过渡句】自然转入原文章节。\n【衔接：第1章 开场】原文第一句：林默在旧车站醒来。`;
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output_text: ["【题材】 都市悬疑", "备选开头", ...entries].join("\n"), model: "audit-opening-fixture" }));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

async function waitForRenderer(port, currentExit) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (currentExit()) throw new Error(`Electron exited during startup: ${JSON.stringify(currentExit())}`);
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await delay(120);
  }
  throw new Error("Timed out waiting for Electron renderer CDP");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Unable to connect renderer CDP")), { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const task = pending.get(message.id); pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  });
  return {
    call(method, params = {}) { const callId = ++id; return new Promise((resolve, reject) => { pending.set(callId, { resolve, reject }); socket.send(JSON.stringify({ id: callId, method, params })); }); },
    close() { socket.close(); },
  };
}

async function waitForAuditApi(cdp) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await evaluate(cdp, "typeof window.offline?.projects?.create === 'function' && typeof window.__AI_TOOL_INTERACTION_AUDIT__?.snapshot === 'function'");
    if (ready) return;
    await delay(100);
  }
  throw new Error("Preload interaction audit API was not exposed");
}

async function waitForBody(cdp, needle) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if ((await evaluate(cdp, "document.body.innerText")).includes(needle)) return;
    await delay(100);
  }
  throw new Error(`UI body did not contain ${needle}`);
}

async function waitForExpectedChannels(cdp, channels, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const calls = await evaluate(cdp, "window.__AI_TOOL_INTERACTION_AUDIT__.snapshot()");
    if (channels.every((channel) => calls.some((call) => call.channel === channel))) return;
    await delay(80);
  }
}

async function evaluate(cdp, expression) {
  const response = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Renderer evaluation failed");
  return response.result.value;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
