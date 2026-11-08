/**
 * 续写工坊 · 提示词（纯文本常量 + 纯函数）
 *
 * 清洗提示词的字段设计对齐 novel-injector `lib/prompts.js` 的清洗 schema
 * （nodes / chars / world + compressed），因为 lib/kb.js 的解析器就是按它写的；
 * 总结提示词沿用 xu-xie-ji 「只输出摘要正文、不要解释」的约束。
 */

/** 清洗：把一段原文压成「压缩正文 + 剧情节点 + 角色 + 设定」 */
export const FW_CLEAN_SYSTEM_PROMPT = [
    '你是资深小说编辑，负责把小说原文整理成结构化资料，供后续续写与检索使用。',
    '处理原则：',
    '- 准确保留事件性质、参与人物、关键行为、时间地点、因果与后果。',
    '- 视角统一为第三人称全知，压缩比约 10:1～15:1，剔除重复描写与冗余形容。',
    '- 原文没有的信息不要补造，不把推测写成事实。',
    '- 对冲突、伤害、亲密关系等情节使用客观的摘要语言，只记录剧情意义。',
    '',
    '只输出一个 JSON 对象，不要解释、不要 Markdown 围栏以外的文字。结构如下：',
    '{',
    '  "compressed": "本段的压缩正文（保留时间线与因果）",',
    '  "nodes": [',
    '    {',
    '      "title": "节点标题（不超过 20 字）",',
    '      "body": "这个节点发生了什么（80~200 字）",',
    '      "lane": "main | sub | pivot",',
    '      "time": "故事内时间",',
    '      "location": "地点",',
    '      "events": ["同一场景内的小事件"],',
    '      "foreshadow": ["本段埋下的伏笔；没有就空数组"],',
    '      "chars": ["本节点出场的人名"]',
    '    }',
    '  ],',
    '  "chars": [',
    '    {',
    '      "name": "姓名",',
    '      "aliases": ["别名/道号/绰号"],',
    '      "identity": "身份与阵营",',
    '      "appearance": "外貌要点",',
    '      "personality": "性格与说话方式",',
    '      "relations": ["与谁是什么关系"],',
    '      "exitStage": 0',
    '    }',
    '  ],',
    '  "world": [',
    '    { "category": "rule|faction|place|power|item", "label": "条目名", "content": "一句话说明", "keywords": ["触发词"] }',
    '  ]',
    '}',
    '要求：nodes 按时间顺序；chars 只收录本段真正出场或明确提到的人；world 只写本段透露的规则。',
].join('\n');

/**
 * 清洗请求的 user 消息。`previousTail` 用来衔接上一段（novel-injector 用 800 字前段参考）。
 * @param {{text:string, previousTail?:string, chunkIdx?:number, total?:number}} task
 */
export function fwBuildCleanUserMessage(task = {}) {
    const prev = String(task.previousTail || '').trim();
    const label = task.chunkIdx ? `第 ${task.chunkIdx} / ${task.total || '?'} 段` : '本段';
    const parts = [];
    if (prev) parts.push(`【前段参考（仅供衔接，不要重复压缩）】\n${prev}\n`);
    parts.push(`【本段原文（${label}）】\n${String(task.text || '').trim()}`);
    parts.push('请按 system 中的 JSON 结构输出本段结果。');
    return parts.join('\n');
}

/** 总结一段正文（分层总结的小总结） */
export const FW_SUMMARY_SYSTEM_PROMPT = [
    '你是小说剧情记录员。请把给定正文压缩成剧情摘要。',
    '要求：',
    '1. 只输出摘要正文，不要标题、不要解释、不要 Markdown。',
    '2. 保留：谁做了什么、为什么、结果如何；人物关系与称呼变化；埋下或回收的伏笔。',
    '3. 不要评论文笔，不要续写，不要补充原文没有的内容。',
    '4. 用平实的叙述语言，按时间顺序写。',
].join('\n');

