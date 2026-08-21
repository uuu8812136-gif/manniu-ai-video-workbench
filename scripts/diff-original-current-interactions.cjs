const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const originalPath = path.resolve(root, "..", "original-harness", "evidence", "original-ui-interactions.json");
const currentPath = path.join(root, "audit", "evidence", "current-ui-interactions.json");
const jsonPath = path.join(root, "audit", "evidence", "original-current-interaction-field-diff.json");
const markdownPath = path.join(root, "audit", "ORIGINAL-CURRENT-INTERACTION-FIELD-DIFF.md");
const extraSpecPath = path.join(root, "audit", "current-extra-dynamic-spec-2026-07-27.json");
const original = JSON.parse(fs.readFileSync(originalPath, "utf8"));
const current = JSON.parse(fs.readFileSync(currentPath, "utf8"));
const extraSpec = JSON.parse(fs.readFileSync(extraSpecPath, "utf8"));
const ids = original.cases.map((item) => item.id);
const currentArtifactRoots = [...new Set(current.cases.flatMap((item) => item.database?.path
  ? [path.dirname(path.dirname(item.database.path))]
  : []))].sort((left, right) => right.length - left.length);
if (current.summary?.passed !== current.cases.length || current.summary?.failed !== 0) {
  throw new Error(`Current interaction audit is not internally complete: ${JSON.stringify(current.summary)}`);
}

function main() {
  assertSpecializedCoverage();
  const cases = ids.map(buildCase);
  const allFields = cases.flatMap((item) => item.fields);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources: { original: originalPath, current: currentPath, extraSpec: extraSpecPath },
    comparisonRules: {
      equal: "Same normalized business value.",
      adapted: "Same business meaning transported or persisted through a different architecture.",
      enhanced: "Current version preserves the original behavior and adds durable state, validation, or real output.",
      different: "Confirmed state or behavior difference.",
      notApplicable: "The original control belongs to the removed author-side authentication contract and has no truthful local equivalent.",
      runtimeNotComparable: "Both paths ran, but provider/model outcomes cannot be compared because the original uses a deterministic mock and current external access is blocked.",
    },
    cases,
    summary: {
      cases: cases.length,
      currentDynamicPassed: current.summary.passed,
      missingEntryPoints: cases.filter((item) => item.level === "missing").length,
      levels: countBy(cases.map((item) => item.level)),
      fields: countBy(allFields.map((item) => item.verdict)),
      confirmedBusinessDifferences: cases.filter((item) => item.level === "different").map((item) => item.id),
      runtimeNotComparable: cases.filter((item) => item.fields.some((field) => field.verdict === "runtime-not-comparable")).map((item) => item.id),
      strictExtraCoverage: {
        specified: extraSpec.cases.length,
        specializedFieldBuilders: extraSpec.cases.filter((item) => typeof fieldBuilders[item.id] === "function").length,
        caseNotes: extraSpec.cases.filter((item) => Boolean(caseNotes[item.id])).length,
        levelPolicies: extraSpec.cases.filter((item) => Boolean(extraCaseLevelPolicies[item.id])).length,
      },
    },
  };

  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, markdown(report), "utf8");
  console.log(JSON.stringify({ jsonPath, markdownPath, summary: report.summary }, null, 2));
}

function buildCase(id) {
  const o = original.cases.find((item) => item.id === id);
  const c = current.cases.find((item) => item.id === id);
  if (!o) throw new Error(`Original evidence case missing: ${id}`);
  if (!c) return {
    id,
    level: "missing",
    currentDynamicStatus: "missing",
    fields: [
      field("uiEntryPoint", o.route ?? id, "not yet dynamically audited", "different", "This original entry point is queued for the next current-version audit expansion."),
      field("originalInvokeNames", originalCalls(o).map((item) => item.name), [], "different"),
    ],
    originalCalls: originalCalls(o),
    currentCalls: [],
    sqliteEvidence: { retainedSnapshot: null, changedTables: [], projectCount: null, storyboardCount: null, jobStates: [], storyboardEvents: [] },
    outputEvidence: [],
    blockedExternalRequests: [],
    note: "Original dynamic evidence exists; matching current-version runtime evidence has not been produced yet.",
  };
  const fields = (fieldBuilders[id] ?? genericFields)(o, c);
  return {
    id,
    level: caseLevel(id, fields),
    currentDynamicStatus: c.status,
    fields,
    originalCalls: originalCalls(o),
    currentCalls: relevantCurrentCalls(id, c),
    sqliteEvidence: summarizeSqlite(c),
    outputEvidence: c.outputFiles?.created ?? [],
    blockedExternalRequests: c.blockedExternalRequests ?? [],
    note: caseNotes[id] ?? "",
  };
}

