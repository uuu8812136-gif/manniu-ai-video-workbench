export function originalInferenceSkeletonPrompt(options: {
  title: string;
  genre: string;
}): string {
  const { title, genre } = options;
  return [
    `本文题材为「${genre}」。`,
    "/ai-tool-fenjing",
    `把 ${title}.txt 这篇小说转成 Vidu 视频分镜提示词，严格按本技能 SKILL.md 的全流程执行。你必须真实执行命令完成每一步，禁止只描述：`,
    "1)抽角色写入 角色表.txt；每个实际出场角色严格3行：标准名、定位 | 性别 | 年龄、完整定妆照提示词，禁止改成“- 性别/- 外貌”等项目符号清单；",
    `2)运行 python scripts/segment.py 完成分句，结果写入 ${title}_sentences.txt；按相邻三行复核每镜是否已形成可独立配画面的动作、原因、状态或结果，禁止切断主干或必要补语；允许“随后、又、而且、也意味着”等承接语气领起已经完整的可视命题，不得按书面语完整句机械合并；`,
    `3)按分句建 ${title}.csv 骨架，第一行必须是固定表头“编号,原声,秒数,画面提示词”，不得省略或改名；随后写编号/原声/秒数，D列留空；运行 python scripts/check_bcol.py ${title}.csv --origin=${title}.txt 校验B列；不通过必须回到 ${title}_marked.txt 调整边界，重新运行 segment.py 并重建CSV，禁止直接改写B列文字，直到退出码0；`,
    "4)确认CSV骨架已建好、每行ABC三列已填满、D列全部留空即可，**禁止填写D列画面提示词**。所有产物直接写在当前工作目录下，禁止新建任何子文件夹。",
    `最后运行 python scripts/check_dcol.py --roster-only ${title}.csv；角色表校验与 check_bcol 都退出码0，并确认CSV骨架完整后才结束。`,
  ].join("\n");
}

export function originalInferenceSkeletonRepairPrompt(options: {
  title: string;
  report: string;
  repeated?: boolean;
}): string {
  const { title, report, repeated = false } = options;
  return [
    repeated
      ? `Rust最终复验发现角色表或 ${title}.csv 的B列骨架同一错误连续存在。不要继续局部打补丁，按报告从头重写归属文件。`
      : `Rust最终复验发现角色表或 ${title}.csv 的B列骨架不合格。现在只修步骤1-3，禁止生成D列。`,
    `必须按报告分流修复：若有B列、分句或CSV骨架错误，回到 ${title}_marked.txt 调整边界，重新运行 python scripts/segment.py ${title}_marked.txt --origin=${title}.txt --out=${title}_sentences.txt，再按分句文件重建完整CSV骨架；若只有角色表错误，只按SKILL步骤1重写角色表，禁止改动已通过的分句和CSV。`,
    "禁止直接改写B列文字绕过来源；第一行固定为编号,原声,秒数,画面提示词，编号连续，秒数按公式，D列全部留空。角色表每块必须严格3行，完整定妆照提示词直接包含人物外貌设定，禁止项目符号清单。",
    `最后依次运行 python scripts/check_dcol.py --roster-only ${title}.csv 与 python scripts/check_bcol.py ${title}.csv --origin=${title}.txt，两者退出码均为0且D列全空才结束。静默执行。`,
    "报告末尾 STRUCTURED_VALIDATION_REPORT 的 issues 是未截断的唯一全量错误清单；逐项按 code、row、target、strategy 修复，禁止只看前20条文本摘要。当前报告：",
    report,
  ].join("\n");
}