/**
 * 总结请求消息。
 * @param {{text:string, targetWords?:number, title?:string}} task
 */
export function fwBuildSummaryMessages(task = {}) {
    const target = Math.max(100, parseInt(task.targetWords, 10) || 800);
    return [
        { role: 'system', content: FW_SUMMARY_SYSTEM_PROMPT },
        {
            role: 'user',
            content: `【需要总结的正文】\n${String(task.text || '').trim()}\n\n请输出约 ${target} 字的剧情摘要。`,
        },
    ];
}

/**
 * 把小总结合并成长篇大总结（xu-xie-ji 的 maybeMergeAutoSummaries 的提示词部分）。
 * @param {{items:{start:number,end:number,text:string}[], targetWords?:number}} task
 */
export function fwBuildMergeSummaryMessages(task = {}) {
    const target = Math.max(300, parseInt(task.targetWords, 10) || 1200);
    const list = Array.isArray(task.items) ? task.items : [];
    const body = list
        .map((s, i) => `【小总结${i + 1}｜原文${s.start}-${s.end}字】\n${s.text}`)
        .join('\n\n');
    return [
        { role: 'system', content: FW_SUMMARY_SYSTEM_PROMPT },
        {
            role: 'user',
            content: `【需要合并的多条小总结】\n${body}\n\n请合并成一条连贯的长篇大总结，约 ${target} 字，保留主线因果与仍未回收的伏笔。`,
        },
    ];
}

/** 润色：只润色本轮新增正文（xu-xie-ji 的自动润色约束） */
export const FW_POLISH_SYSTEM_PROMPT = [
    '你是小说润色编辑。只润色用户提供的本轮新增正文。',
    '要求：',
    '1. 保留剧情事实、人物关系、称呼、对白含义和段落顺序。',
    '2. 降低 AI 味：少用排比与华丽辞藻，句子长短自然，避免每句都工整。',
    '3. 不新增剧情，不删减信息，不输出解释或标题，只输出润色后的正文。',
].join('\n');

/**
 * @param {string} text
 */
export function fwBuildPolishMessages(text) {
    return [
        { role: 'system', content: FW_POLISH_SYSTEM_PROMPT },
        { role: 'user', content: `【需要润色的本轮新增正文】\n${String(text || '').trim()}` },
    ];
}

/**
 * 幕间（「色情加料」）模式的专属约束。
 *
 * 为什么需要它：常规模型续写最常犯的毛病是「急于推进情节」——三两句就把亲密互动带过、
 * 顺手跳到下一天。这里用显式禁令把时间线钉住，逼它把当前场景写透（指针不动、不跳时间）。
 */
export const FW_INTERLUDE_INSTRUCTION = [
    '【本次续写为幕间：当前场景的细节扩展】',
    '1. 严禁跳过时间，严禁结束当前事件，严禁推进到下一个剧情节点（剧情指针保持不动）。',
    '2. 只写当前场景之内正在发生的事：环境氛围、肢体触碰、感官描写、言语挑逗、身体反应与心理挣扎。',
    '3. 把每一个动作拆细，允许节奏慢、允许留白，不要用一两句话概括亲密互动。',
    '4. 上面若给了后续剧情指引，本次只用来铺垫氛围，不要据此把剧情往前推。',
    '5. 仍然只输出正文：不写解释、不加标题，不新增原文没有的人物与设定。',
].join('\n');

/** 幕间模式的快捷标签库（点一下就拼进「定向要求」，省得每次重打提示词） */
export const FW_SPICE_TAGS = ['言语挑逗', '慢节奏细节', '感官描写', '主从逆转', '道具运用', '心理挣扎'];

/**
 * 把标签拼进「定向要求」：已经有了就不重复拼，空标签直接忽略。
 * 不按逗号切分再重组 —— 用户可能写了整句要求，切开会把它拆坏。
 * @param {string} current 现有定向要求
 * @param {string} tag
 */