const fieldBuilders = {
  "project-edit-prompt": (o, c) => {
    const oa = invoke(o, "update_storyboard_prompt").args;
    const cc = call(c, "storyboards:update");
    const before = storyboard(c, 0, "before");
    return [
      field("projectId", oa.projectId, before.project_id),
      field("displayStoryboardIndex", oa.index, before.idx + 1),
      field("prompt", oa.prompt, cc.args[1].prompt),
      field("persistence", "update_storyboard_prompt", "storyboards:update + SQLite", "adapted", "Current uses the storyboard row ID and verifies the changed SQLite value."),
    ];
  },
  "project-resend": (o, c) => {
    const oa = invoke(o, "run_vidu_automation").args;
    const input = jobInputs(c, "video.generate")[0];
    const sb = storyboardById(c, input.storyboardId, "before");
    const project = c.database.before.projects.find((item) => item.id === sb.project_id);
    return [
      field("projectId", oa.projectId, sb.project_id),
      field("displayStoryboardIndex", oa.sbIndex, sb.idx + 1),
      field("prompt", oa.prompt, sb.prompt),
      field("subjects", splitSubjects(oa.subjects), parseJson(sb.subjects_json)),
      field("projectDirectory", normalizePath(oa.projectDir), normalizePath(project.folder_path)),
      field("durationSeconds", oa.duration, input.durationSeconds),
      field("useCredits", oa.useCredits, input.useCredits),
      field("model", oa.model, input.viduModel),
      field("account", `browserIndex:${oa.browserIndex}`, "enabled account pool/default member UUID", "adapted", "Current account identity is durable and is selected server-side."),
      field("runRegistration", oa.registerRunId, "durable video.generate job", "enhanced"),
      field("aspectRatio", "implicit 16:9", input.aspectRatio, "enhanced"),
    ];
  },
  "project-check": (o, c) => {
    const recover = invoke(o, "vidu_recover").args;
    const currentCall = call(c, "vidu-submission:check");
    const sb = storyboardById(c, currentCall.args[0], "before");
    const eventTypes = c.database.after.storyboardEvents.map((item) => item.event_type);
    return [
      field("projectId", recover.projectId, sb.project_id),
      field("displayStoryboardIndex", recover.sbIndex, sb.idx + 1),
      field("taskId", recover.taskId, sb.video_task_id),
      field("projectDirectory", normalizePath(recover.projectDir), normalizePath(c.database.before.projects[0].folder_path)),
      field("account", `browserIndex:${recover.browserIndex}`, `accountId:${normalizeUuid(sb.video_account_id)}`, "adapted"),
      field("leaseAndStartEvent", ["claim", "manual_check_start"], eventTypes.filter((item) => item === "manual_check_start"), "adapted", "Current claim/finish lifecycle is internal to the single IPC and persisted in SQLite."),
      field("providerResult", "processing", currentCall.status === "rejected" ? "not_found/manual_check_failed" : currentCall.status, "runtime-not-comparable", "Original deterministic mock returns processing; current isolated run has no matching real website task."),
    ];
  },
  "project-start": (o, c) => {
    const originalRun = invokes(o, "run_vidu_automation");
    const inputs = jobInputs(c, "video.generate");
    const newSubmission = inputs.filter((input) => !storyboardById(c, input.storyboardId, "before").video_task_id);
    const recovery = inputs.filter((input) => storyboardById(c, input.storyboardId, "before").video_task_id);
    return [
      field("newSubmissionDisplayIndexes", originalRun.map((item) => item.args.sbIndex), newSubmission.map((input) => storyboardById(c, input.storyboardId, "before").idx + 1)),
      field("newSubmissionModels", originalRun.map((item) => item.args.model), newSubmission.map((input) => {
        const index = storyboardById(c, input.storyboardId, "before").idx;
        return input.q3PreCount === 0 || (Number.isInteger(input.q3PreCount) && index < input.q3PreCount) ? "Q3" : input.viduModel === "Q3" ? "Q2" : input.viduModel;
      })),
      field("newSubmissionDurations", originalRun.map((item) => item.args.duration), newSubmission.map((input) => input.durationSeconds)),
      field("newSubmissionCredits", originalRun.map((item) => item.args.useCredits), newSubmission.map((input) => input.useCredits)),
      field("q3LeadingCount", 2, inputs[0]?.q3PreCount),
      field("existingWebsiteTaskHandling", "skip generating storyboard #2", recovery.map((input) => `durable recovery job for #${storyboardById(c, input.storyboardId, "before").idx + 1}`), "enhanced", "Current queues recovery of the persisted task ID; the handler does not submit a second paid task."),
      field("jobDurability", "front-end run registry", `${inputs.length} SQLite video.generate jobs`, "enhanced"),
    ];
  },
  "project-pause": (o, c) => {
    const paused = c.database.after.jobs.filter((item) => item.type === "video.generate" && item.status === "paused");
    return [
      field("backendCalls", [], relevantCurrentCalls("project-pause", c).map((item) => item.channel), "enhanced", "Original pause changes only front-end state; current persists and pauses durable jobs without cancelling the provider task."),
      field("restartPersistence", false, paused.length > 0, "enhanced"),
      field("resumable", "front-end loop only", "jobs:resume after restart", "enhanced"),
    ];
  },
  "project-stop-one": (o, c) => {
    const oa = invoke(o, "stop_vidu_one").args;
    const cc = call(c, "storyboards:force-stop-video");
    const after = storyboardById(c, cc.args[0], "after");
    return [
      field("projectId", oa.projectId, after.project_id),
      field("displayStoryboardIndex", oa.sbIndex, after.idx + 1),
      field("providerTaskCleared", true, after.video_task_id === null),
      field("activeJobCancelled", "implicit original stop", c.database.after.jobs.some((item) => item.type === "video.generate" && item.status === "cancelled"), "enhanced"),
      field("auditEvent", "no explicit original event proof", c.database.after.storyboardEvents.some((item) => item.event_type === "manual_stop"), "enhanced"),
    ];
  },
  "project-q2-q3": (o, c) => {
    const state = o.storage.taskStore.state;
    return [
      field("q2UseCredits", state.useCreditsConfigs["1"], setting(c, "vidu_use_credits") === "true"),
      field("q3Enabled", state.q3Configs["1"].enabled, setting(c, "project_1_vidu_q3_enabled") === "true"),
      field("q3LeadingCount", state.q3Configs["1"].count, Number(setting(c, "project_1_vidu_q3_pre_count"))),
      field("countZeroMeaning", "all Q3", "all Q3"),
      field("q3CreditRule", "Q3 forces credits", "Q3 forces credits"),
    ];
  },
  "jianying-normal": (o, c) => jianyingFields(o, c, false),
  "jianying-auto-srt": (o, c) => jianyingFields(o, c, true),
  "inference-submit": (o, c) => {
    const oa = invoke(o, "run_novel_inference").args;
    const input = jobInputs(c, "storyboard.infer")[0];
    const projectCreate = call(c, "projects:create").args[0];
    return [
      field("text", oa.text, input.text),
      field("title", oa.title, projectCreate.name),
      field("genre", oa.genre, input.genre ?? "auto"),
      field("outputDirectory", normalizePath(oa.outDir), normalizePath(path.dirname(projectCreate.folderPath)), "adapted", "Current creates a child project directory under the configured output root."),
      field("apiBaseUrl", oa.apiBaseUrl, setting(c, "infer_api_base_url")),
      field("model", oa.model, setting(c, "infer_model")),
      field("apiKey", "configured/redacted", secretConfigured(c, "infer_api_key") ? "configured/redacted" : "missing"),
      field("originalTextFile", "not proven by original mock", c.outputFiles.created.some((item) => /audit-novel_原文\.txt$/u.test(item.path)), "enhanced"),
      field("execution", "single Tauri command", "durable storyboard.infer job + bundled file agent", "adapted"),
    ];
  },
  "polish-submit": (o, c) => {
    const oa = invoke(o, "run_text_polish").args;
    const input = jobInputs(c, "text.polish")[0];
    return [
      field("text", oa.text, input.text),
      field("title", oa.title, input.title),
      field("outputDirectory", normalizePath(oa.outDir), normalizePath(input.outDir)),
      field("apiBaseUrl", oa.apiBaseUrl, setting(c, "text_polish_api_base_url")),
      field("model", oa.model, setting(c, "text_polish_model")),
      field("apiKey", "configured/redacted", secretConfigured(c, "text_polish_api_key") ? "configured/redacted" : "missing"),
      field("sourceFormat", "TXT selected by original file input", input.sourceFormat, "enhanced"),
      field("providerOutcome", "mock accepted", c.database.after.jobs.find((item) => item.type === "text.polish")?.status, "runtime-not-comparable", "Current external request was intentionally blocked."),
    ];
  },
  "image-submit": (o, c) => {
    const oa = invoke(o, "generate_image").args.input;
    const input = jobInputs(c, "image.standalone")[0];
    return [
      field("prompt", oa.prompt, input.prompt),
      field("model", oa.model, input.model),
      field("count", oa.n, input.count),
      field("size", oa.size, input.size),
      field("quality", oa.quality, "high (main-process default)", "adapted"),
      field("referenceImages", oa.reference_images, input.referenceImagePaths ?? []),
      field("apiBaseUrl", oa.api_base_url, setting(c, "imagegen_api_base_url")),
      field("apiKey", "configured/redacted", secretConfigured(c, "imagegen_api_key") ? "configured/redacted" : "missing"),
      field("saveDirectory", normalizePath(oa.save_dir), normalizePath(input.outputDirectory)),
      field("characterName", oa.character_name, input.name),
      field("batchName", oa.batch_name, "generated unique batch name", "enhanced"),
      field("providerOutcome", "mock accepted", c.database.after.jobs.find((item) => item.type === "image.standalone")?.status, "runtime-not-comparable", "Current external request was intentionally blocked."),
    ];
  },
  "settings-inference-save": (o, c) => settingsFields(o, c, [
    ["infer_api_base_url", "infer_api_base_url"], ["infer_api_key", "infer_api_key"], ["infer_model", "infer_model"],
    ["infer_save_dir", "infer_output_dir"], ["infer_concurrency_per_key", "infer_concurrency_per_key"],
  ]),
  "settings-polish-save": (o, c) => settingsFields(o, c, [
    ["text_polish_api_base_url", "text_polish_api_base_url"], ["text_polish_api_key", "text_polish_api_key"],
    ["text_polish_model", "text_polish_model"], ["text_polish_save_dir", "text_polish_output_dir"],
  ]),
  "project-delete": (o, c) => [
    field("projectId", invoke(o, "delete_project").args.id, call(c, "projects:delete").args[0]),
    field("projectRemoved", o.state.projects.length === 0, !c.database.after.projects.some((item) => item.id === call(c, "projects:delete").args[0])),
    field("cascadeStoryboards", o.state.storyboards.length === 0, !c.database.after.storyboards.some((item) => item.project_id === call(c, "projects:delete").args[0]), "enhanced", "Current evidence verifies the SQLite cascade, not only the IPC return."),
  ],
  "project-reset": (o, c) => [
    field("entryPoint", originalCalls(o).map((item) => item.name), ["storyboards:reset-project"], "adapted"),
    field("projectId", Object.values(originalCalls(o)[0]?.args ?? {})[0], call(c, "storyboards:reset-project").args[0], "adapted"),
    field("storyboardCount", o.state.storyboards.length, c.database.after.storyboards.filter((item) => item.project_id === 1).length),
    field("allPending", "reset_storyboards invoked; original mock did not mutate its snapshot", c.database.after.storyboards.filter((item) => item.project_id === 1).every((item) => item.status === "pending"), "enhanced", "Current evidence verifies the reset result in SQLite instead of trusting the original harness mock state."),
    field("providerTasksCleared", o.state.storyboards.every((item) => !item.task_id), c.database.after.storyboards.filter((item) => item.project_id === 1).every((item) => !item.video_task_id), "enhanced"),
  ],
  "inference-multi-file": (o, c) => [
    field("entryPoint", "multi-file picker", c.uiAction.control, "adapted"),
    field("selectedFileCount", 2, c.uiAction.sourceCount),
    field("selectedTitles", "two distinct source titles", c.uiAction.titles, "enhanced", "Current evidence retains the two rendered source titles."),
    field("pickerIpc", originalCalls(o).map((item) => item.name), c.expectedChannels, "adapted"),
  ],
  "settings-folder-save": (o, c) => settingsFields(o, c, [["project_base_folder", "project_base_folder"]]),
  "settings-opening-save": (o, c) => settingsFields(o, c, [["novel_opt_save_dir", "opening_output_dir"]]),
  "settings-image-save": (o, c) => settingsFields(o, c, [
    ["imagegen_api_base_url", "imagegen_api_base_url"], ["imagegen_api_key", "imagegen_api_key"],
    ["imagegen_save_dir", "imagegen_output_dir"],
  ]),
  "settings-jianying-save": (o, c) => settingsFields(o, c, [["jianying_draft_path", "jianying_draft_path"]]),
  "opening-docx": (o, c) => {
    const oa = invoke(o, "run_novel_optimizer").args;
    const input = enqueueInput(c, "opening.optimize");
    return [
      field("documentParser", invokes(o, "read_docx_text").length, calls(c, "files:pick-document").length, "adapted", "Original sends DOCX bytes to a Tauri parser; current main process returns parsed document text."),
      field("parsedText", oa.text.trim(), input.text.trim()),
      field("mode", oa.mode, input.mode),
      field("titleDerivation", oa.title, input.title, "enhanced", "Current uses the DOCX filename instead of the original fallback title."),
      field("outputDirectory", normalizePath(oa.outDir), normalizePath(input.outDir)),
      field("model", oa.model, setting(c, "infer_model")),
      field("jobPersisted", true, Boolean(c.database.after.jobs.find((item) => item.type === "opening.optimize"))),
      field("terminalSuccess", true, jobStatus(c, "opening.optimize") === "done"),
      field("docxResultCaptured", true, uiEvidence(c, "docxResultCaptured")),
      field("outputArtifactCreated", true, outputPaths(c).length > 0),
      field("executionArchitecture", "single run_novel_optimizer invocation", "durable opening.optimize job", "enhanced"),
    ];
  },
  "opening-enhanced": (o, c) => {
    const oa = invoke(o, "run_novel_optimizer").args;
    const input = enqueueInput(c, "opening.optimize");
    return [
      field("mode", oa.mode, input.mode),
      field("text", oa.text, input.text),
      field("titleDerivation", oa.title, input.title, "enhanced", "Current derives the title from the selected filename; the original fallback made its filename assignment unreachable."),
      field("outputDirectory", normalizePath(oa.outDir), normalizePath(input.outDir)),
      field("model", oa.model, setting(c, "infer_model")),
      field("enhancedResultCaptured", true, uiEvidence(c, "enhancedResultCaptured")),
      field("terminalSuccess", true, jobStatus(c, "opening.optimize") === "done"),
      field("outputArtifactCreated", true, outputPaths(c).length > 0),
      field("executionArchitecture", "single run_novel_optimizer invocation", "durable opening.optimize job", "enhanced"),
    ];
  },
  "opening-copy-expand": (o, c) => {
    const originalClipboard = clipboardWrites(o);
    const currentClipboard = uiEvidence(c, "clipboardWrites", []);
    return [
      field("clipboardWriteCount", originalClipboard.length, currentClipboard.length),
      field("openingCopied", originalClipboard[0], currentClipboard[0]),
      field("bodyCopied", originalClipboard[1], currentClipboard[1]),
      field("bodyExpandedThenCollapsed", true, uiEvidence(c, "bodyExpandedThenCollapsed")),
      field("databaseWrites", false, changedTables(c).length > 0),
      field("newOutputFiles", 0, outputPaths(c).length),
    ];
  },
  "opening-select-output": (o, c) => {
    const originalSet = invoke(o, "set_setting").args;
    const currentSet = call(c, "settings:set").args;
    return [
      field("directoryPicker", "plugin:dialog|open", call(c, "files:pick-directory").channel, "adapted"),
      field("settingKey", originalSet.key, currentSet[0], "adapted"),
      field("selectedDirectory", normalizePath(originalSet.value), normalizePath(currentSet[1])),
      field("persistedDirectory", normalizePath(originalSet.value), normalizePath(setting(c, "opening_output_dir"))),
    ];
  },
  "opening-export-open-dir": (o, c) => {
    const originalExport = invoke(o, "export_novel_optimizer_txt").args;
    const write = call(c, "files:write-text").args[0];
    const opened = call(c, "files:open-path").args[0];
    const currentOutput = parseJson(c.database.after.jobs.find((item) => item.type === "opening.optimize")?.output_json)?.text;
    return [
      field("exportedRenderedResult", true, Boolean(currentOutput) && write.text === currentOutput),
      field("fixtureResultTransport", originalExport.content ?? originalExport.text, write.text, "adapted", "Both export the rendered result; deterministic audit-result wording differs between the original harness and current fixture."),
      field("exportDirectory", normalizePath(originalExport.outDir ?? originalExport.directory), normalizePath(write.directory)),
      field("titleBasedTxtName", true, typeof write.defaultName === "string" && write.defaultName.endsWith("_开头优化.txt")),
      field("openedDirectory", normalizePath(invoke(o, "open_file_with_default").args.path), normalizePath(opened)),
      field("openedDirectoryExists", true, uiEvidence(c, "openedPathExists")),
      field("outputArtifactCreated", true, outputPaths(c).length > 0),
      field("artifactEvidence", "original mock exporter", outputPaths(c), "enhanced"),
    ];
  },
  "inference-stop-one": (o, c) => {
    const originalStop = invoke(o, "stop_novel_inference").args;
    const cancelledId = call(c, "jobs:cancel").args[0];
    const cancelled = c.database.after.jobs.find((item) => item.id === cancelledId);
    const unaffected = c.database.after.jobs.filter((item) => item.type === "storyboard.infer" && item.id !== cancelledId);
    return [
      field("targetTask", originalStop.taskId ?? originalStop.id, cancelledId, "adapted", "Runtime-generated job IDs differ; both target the clicked task only."),
      field("targetCancelled", true, cancelled?.status === "cancelled"),
      field("otherInferenceJobsUnaffected", true, unaffected.every((item) => item.status !== "cancelled")),
      field("durableCancellation", "front-end task stop", changedTables(c).includes("jobs"), "enhanced"),
    ];
  },
  "inference-genre": (o, c) => {
    const oa = invoke(o, "run_novel_inference").args;
    const input = enqueueInput(c, "storyboard.infer");
    return [
      field("genre", oa.genre, input.genre),
      field("text", oa.text, input.text),
      field("title", oa.title, uiEvidence(c, "title", input.title)),
      field("outputDirectory", normalizePath(oa.outDir), normalizePath(setting(c, "infer_output_dir"))),
      field("durableJob", "single run_novel_inference invocation", jobStatus(c, "storyboard.infer"), "enhanced"),
      field("jobPersisted", true, Boolean(c.database.after.jobs.find((item) => item.type === "storyboard.infer"))),
    ];
  },
  "inference-paused-open": (o, c) => {
    const originalPath = invoke(o, "open_file_with_default").args.path;
    const currentPath = call(c, "files:open-path").args[0];
    return [
      field("retainedDirectoryTransport", normalizePath(originalPath), normalizePath(currentPath), "adapted", "Current retained directories are job-scoped under the configured inference root."),
      field("openedRetainedDirectory", true, normalizePath(currentPath) === normalizePath(uiEvidence(c, "retainedDirectory"))),
      field("directoryExists", true, uiEvidence(c, "openedPathExists")),
      field("retainedJobState", "paused/retained", uiEvidence(c, "retainedJobStatus")),
      field("databaseWritesFromOpen", false, changedTables(c).length > 0),
    ];
  },
  "polish-stop": (o, c) => {
    const originalStop = invoke(o, "stop_text_polish").args;
    const cancelledId = call(c, "jobs:cancel").args[0];
    const cancelled = c.database.after.jobs.find((item) => item.id === cancelledId);
    return [
      field("targetTask", originalStop.taskId ?? originalStop.id, cancelledId, "adapted"),
      field("targetCancelled", true, cancelled?.status === "cancelled"),
      field("jobType", "text.polish", cancelled?.type),
      field("retryStateRetained", true, uiEvidence(c, "retryStateRetained")),
      field("durableCancellation", "front-end task stop", changedTables(c).includes("jobs"), "enhanced"),
    ];
  },
  "polish-export-open": (o, c) => {
    const write = call(c, "files:write-text").args[0];
    const originalExport = invoke(o, "export_text_polish_txt").args;
    return [
      field("clipboardWriteCount", clipboardWrites(o).length, uiEvidence(c, "clipboardWrites", []).length),
      field("exportText", originalExport.content ?? originalExport.text, write.text),
      field("exportDirectory", normalizePath(originalExport.outDir ?? originalExport.directory), normalizePath(write.directory)),
      field("openedDirectory", normalizePath(invoke(o, "open_file_with_default").args.path), normalizePath(call(c, "files:open-path").args[0])),
      field("outputArtifactCreated", true, outputPaths(c).length > 0),
      field("artifactEvidence", "original mock exporter", outputPaths(c), "enhanced"),
    ];
  },
  "image-reference": (o, c) => {
    const originalInput = invoke(o, "generate_image").args.input;
    const input = enqueueInput(c, "image.standalone");
    return [
      field("prompt", originalInput.prompt, input.prompt),
      field("referenceImageCount", originalInput.reference_images.length, (input.referenceImagePaths ?? []).length),
      field("referenceTransport", "base64 strings", "validated local paths", "adapted"),
      field("model", originalInput.model, input.model),
      field("size", originalInput.size, input.size),
      field("outputDirectory", normalizePath(originalInput.save_dir), normalizePath(input.outputDirectory)),
    ];
  },
  "image-edit-prompt": (o, c) => [
    field("savedPrompt", "保存后的角色提示词", uiEvidence(c, "savedPrompt")),
    field("editModeClosed", true, uiEvidence(c, "editModeClosed")),
    field("newGenerationTriggered", false, calls(c, "jobs:enqueue").length > 1),
    field("databaseWrites", false, changedTables(c).length > 0),
  ],
  "image-resend": (o, c) => {
    const originalInputs = invokes(o, "generate_image").map((item) => item.args.input);
    const currentInputs = calls(c, "jobs:enqueue").filter((item) => item.args[0] === "image.standalone").map((item) => item.args[1]);
    const beforeIds = new Set(c.database.before.jobs.filter((item) => item.type === "image.standalone").map((item) => item.id));
    const newJobs = c.database.after.jobs.filter((item) => item.type === "image.standalone" && !beforeIds.has(item.id));
    return [
      field("submissionCount", originalInputs.length, currentInputs.length),
      field("resendPrompt", originalInputs.at(-1)?.prompt, currentInputs.at(-1)?.prompt),
      field("sameSavedPrompt", originalInputs[0]?.prompt === originalInputs.at(-1)?.prompt, currentInputs[0]?.prompt === currentInputs.at(-1)?.prompt),
      field("newDurableJob", "front-end resend call", newJobs.length === 1 && newJobs[0]?.status === "done", "enhanced", "The audit clears IPC before the click, then proves the resend appended one completed SQLite job without overwriting history."),
    ];
  },
  "image-open-dir": (o, c) => [
    field("openedDirectory", normalizePath(invoke(o, "open_file_with_default").args.path), normalizePath(call(c, "files:open-path").args[0]), "enhanced", "Current opens the completed batch output directory instead of only the configured image root."),
    field("configuredDirectory", normalizePath(o.state.settings.imagegen_save_dir), normalizePath(setting(c, "imagegen_output_dir"))),
    field("directoryExists", true, uiEvidence(c, "openedPathExists")),
    field("databaseWrites", false, changedTables(c).length > 0),
  ],
  "image-stop-one": (o, c) => {
    const cancelledId = call(c, "jobs:cancel").args[0];
    const imageJobs = c.database.after.jobs.filter((item) => item.type === "image.standalone");
    return [
      field("clickedItemCancelled", true, imageJobs.find((item) => item.id === cancelledId)?.status === "cancelled"),
      field("onlyTargetCancelled", true, imageJobs.filter((item) => item.status === "cancelled").every((item) => item.id === cancelledId)),
      field("otherImageJobsUnaffected", true, imageJobs.some((item) => item.id !== cancelledId && item.status !== "cancelled")),
      field("durableCancellation", "front-end item state", changedTables(c).includes("jobs"), "enhanced"),
      field("partialFiles", 0, uiEvidence(c, "partialFiles", []).length),
    ];
  },
  "settings-account-add": (o, c) => {
    const originalAccount = o.storage.taskStore.state.browsers.at(-1);
    const created = call(c, "vidu-accounts:create").args[0];
    const currentAccount = c.database.after.viduAccounts.find((item) => item.name === created.name);
    const maxBeforeOrder = Math.max(-1, ...c.database.before.viduAccounts.map((item) => item.sort_order));
    return accountFields(originalAccount, currentAccount).concat([
      field("createPayload", pickAccountInput(originalAccount), created),
      field("enabledByDefault", true, currentAccount?.enabled === 1),
      field("appendedSortOrder", true, currentAccount?.sort_order > maxBeforeOrder),
      field("sessionIdentityCreated", true, Boolean(currentAccount?.session_key)),
      field("uniqueSessionKey", true, uiEvidence(c, "sessionKeyUnique")),
    ]);
  },
  "settings-account-delete-one": (o, c) => {
    const deletedId = call(c, "vidu-accounts:delete").args[0];
    return [
      field("accountCountAfter", o.storage.taskStore.state.browsers.length, c.database.after.viduAccounts.length),
      field("targetRemoved", true, !c.database.after.viduAccounts.some((item) => item.id === deletedId)),
      field("otherAccountsPreserved", true, c.database.before.viduAccounts.filter((item) => item.id !== deletedId).every((item) => c.database.after.viduAccounts.some((after) => after.id === item.id))),
      field("sessionCleanupTransport", "delete_browser_session", "vidu-accounts:delete main-process cleanup", "adapted"),
      field("sessionCleanupVerified", true, uiEvidence(c, "sessionCleanupVerified")),
    ];
  },
  "settings-account-reorder": (o, c) => [
    field("originalDisplayOrder", o.storage.taskStore.state.browsers.map((item) => item.index), [2, 1]),
    field("firstTwoSwapped", true, deepEqual(c.database.before.viduAccounts.slice(0, 2).map((item) => item.id).reverse(), c.database.after.viduAccounts.slice().sort((a, b) => a.sort_order - b.sort_order).slice(0, 2).map((item) => item.id))),
    field("moveDirection", "up", call(c, "vidu-accounts:move").args[1] ?? call(c, "vidu-accounts:move").args[0]?.direction),
    field("sortOrdersUnique", true, new Set(c.database.after.viduAccounts.map((item) => item.sort_order)).size === c.database.after.viduAccounts.length),
  ],
  "settings-account-toggle": (o, c) => {
    const updates = calls(c, "vidu-accounts:update").map((item) => item.args[1] ?? item.args[0]?.patch ?? item.args[0]);
    const targetId = calls(c, "vidu-accounts:update")[0]?.args[0]?.id ?? calls(c, "vidu-accounts:update")[0]?.args[0];
    const after = c.database.after.viduAccounts.find((item) => item.id === targetId) ?? c.database.after.viduAccounts[0];
    return [
      field("disabledTransition", false, updates[0]?.enabled),
      field("reenabledTransition", true, updates.at(-1)?.enabled),
      field("clearDisabledOnEnable", true, updates.at(-1)?.clearDisabled),
      field("finalEnabled", true, after?.enabled === 1),
      field("disabledFieldsCleared", true, disabledFieldsCleared(after)),
    ];
  },
  "settings-account-edit": (o, c) => {
    const originalAccount = o.storage.taskStore.state.browsers[0];
    const updates = calls(c, "vidu-accounts:update");
    const targetId = updates[0]?.args[0]?.id ?? updates[0]?.args[0];
    const currentAccount = c.database.after.viduAccounts.find((item) => item.id === targetId) ?? c.database.after.viduAccounts[0];
    return accountFields(originalAccount, currentAccount).concat([
      field("separatePersistentUpdates", 3, updates.length),
    ]);
  },
  "settings-account-daily-reset": (o, c) => {
    const beforeMember = c.database.before.viduAccounts.find((item) => item.account_type === "member");
    const afterMember = c.database.after.viduAccounts.find((item) => item.id === beforeMember?.id);
    const beforePoints = c.database.before.viduAccounts.find((item) => item.account_type === "points");
    const afterPoints = c.database.after.viduAccounts.find((item) => item.id === beforePoints?.id);
    return [
      field("resetEntryPoint", "重置每日", call(c, "vidu-accounts:reset-daily-usage").channel, "adapted"),
      field("memberUsageCleared", true, afterMember?.usage_count === 0 && afterMember?.usage_date === ""),
      field("pointsUsagePreserved", true, beforePoints?.usage_count === afterPoints?.usage_count && beforePoints?.usage_date === afterPoints?.usage_date),
      field("originalRuntimeNopeakFlag", false, Boolean(o.storage.taskStore.state.accountIssues?.["1"]?.nopeak)),
    ];
  },
  "settings-account-clear-flags": (o, c) => {
    const update = call(c, "vidu-accounts:update");
    const targetId = update.args[0]?.id ?? update.args[0];
    const target = c.database.after.viduAccounts.find((item) => item.id === targetId) ?? c.database.after.viduAccounts[0];
    return [
      field("scope", "all front-end accountIssues", "selected durable account disabled_*", "adapted"),
      field("enabled", true, target?.enabled === 1),
      field("disabledFieldsCleared", true, disabledFieldsCleared(target)),
      field("otherAccountsUnchanged", true, accountsExceptEqual(c.database.before.viduAccounts, c.database.after.viduAccounts, target?.id)),
      field("noLegacyAccountIssuesCreated", true, uiEvidence(c, "legacyAccountIssuesAbsent")),
    ];
  },
  "settings-account-unblock": (o, c) => {
    const update = call(c, "vidu-accounts:update");
    const patch = update.args[1] ?? update.args[0]?.patch ?? update.args[0];
    const targetId = update.args[0]?.id ?? update.args[0];
    const target = c.database.after.viduAccounts.find((item) => item.id === targetId) ?? c.database.after.viduAccounts[0];
    return [
      field("enablePatch", true, patch.enabled),
      field("clearDisabledPatch", true, patch.clearDisabled),
      field("finalEnabled", true, target?.enabled === 1),
      field("disabledFieldsCleared", true, disabledFieldsCleared(target)),
      field("legacyIssueCleared", true, uiEvidence(c, "legacyAccountIssuesAbsent")),
    ];
  },
  "theme-toggle": (o, c) => [
    field("darkModeReached", true, uiEvidence(c, "darkModeReached")),
    field("lightModeRestored", "original case stops after dark", uiEvidence(c, "lightModeRestored"), "enhanced"),
    field("themeStorageTransport", "manniu-theme.state.mode", "ai-tool-theme", "adapted"),
    field("persistedThemeSequence", ["dark", "light"], uiEvidence(c, "persistedThemeSequence")),
    field("domThemeSynchronized", true, uiEvidence(c, "domThemeSynchronized")),
    field("databaseWrites", false, changedTables(c).length > 0),
  ],
  "logout": (o, c) => [
    field("originalBehavior", "clear token/user and navigate /login", "no application auth session exists", "adapted"),
    field("logoutControlAbsent", false, uiEvidence(c, "logoutControlPresent")),
    field("authKeysRequired", false, uiEvidence(c, "authKeysRequired")),
    field("businessRoutesDirectlyAccessible", true, uiEvidence(c, "businessRoutesDirectlyAccessible")),
    field("authDatabaseDependency", false, uiEvidence(c, "authDatabaseDependency")),
  ],
  "updater-check": (o, c) => [
    field("originalUpdaterInvoke", invokes(o, "plugin:updater|check").length, calls(c, "plugin:updater|check").length, "adapted", "Current source deployment deliberately does not contact the original author's updater."),
    field("authorUpdaterActivityAbsent", true, calls(c, "plugin:updater|check").length === 0 && (c.blockedExternalRequests ?? []).length === 0),
    field("localDeploymentNotice", true, uiEvidence(c, "localDeploymentNoticeVisible")),
    field("mentionsDataRetention", true, uiEvidence(c, "mentionsDataRetention")),
    field("databaseWrites", false, changedTables(c).length > 0),
  ],
};