export function originalInferenceBatchPrompt(options: {
  title: string;
  total: number;
  remaining: number;
  indexes: number[];
}): string {
  const { title, total, remaining, indexes } = options;
  const list = indexes.join("、");
  return [
    "/ai-tool-fenjing",
    "先完整读取本技能 SKILL.md、references/prompt-assembly.md 和 references/visual-reasoning.md；其中语义内核优先于控制词。",
    `继续执行本技能 SKILL.md 的【步骤4：逐镜写D列】，不要重新规划、不要重建骨架、不要碰角色表和分句。当前 ${title}.csv 共 ${total} 镜，仍有 ${remaining} 镜 D列(画面提示词)为空。本轮批次共 ${indexes.length} 镜，唯一允许填写的镜号：${list}。其他空D必须继续保持空白，禁止越过批次提前填写。`,
    "按 SKILL.md 步骤4 的 A锚定→B写链→C质检 流程逐镜写当前批次 D 列。写完本批立即停止，Rust会真实运行范围校验器；本批ERROR清零后才会下发下一批。",
    "铁律：1)★D列已非空的镜头和本批之外的镜号全部禁止 Edit、禁止重写、禁止润色、禁止质量提升；2)本批镜号很少时只写列出的镜，补完立即停止，不许顺手填写或修改其他镜；3)每个空D镜号单独一次 Edit，N个空D=N次Edit，禁止 Write 全表、禁止一次Edit写多镜、禁止任何Python脚本/正则批量写D列；",
    "4)★每格D列先写实际主体动作或表现，再紧接一个动态关键词、一个基础运镜和一个景别；三项各恰好一个，机位角度和特殊拍摄手法按需。控制块必须按“动态关键词→基础运镜→景别→机位角度→特殊拍摄手法”排列，禁止用控制项开头或写占位词；D列到画面内容结束，禁止写固定后缀“4K，3D国漫风格，电影级画质”，软件提交Vidu时会统一追加；",
    "5)官方控制词按内容选用：横向冲锋可用大动态+侧向跟拍+全景，庞然大物或高位登场可用大动态+镜头拉远+全景或中远景并按需低角度仰拍，逼近反应可用小动态+镜头推进+近景或脸部特写，地理/人群布局可用镜头拉远+远景并按需鸟瞰/航拍，围绕主体揭示可用360度环绕拍摄；不设使用配比或机械轮换，但三项必填控制不能省略；",
    "6)资产路由必须严格按事实：人物可见时使用角色表标准名@人物；无人且只有物理场景、群体、物件或效果时才使用@场景；真正进入梦境、识海、丹田等非物理空间时使用@特殊空间，有可见人物时同时@人物。人物镜禁止同时@场景；@名称必须来自角色表且名称后空一格，不得为满足@给人物补动作；",
    "7)先从当前B列提取主体、核心事件/关系、对象/结果/尺度和事实模态（现实、已发生、假设、回忆、目标、评价），D列必须完整呈现这些核心事实，再追加控制词。匿名光影、能量层级、轮廓、投影和虚影是合法视觉翻译；条件/假设/回忆必须以半透明推演或环境映像保持非现实模态，不能拍成正在发生。D列不得使用下一镜信息；明确转场后禁止沿用旧场景；不得用站立、看手、摇头、吐气替代核心事件；仍禁止脑海中、眼神中浮现等不可拍内心空间。",
    "8)承前代词(他/她/它/我)仅在前文指向唯一明确时还原为在场角色。仅提及、未现身角色不@；角色表没有的名字不得临时发明或补块。无论主体类型都必须把D列写完整；9)每镜写完做一次就地C质检；每5镜在内部静默复核B核心事实到D可见承载，检查核心事件遗漏、假设变现实、通用反应替代核心内容和连续镜头同质化，不输出对照文本。",
    "静默执行，只在当前批次全部写完后输出一句完成汇总。",
  ].join("\n");
}

export function originalInferenceBatchRepairPrompt(options: {
  title: string;
  indexes: number[];
  report: string;
  repeated?: boolean;
}): string {
  const { title, indexes, report, repeated = false } = options;
  const csvRows = indexes.join(",");
  return [
    repeated
      ? "同一错误连续存在，不要继续局部打补丁；按对应B列、相邻镜和角色表从头重写报告中的整格D列。"
      : "逐项按结构化报告的 code、row、target、strategy 修复；同镜多错一次清完。",
    "/ai-tool-fenjing",
    `当前D列批次镜号为 ${csvRows}，Rust范围校验未通过。`,
    "只允许修改报告中属于本批次的报错镜；禁止修改批次外D列、B列、编号、秒数和角色身份。空D也是本批错误，必须补齐。",
    `修完运行 python scripts/check_dcol.py ${title}.csv --rows=${csvRows} 复查，EXIT=0才结束。`,
    "STRUCTURED_VALIDATION_REPORT 的 issues 是完整错误清单，禁止只看文本前20条。当前报告：",
    report,
  ].join("\n");
}

