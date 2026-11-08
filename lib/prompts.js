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