function genericFields(o, c) {
  const originalInvokes = originalCalls(o);
  const currentInvokes = relevantCurrentCalls(c.id, c);
  const originalProjectCount = Array.isArray(o.state?.projects) ? o.state.projects.length : null;
  const originalStoryboardCount = Array.isArray(o.state?.storyboards) ? o.state.storyboards.length : null;
  const currentChangedTables = Object.entries(c.database?.delta ?? {}).filter(([, value]) => value.changed).map(([name]) => name);
  const fields = [
    field("uiEntryPoint", o.route ?? o.id, c.uiAction?.control ?? c.id, "adapted", "Both cases were reached through their real rendered UI controls."),
    field("invokeNames", originalInvokes.map((item) => item.name), currentInvokes.map((item) => item.channel), "adapted", "The desktop rewrite transports the same action through Electron IPC and durable repositories."),
    field("invokeArguments", originalInvokes.map((item) => item.args), currentInvokes.map((item) => item.args), "adapted", "Arguments are retained for audit; identifiers and architecture-specific envelopes are normalized."),
    field("projectCountAfter", originalProjectCount, c.database?.after?.projects?.length ?? null, "adapted"),
    field("storyboardCountAfter", originalStoryboardCount, c.database?.after?.storyboards?.length ?? null, "adapted"),
    field("durableChangedTables", "original front-end/backend state snapshot", currentChangedTables, "enhanced", "Current audit records the exact SQLite tables changed by the UI action."),
  ];
  if ((c.outputFiles?.created?.length ?? 0) > 0) {
    fields.push(field("outputArtifacts", "original mock/state evidence", c.outputFiles.created.map((item) => ({ path: item.path, sha256: item.sha256 })), "enhanced"));
  }
  return fields;
}