export function originalInferenceSemanticReviewPrompt(title: string): string {
  return [
    "/ai-tool-fenjing",
    `语义审片：对当前 ${title}.csv 做一次独立的全表语义复核。先完整读取 SKILL.md、references/prompt-assembly.md 和 references/visual-reasoning.md。`,
    "每5镜静默检查主体、核心事件/关系、对象/结果/尺度和事实模态（现实、已发生、假设、回忆、目标、评价）是否从B列完整落到D列。",
    "只修复高置信问题：核心事件被站立/看手/摇头/吐气等通用反应替代；条件或假设被拍成现实；B列没有依据却新增人物动作、道具、结果；明确奇观被降级为空泛状态。",
    "抽象信息可以用匿名能量层级、光影、轮廓、投影、虚影或半透明推演具体化，但不得新增专有人物、地点、命名道具、第二动作或剧情结果。",
    "不得修改编号、原声、秒数、角色表和已经合格的D列；保留每格一个动态、一个基础运镜和一个景别，以及现有资产路由。只修改明确需要修正的D列，修完静默结束。",
  ].join("\n");
}

export function originalInferenceFullRepairPrompt(options: {
  title: string;
  report: string;
  repeated?: boolean;
}): string {
  const { title, report, repeated = false } = options;
  return [
    repeated
      ? "前面连续修复没有减少错误。不要继续在错误旧句上打补丁；对报告中仍报错的每一镜，重新读取该镜B列、相邻镜和角色表，按SKILL步骤4从头重写整格D列。只重写报错镜。"
      : "按报告逐条修复；同一镜有多条ERROR时一次处理完该镜的全部ERROR。",
    "/ai-tool-fenjing",
    `${title}.csv 已进入本技能 SKILL.md 的【步骤5：校验修复】。这是软件内部自动闭环，必须把 check_dcol 的全部 ERROR 修到退出码0，不得因错误较多提前结束。`,
    "改一镜验一镜，每个报错镜单独一次 Edit，禁止 Write 全表、禁止Python脚本/正则批量改。D列为空也属于报错镜，必须补完整。报告中的所有ERROR类型都要处理，不限于代词、缺@、@格式、白名单、控制项、误写固定画质后缀、逗号、禁用词、不可拍心理、外貌或角色表格式。若是角色表格式错误，只做维持人物身份不变的最小修正，并同步受影响的@标准名。禁止为修复任何格式错误而继承或发明地点；环境/物件/效果句没有人物时补@场景；特殊空间按@特殊空间路由；不得为满足@给人物补动作；人物镜禁止补@场景。绝对禁止修改没报错的镜，禁止改B列、编号和秒数。",
    `修完运行 python scripts/check_dcol.py ${title}.csv 复查；仍有ERROR就继续修本轮能看到的错误。静默执行。`,
    "报告末尾 STRUCTURED_VALIDATION_REPORT 的 issues 是未截断的唯一全量错误清单；必须逐项按 code、row、row_end、target、strategy 修复，不能跳过文本摘要未显示的错误。当前校验报告如下：",
    report,
  ].join("\n");
}

export function originalOpeningAgentPrompt(mode: "general" | "enhanced"): string {
  const enhanced = mode === "enhanced";
  return [
    "/novel-optimizer",
    `你正在运行${enhanced ? "增强版" : "通用版"}开头智能体。按本技能 SKILL.md 的完整规则，根据 原文.txt 生成推文开头。`,
    `你必须真实执行命令完成每一步，最终写满 ${enhanced ? 10 : 5} 个备选开头，并按软件输出格式写入当前工作目录的 output_kaitou.txt，纯文本UTF-8。`,
    enhanced
      ? "每个开头必须带自己写的过渡句和原文章节衔接标注；只保留用于定位的原文第一句锚点。"
      : "严禁改写、概括、续写或复制原文正文到产物，正文会由程序原样追加。",
    "全程无联网，不抓网页不搜索；只可读取当前工作区内本技能自带的资料。所有产物直接写在当前工作目录下，禁止新建子文件夹。",
  ].join("\n");
}

export function originalOpeningRepairPrompt(mode: "general" | "enhanced", errors: string[]): string {
  return [
    "继续完成任务，不要重新规划、不要重写已通过的部分。",
    `产物文件 output_kaitou.txt 必须最终包含完整的 ${mode === "enhanced" ? 10 : 5} 个${mode === "enhanced" ? "增强版" : "通用版"}备选开头。`,
    "按本技能 SKILL.md 的规则修复下列程序校验错误，补全后再次自检：",
    ...errors.map((error) => `- ${error}`),
    "严禁把完整原文写入产物；文件必须使用纯英文名 output_kaitou.txt 并落在当前工作目录。",
  ].join("\n");
}