export function fwAppendTag(current, tag) {
    const text = String(current || '').trim();
    const item = String(tag || '').trim();
    if (!item) return text;
    if (text.includes(item)) return text;
    return text ? `${text}；${item}` : item;
}

/** 启发后续大纲：一次给三条走向不同的路线（主线 / 感情 / 张力） */
export const FW_OUTLINE_SYSTEM_PROMPT = [
    '你是长篇小说编剧，负责在作者卡文时给出几条可选的后续走向。',
    '请依据给出的「本书设定与记忆」和「已经写到的正文」，给出 3 条走向明显不同的大纲：',
    '1. 主线型：紧凑推动剧情冲突，接上原著的主线目标，让矛盾往前走一步。',
    '2. 感情型：偏向角色心理转变、关系升温或产生裂痕，冲突落在人物之间。',
    '3. 张力型：找一个合理的借口把场景导向封闭空间、私人独处或持续升温的对峙，写暧昧与张力。',
    '',
    '输出格式（严格照抄，除此之外不要写任何文字）：',
    '===大纲===',
    '[主线] 一行标题（不超过 15 字）',
    '梗概：80~150 字，写清谁做了什么、为什么、结果往哪走；结尾留一个可写的钩子。',
    '===大纲===',
    '[感情] 一行标题',
    '梗概：……',
    '===大纲===',
    '[张力] 一行标题',
    '梗概：……',
    '',
    '要求：不要重复已经写过的内容；不要写成评论或推荐语；不要解释你为什么这么写。',
].join('\n');

/** 大纲分隔符（与续写的「===分支===」分开，两种输出才不会互相串味） */
export const FW_OUTLINE_SEPARATOR = '===大纲===';

/**
 * 启发大纲的请求消息：设定与记忆 + 已写正文 + 任务。
 * @param {{assembled?:string, recentText?:string, count?:number}} [task]
 */
export function fwBuildOutlineMessages(task = {}) {
    const count = Math.max(1, Math.min(4, parseInt(task.count, 10) || 3));
    const parts = [];
    if (task.assembled) parts.push(`【本书设定与记忆】\n${String(task.assembled).trim()}`);
    if (task.recentText) parts.push(`【已经写到的正文（末尾）】\n${String(task.recentText).trim()}`);
    parts.push(`【任务】请给出 ${count} 条后续走向的大纲，按 system 里给的格式与分隔符输出。`);
    return [
        { role: 'system', content: FW_OUTLINE_SYSTEM_PROMPT },
        { role: 'user', content: parts.join('\n\n') },
    ];
}

/**
 * 解析模型返回的大纲：先按 `===大纲===` 切段，再取首行的 `[类型] 标题`，
 * 剩下的一律当梗概（模型多写一行「梗概：」也一起吃掉）。
 * 模型不按格式来时退化成「整段当一条」，不让面板因为格式跑偏就空白。
 * @param {string} raw
 * @param {number} [limit] 最多返回几条
 */
export function fwParseOutlines(raw, limit = 4) {
    const text = String(raw || '').trim();
    if (!text) return [];
    const max = Math.max(1, parseInt(limit, 10) || 4);
    const chunks = text.includes(FW_OUTLINE_SEPARATOR)
        ? text.split(FW_OUTLINE_SEPARATOR)
        : text.split(/={2,}\s*大纲\s*={2,}/);

    const items = [];
    for (const chunk of chunks) {
        const lines = String(chunk).split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) continue;
        const head = lines[0].match(/^[\[【（(]\s*([^\]】）)]{1,8})\s*[\]】）)]\s*(.*)$/);
        const kind = head ? head[1].trim() : '走向';
        const title = String(head ? head[2] : lines[0]).trim() || `走向 ${items.length + 1}`;
        const body = lines.slice(1).join('\n').replace(/^梗概[:：]\s*/, '').trim();
        items.push({ kind, title, body, text: [title, body].filter(Boolean).join('\n') });
        if (items.length >= max) break;
    }
    return items;
}