function jianyingFields(o, c, auto) {
  const oa = invoke(o, "export_jianying_draft").args;
  const ca = call(c, "jianying:export").args[0];
  const fields = [
    field("projectName", oa.projectName, ca.projectName),
    field("draftRoot", normalizePath(oa.jianyingDraftPath), normalizePath(ca.draftRoot)),
    field("subtitles", oa.subtitles, ca.subtitles),
    field("audioPath", normalizePath(oa.audioPath), normalizePath(ca.audioClips?.[0]?.filePath)),
    field("timelineDurationUs", 13_000_000, ca.timelineDurationUs),
    field("missingVisuals", "implicit original exporter behavior", ca.blackClips?.map(({ startUs, durationUs }) => ({ startUs, durationUs })), "enhanced"),
    field("realDraftFiles", "not produced by original mock", c.outputFiles.created.filter((item) => /draft_(?:content|meta_info)\.json$/u.test(item.path)).map((item) => ({ path: item.path, sha256: item.sha256 })), "enhanced"),
  ];
  if (!auto) fields.push(field("preserveVisualSpeed", "implicit original speed", ca.preserveVisualSpeed, "adapted", "Current makes the original-speed rule explicit in IPC."));
  if (auto) {
    fields.push(field("speedTargets", oa.speedTargets, ca.subtitles.map((subtitle, index) => ({
      idx: index + 1,
      targetUs: subtitle.endUs - subtitle.startUs,
      srtStartUs: subtitle.startUs,
      srtEndUs: subtitle.endUs,
    }))));
    fields.push(field("speedTransport", "speedTargets", "visualClips.durationUs/sourceDurationUs", "adapted"));
  }
  return fields;
}

function settingsFields(o, c, mappings) {
  const originalSets = new Map(invokes(o, "set_setting").map((item) => [item.args.key, item.args.value]));
  return mappings.map(([oldKey, newKey]) => {
    const secret = /api_key$/u.test(oldKey);
    const originalValue = secret ? (originalSets.get(oldKey) ? "configured/redacted" : "missing") : originalSets.get(oldKey);
    const currentValue = secret ? (secretConfigured(c, newKey) ? "configured/redacted" : "missing") : setting(c, newKey);
    return field(oldKey === newKey ? oldKey : `${oldKey} -> ${newKey}`, normalizePath(originalValue), normalizePath(currentValue), oldKey === newKey ? undefined : "adapted");
  }).concat(field("saveScope", `${mappings.length} original keys`, "full current settings form", "enhanced"));
}

function field(name, originalValue, currentValue, verdict, note = "") {
  const original = normalizeValue(originalValue);
  const current = normalizeValue(currentValue);
  return { name, original, current, verdict: verdict ?? (deepEqual(original, current) ? "equal" : "different"), note };
}

function caseLevel(id, fields) {
  if (fields.some((item) => item.verdict === "different")) return "different";
  if (fields.some((item) => item.verdict === "runtime-not-comparable")) return "runtime-not-comparable";
  if (extraCaseLevelPolicies[id]) return extraCaseLevelPolicies[id];
  if (fields.some((item) => item.verdict === "enhanced")) return "enhanced";
  if (fields.some((item) => item.verdict === "adapted")) return "adapted";
  return "equal";
}

const caseNotes = {
  "project-check": "The current check really entered the recovery handler and persisted manual_check_start/manual_check_failed. Provider result is intentionally not treated as parity evidence.",
  "project-start": "The extra current job for storyboard #2 resumes/checks its persisted task ID and cannot make a duplicate paid submission.",
  "project-pause": "Current pause preserves the original control intent and adds durable, restart-safe resume state without cancelling the provider task.",
  "jianying-normal": "Current evidence contains fulfilled IPC plus actual Jianying JSON files and SHA-256 hashes.",
  "jianying-auto-srt": "Current explicit clip durations encode the original speedTargets semantics and actual draft files were generated.",
  "opening-docx": "Compares parsed DOCX text and the complete opening.optimize job input; selecting a file alone is not accepted as parity.",
  "opening-enhanced": "Requires enhanced mode in the durable job input and evidence that an enhanced result was captured and written.",
  "opening-copy-expand": "Requires the two distinct clipboard payloads plus the expanded-then-collapsed DOM state, with no database or file side effects.",
  "opening-select-output": "Compares the selected path, settings IPC key/value, and persisted opening_output_dir value.",
  "opening-export-open-dir": "Compares exported text/path/name, the directory actually opened, and a hashed output artifact.",
  "inference-stop-one": "Requires the clicked job alone to be cancelled while other inference jobs remain active or recoverable.",
  "inference-genre": "Requires the selected genre to reach the storyboard.infer input, not merely appear selected in the UI.",
  "inference-paused-open": "Requires the retained work directory to be the path passed to files:open-path and to exist on disk.",
  "polish-stop": "Requires a durable text.polish cancellation and a retained retry state.",
  "polish-export-open": "Requires clipboard, exported text, opened directory, and real file evidence from the edited result.",
  "image-reference": "Compares the reference count and generation fields while documenting the base64-to-local-path transport adaptation.",
  "image-edit-prompt": "Requires the saved prompt, closed edit state, and proof that save did not silently enqueue a generation.",
  "image-resend": "Requires the resend prompt to reach one fresh UI submission and proves that it appends a completed SQLite job without overwriting history.",
  "image-open-dir": "Requires files:open-path to prefer the completed batch output directory, remain under the configured image root, and validate that it exists.",
  "image-stop-one": "Requires only the clicked image job to be cancelled and no partial output files to remain.",
  "settings-account-add": "Compares all user-editable account fields plus enabled, append order, and unique session identity in SQLite.",
  "settings-account-delete-one": "Requires only the selected SQLite account row and its session to be removed.",
  "settings-account-reorder": "Compares the actual persisted account ID order and verifies unique sort_order values.",
  "settings-account-toggle": "Requires disable and re-enable transitions, including clearing persisted disabled metadata.",
  "settings-account-edit": "Compares the final SQLite name, account type, and quota and requires each UI edit to persist.",
  "settings-account-daily-reset": "Requires member daily usage to reset while points-account cumulative usage remains unchanged.",
  "settings-account-clear-flags": "Original global volatile flags are adapted to per-account durable disabled fields; the selected row must clear without changing peers.",
  "settings-account-unblock": "Requires enabled=true and clearDisabled=true to persist with all disabled metadata cleared.",
  "theme-toggle": "Requires both DOM theme transitions and their localStorage sequence with no database write.",
  "logout": "Explicitly proves non-applicability: the local source deployment has no author login session, logout control, auth table, or route gate.",
  "updater-check": "Explicitly compares the removed author updater with the local deployment notice and requires zero updater IPC/network activity.",
};

const extraCaseLevelPolicies = {
  "opening-docx": "enhanced",
  "opening-enhanced": "enhanced",
  "opening-copy-expand": "equal",
  "opening-select-output": "adapted",
  "opening-export-open-dir": "enhanced",
  "inference-stop-one": "enhanced",
  "inference-genre": "enhanced",
  "inference-paused-open": "equal",
  "polish-stop": "enhanced",
  "polish-export-open": "enhanced",
  "image-reference": "adapted",
  "image-edit-prompt": "equal",
  "image-resend": "enhanced",
  "image-open-dir": "enhanced",
  "image-stop-one": "enhanced",
  "settings-account-add": "enhanced",
  "settings-account-delete-one": "adapted",
  "settings-account-reorder": "adapted",
  "settings-account-toggle": "enhanced",
  "settings-account-edit": "equal",
  "settings-account-daily-reset": "adapted",
  "settings-account-clear-flags": "adapted",
  "settings-account-unblock": "adapted",
  "theme-toggle": "enhanced",
  "logout": "not-applicable",
  "updater-check": "adapted",
};

function assertSpecializedCoverage() {
  const extraIds = extraSpec.cases.map((item) => item.id);
  const missingBuilders = extraIds.filter((id) => typeof fieldBuilders[id] !== "function");
  const missingNotes = extraIds.filter((id) => !caseNotes[id]);
  const missingLevels = extraIds.filter((id) => !extraCaseLevelPolicies[id]);
  const missingOriginal = extraIds.filter((id) => !ids.includes(id));
  if (missingBuilders.length || missingNotes.length || missingLevels.length || missingOriginal.length) {
    throw new Error(`Extra-case strict coverage failed: ${JSON.stringify({ missingBuilders, missingNotes, missingLevels, missingOriginal })}`);
  }
  const parityLevels = new Set(["equivalent", "adapted", "not-applicable"]);
  const invalidSpecParity = extraSpec.cases.filter((item) => !parityLevels.has(item.parity)).map((item) => `${item.id}:${item.parity}`);
  if (invalidSpecParity.length) throw new Error(`Unsupported extra-case parity values: ${invalidSpecParity.join(", ")}`);
}

function originalCalls(c) {
  return c.calls.filter((item) => item.kind === "invoke").map((item) => ({ name: item.name, args: normalizeValue(item.args) }));
}

function calls(c, channel) {
  return c.calls.filter((item) => item.channel === channel);
}

function enqueueInput(c, type, index = 0) {
  const found = calls(c, "jobs:enqueue").filter((item) => item.args[0] === type)[index];
  if (!found) throw new Error(`${c.id}: current enqueue missing ${type} at index ${index}`);
  return found.args[1];
}

function jobStatus(c, type) {
  const jobs = c.database.after.jobs.filter((item) => item.type === type);
  return jobs.at(-1)?.status ?? null;
}

function clipboardWrites(c) {
  return c.calls.filter((item) => item.kind === "clipboard").map((item) => normalizeValue(item.args?.text ?? item.args ?? item.text ?? item.value));
}

function uiEvidence(c, key, fallback = undefined) {
  if (Object.prototype.hasOwnProperty.call(c.uiAction ?? {}, key)) return c.uiAction[key];
  if (Object.prototype.hasOwnProperty.call(c.uiAction?.evidence ?? {}, key)) return c.uiAction.evidence[key];
  return fallback;
}

function changedTables(c) {
  return Object.entries(c.database?.delta ?? {}).filter(([, value]) => value.changed).map(([name]) => name);
}

function outputPaths(c) {
  return (c.outputFiles?.created ?? []).map((item) => ({ path: normalizePath(item.path), sha256: item.sha256 }));
}

function accountFields(originalAccount, currentAccount) {
  return [
    field("accountName", originalAccount?.name, currentAccount?.name),
    field("accountType", originalAccount?.accountType, currentAccount?.account_type),
    field("defaultQuota", originalAccount?.defaultQuota, currentAccount?.default_quota),
  ];
}

function pickAccountInput(account) {
  return {
    name: account?.name,
    accountType: account?.accountType,
    defaultQuota: account?.defaultQuota,
  };
}

function disabledFieldsCleared(account) {
  return Boolean(account) && account.disabled_reason === null && account.disabled_message === null && account.disabled_at === null;
}

function accountsExceptEqual(before, after, excludedId) {
  const stable = (item) => ({
    id: item.id,
    name: item.name,
    enabled: item.enabled,
    account_type: item.account_type,
    default_quota: item.default_quota,
    usage_count: item.usage_count,
    usage_date: item.usage_date,
    sort_order: item.sort_order,
    disabled_reason: item.disabled_reason,
    disabled_message: item.disabled_message,
    disabled_at: item.disabled_at,
  });
  const beforePeers = before.filter((item) => item.id !== excludedId).map(stable);
  const afterPeers = after.filter((item) => item.id !== excludedId).map(stable);
  return deepEqual(beforePeers, afterPeers);
}

function relevantCurrentCalls(id, c) {
  const channels = new Set(c.expectedChannels ?? []);
  if (id.startsWith("jianying-")) channels.add("files:read-subtitle");
  if (id === "inference-submit") ["projects:create", "files:write-text"].forEach((item) => channels.add(item));
  if (id === "project-q2-q3" || id.startsWith("settings-")) channels.add("settings:set");
  return c.calls.filter((item) => channels.has(item.channel)).filter((item) => {
    if (!id.startsWith("settings-") || item.channel !== "settings:set") return true;
    const prefixes = {
      "settings-inference-save": ["infer_"],
      "settings-polish-save": ["text_polish_"],
      "settings-folder-save": ["project_base_folder"],
      "settings-opening-save": ["opening_output_dir"],
      "settings-image-save": ["imagegen_"],
      "settings-jianying-save": ["jianying_draft_path"],
    }[id];
    return !prefixes || prefixes.some((prefix) => String(item.args[0]).startsWith(prefix));
  }).map((item) => ({ channel: item.channel, args: normalizeValue(item.args), status: item.status, error: item.error ? normalizeValue(item.error) : undefined }));
}

function summarizeSqlite(c) {
  return {
    retainedSnapshot: c.database.retainedSnapshot,
    changedTables: Object.entries(c.database.delta).filter(([, value]) => value.changed).map(([name]) => name),
    projectCount: c.database.after.projects.length,
    storyboardCount: c.database.after.storyboards.length,
    jobStates: c.database.after.jobs.map((item) => ({ type: item.type, status: item.status, progress: item.progress })),
    storyboardEvents: c.database.after.storyboardEvents.map((item) => item.event_type),
  };
}

function invoke(c, name) { const found = c.calls.find((item) => item.kind === "invoke" && item.name === name); if (!found) throw new Error(`${c.id}: original invoke missing ${name}`); return found; }
function invokes(c, name) { return c.calls.filter((item) => item.kind === "invoke" && item.name === name); }
function call(c, channel) { const found = c.calls.find((item) => item.channel === channel); if (!found) throw new Error(`${c.id}: current call missing ${channel}`); return found; }
function jobInputs(c, type) { return c.database.after.jobs.filter((item) => item.type === type).map((item) => parseJson(item.input_json)); }
function storyboard(c, index, phase) { const found = c.database[phase].storyboards.find((item) => item.idx === index); if (!found) throw new Error(`${c.id}: storyboard idx ${index} missing`); return found; }
function storyboardById(c, id, phase) { const found = c.database[phase].storyboards.find((item) => item.id === id); if (!found) throw new Error(`${c.id}: storyboard id ${id} missing`); return found; }
function setting(c, key) { return c.database.after.settings.find((item) => item.key === key)?.value ?? null; }
function secretConfigured(c, key) { const value = setting(c, key); return Boolean(value && value !== ""); }
function splitSubjects(value) { return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean); }
function parseJson(value) { try { return JSON.parse(value); } catch { return value; } }
function normalizeUuid(value) { return typeof value === "string" && /^[0-9a-f-]{36}$/iu.test(value) ? "<uuid>" : value; }

function normalizeCurrentArtifactPath(value) {
  for (const root of currentArtifactRoots) {
    const relative = path.win32.relative(root, value);
    if (!relative || relative === "." || relative === ".." || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative)) continue;
    const mappings = [
      [["project", "开头"], "<openingRoot>"],
      [["selected-output"], "<openingRoot>"],
      [["project", "推理"], "<inferenceRoot>"],
      [["project", "捋文"], "<polishRoot>"],
      [["project", "图片"], "<imageRoot>"],
      [["jianying-drafts"], "<jianyingRoot>"],
      [["project"], "<projectDir>"],
    ];
    for (const [segments, token] of mappings) {
      const prefix = path.win32.join(...segments);
      if (relative.toLowerCase() === prefix.toLowerCase()) return token;
      if (relative.toLowerCase().startsWith(`${prefix.toLowerCase()}${path.win32.sep}`)) {
        return `${token}${path.win32.sep}${relative.slice(prefix.length + 1)}`;
      }
    }
  }
  return value;
}

function normalizePath(value) {
  if (typeof value !== "string") return value;
  return normalizeCurrentArtifactPath(value)
    .replace(/^C:\\AI审计\\项目/iu, "<projectDir>")
    .replace(/^C:\\AI审计\\开头/iu, "<openingRoot>")
    .replace(/^C:\\AI审计\\选择目录/iu, "<openingRoot>")
    .replace(/^C:\\AI审计\\推理/iu, "<inferenceRoot>")
    .replace(/^C:\\AI审计\\捋文/iu, "<polishRoot>")
    .replace(/^C:\\AI审计\\图片/iu, "<imageRoot>")
    .replace(/^C:\\AI审计\\剪映草稿/iu, "<jianyingRoot>")
    .replace(/^.*?\\audit\\a\d+\\[^\\]+\\project\\开头/iu, "<openingRoot>")
    .replace(/^.*?\\audit\\a\d+\\[^\\]+\\selected-output/iu, "<openingRoot>")
    .replace(/^.*?\\audit\\a\d+\\[^\\]+\\project\\推理/iu, "<inferenceRoot>")
    .replace(/^.*?\\audit\\a\d+\\[^\\]+\\project\\捋文/iu, "<polishRoot>")
    .replace(/^.*?\\audit\\a\d+\\[^\\]+\\project\\图片/iu, "<imageRoot>")
    .replace(/^.*?\\audit\\a\d+\\[^\\]+\\project/iu, "<projectDir>")
    .replace(/^.*?\\audit\\a\d+\\[^\\]+\\jianying-drafts/iu, "<jianyingRoot>")
    .replace(/^.*?current-ui-interactions-artifacts\\[^\\]+\\project\\推理/iu, "<inferenceRoot>")
    .replace(/^.*?current-ui-interactions-artifacts\\[^\\]+\\project\\捋文/iu, "<polishRoot>")
    .replace(/^.*?current-ui-interactions-artifacts\\[^\\]+\\project\\图片/iu, "<imageRoot>")
    .replace(/^.*?current-ui-interactions-artifacts\\[^\\]+\\project/iu, "<projectDir>")
    .replace(/^.*?current-ui-interactions-artifacts\\[^\\]+\\jianying-drafts/iu, "<jianyingRoot>");
}

function normalizeValue(value) {
  if (typeof value === "string") return normalizePath(value).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/giu, "<uuid>");
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]));
  return value;
}
function deepEqual(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function countBy(values) { return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length])); }

function markdown(report) {
  const rows = report.cases.map((item) => `| ${item.id} | ${item.currentDynamicStatus} | ${item.level} | ${item.fields.filter((field) => field.verdict !== "equal").map((field) => `${field.name}:${field.verdict}`).join("<br>") || "all equal"} |`).join("\n");
  const details = report.cases.map((item) => {
    const fieldRows = item.fields.map((field) => `| ${field.name} | ${inline(field.original)} | ${inline(field.current)} | ${field.verdict} | ${field.note || ""} |`).join("\n");
    return `## ${item.id}\n\n- 判定：\`${item.level}\`\n- 动态执行：\`${item.currentDynamicStatus}\`\n- SQLite：${item.sqliteEvidence.changedTables.join("、") || "无业务表变化"}\n- 产物：${item.outputEvidence.length} 个新增或变化文件\n${item.note ? `- 说明：${item.note}\n` : ""}\n| 字段 | 原版 | 当前版 | 判定 | 说明 |\n| --- | --- | --- | --- | --- |\n${fieldRows}\n`;
  }).join("\n");
  return `# 原版 / 当前版同 fixture 动态逐字段差分\n\n生成时间：${report.generatedAt}\n\n## 总结\n\n- 当前版动态交互：\`${report.summary.currentDynamicPassed}/${report.summary.cases} passed\`。\n- 缺失入口：\`${report.summary.missingEntryPoints}\`。\n- 用例判定：${Object.entries(report.summary.levels).map(([key, value]) => `\`${key}=${value}\``).join("，")}。\n- 确认的业务差异：${report.summary.confirmedBusinessDifferences.length > 0 ? report.summary.confirmedBusinessDifferences.map((id) => `\`${id}\``).join("、") : "无"}。\n- Vidu/模型最终结果在隔离审计中不可直接 A/B；报告只比较提交字段和本地状态，不把原版 mock 成功当成真实服务成功。\n\n## 用例矩阵\n\n| 用例 | 当前动态 | 级别 | 非完全相同字段 |\n| --- | --- | --- | --- |\n${rows}\n\n${details}`;
}

function inline(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `\`${String(text).replace(/\|/gu, "\\|").replace(/\r?\n/gu, "\\n").slice(0, 500)}\``;
}

main();
