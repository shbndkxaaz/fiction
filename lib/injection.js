/**
 * 续写工坊 · 注入层（纯函数，不依赖酒馆运行时）
 *
 * 这一层是「合并」的核心：聊天注入管线与编辑器续写管线**共用同一份注入块**。
 * 设计来源：
 * - 预算裁剪 / 边界截断 / omitted 记录 —— novel-injector `lib/injection-system.js` 的
 *   `niBuildBoundedStageInjection`（它的 README 明确写了「预算才是真正的天花板」）
 * - 「主提示前/后要并进第一条 system，不能塞独立消息」—— novel-injector 踩过的坑
 * - 分层总结 / 长期伏笔 的文本块 —— xu-xie-ji `buildSummaryBlockFromState`
 */

import { fwCharBudget, fwEstimateTokens, fwCutAtBoundary, fwMatchesKeywords } from './text.js';
import { fwBuildSummaryBlock, fwGetStageNodes } from './kb.js';

/** 单轮注入默认预算（与 novel-injector 的 NI_RAW_INJECTION_MAX_TOKENS_DEFAULT 一致） */
export const FW_INJECTION_MAX_TOKENS_DEFAULT = 32000;

/** 注入位置：并进主提示（第一条 system）/ 聊天内按深度插 */
export const FW_INJECT_POSITION = { IN_PROMPT: 'in_prompt', IN_CHAT: 'in_chat' };

/**
 * 注入块的优先级（数字越小越先占预算）。
 * 顺序依据 novel-injector 的产品结论：当前阶段剧情最不能丢，文风最可以丢。
 */
export const FW_BLOCK_PRIORITY = {
    stage: 0,
    chars: 1,
    world: 2,
    summary: 3,
    foreshadow: 4,
    future: 5,
    style: 6,
};

/** 各类块的展示名（面板/预览用） */
const BLOCK_LABEL = {
    stage: '当前阶段剧情',
    chars: '角色人设',
    world: '世界设定',
    summary: '剧情记忆',
    foreshadow: '长期伏笔',
    future: '后续剧情',
    style: '文风',
};

/**
 * 把知识库编译成一组注入块。
 * @param {object} story
 * @param {{progress?:{stageIdx?:number,nodeIdx?:number}, settings?:object, contextText?:string}} [opts]
 * @returns {{key:string,label:string,priority:number,text:string,chars:number,tokens:number}[]}
 */
export function fwBuildInjectionBlocks(story, opts = {}) {
    const settings = opts.settings || {};
    const stageIdx = Number(opts.progress?.stageIdx) || Number(story?.progress?.stageIdx) || 1;
    const contextText = String(opts.contextText || '');
    const blocks = [];

    const push = (key, text) => {
        const body = String(text || '').trim();
        if (!body) return;
        blocks.push({
            key,
            label: BLOCK_LABEL[key] || key,
            priority: FW_BLOCK_PRIORITY[key] ?? 99,
            text: body,
            chars: body.length,
            tokens: fwEstimateTokens(body),
        });
    };

    // ① 当前阶段剧情（节点明细；节点为空的阶段退到 chunk 的 clean 摘要）
    const nodes = fwGetStageNodes(story, stageIdx);
    if (nodes.length) {
        push('stage', `【当前阶段剧情（第${stageIdx}阶段）】\n` + nodes.map((n, i) =>
            `${i + 1}. ${n.title}\n${n.body}`.trim()).join('\n'));
    }

    // ② 角色人设：退场阶段生效后不再注入（避免「已写死的人还在说话」）
    const chars = (story?.chars || [])
        .filter(c => c && c.enabled !== false && c.name)
        .filter(c => !(Number(c.exitStage) > 0 && stageIdx >= Number(c.exitStage)))
        .map(c => {
            const lines = [`姓名：${c.name}${c.aliases?.length ? `（别名：${c.aliases.join('、')}）` : ''}`];
            if (c.identity) lines.push(`身份：${c.identity}`);
            if (c.appearance) lines.push(`外貌：${c.appearance}`);
            if (c.personality) lines.push(`性格：${c.personality}`);
            if (c.relations?.length) lines.push(`关系：${c.relations.join('；')}`);
            return lines.join('\n');
        });
    push('chars', chars.length ? `【角色人设】\n${chars.join('\n---\n')}` : '');

    // ③ 世界设定：有关键词就按需触发，没关键词就常驻（学 xu-xie-ji）
    const world = (story?.world || [])
        .filter(w => w && w.enabled !== false && (w.label || w.content))
        .filter(w => fwMatchesKeywords(w.keywords || [], contextText))
        .map(w => `${w.label || w.category}：${w.content}`);
    push('world', world.length ? `【世界设定】\n${world.join('\n')}` : '');

    // ④ 剧情记忆（分层总结）
    push('summary', fwBuildSummaryBlock(story?.memory, { keepRecent: settings.summaryKeepRecent ?? 3 }));

    // ⑤ 长期伏笔（只发还没收线的）
    const foreshadows = (story?.memory?.foreshadows || [])
        .filter(f => f && f.status !== 'paid-off')
        .map(f => `- ${f.text}`);
    push('foreshadow', foreshadows.length ? `【长期伏笔（尚未揭晓，不要提前说破）】\n${foreshadows.join('\n')}` : '');

    // ⑥ 后续剧情（默认关闭；开了只给「下一个节点」，防剧透）
    if (settings.futureNodeEnabled === true) {
        const idx = Number(opts.progress?.nodeIdx);
        const next = nodes[idx >= 0 ? idx + 1 : 0] || null;
        if (next) {
            push('future', [
                '【后续剧情（尚未演到）】',
                `${next.title}：${next.body}`,
                '※ 只用来把握走向、提前埋伏笔，不要跳过当前剧情直接写，也不要让角色说出此刻还不该知道的细节。',
            ].join('\n'));
        }
    }

    // ⑦ 文风指南
    push('style', story?.style?.guide ? `【文风控制】\n${story.style.guide}` : '');

    return blocks;
}

/**
 * 按预算把注入块装配成一段文本。
 * 规则（对齐 novel-injector 的裁剪语义）：
 * 1. 按 priority 升序取块，先到的先占预算；
 * 2. 装不下就在**句子边界**截断并标记 truncated，之后不再追加更低优先级的块；
 * 3. 完全没位置可用的块进 omitted，调用方负责提示「这一轮丢了什么」。
 * @param {{key:string,label:string,text:string,priority?:number}[]} blocks
 * @param {{maxTokens?:number, charsPerToken?:number}} [opts]
 */
export function fwAssembleInjection(blocks, opts = {}) {
    // 注意：maxTokens=0 必须真的是 0（`0 || DEFAULT` 会把 0 变成默认值，这是首轮测试抓到的坑）
    const parsedMax = parseInt(opts.maxTokens, 10);
    const maxTokens = Number.isFinite(parsedMax) && parsedMax >= 0 && opts.maxTokens !== undefined && opts.maxTokens !== null && opts.maxTokens !== ''
        ? Math.max(0, parsedMax)
        : FW_INJECTION_MAX_TOKENS_DEFAULT;
    const charBudget = fwCharBudget(maxTokens);
    const list = (Array.isArray(blocks) ? blocks : [])
        .filter(b => b && String(b.text || '').trim())
        .slice()
        .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

    const used = [];
    const omitted = [];
    let usedChars = 0;
    let truncated = false;

    for (const block of list) {
        if (truncated || usedChars >= charBudget) {
            omitted.push(block.key);
            continue;
        }
        const remaining = charBudget - usedChars;
        const body = String(block.text).trim();
        const sep = used.length ? 2 : 0;

        if (body.length + sep <= remaining) {
            used.push({ key: block.key, text: body });
            usedChars += body.length + sep;
            continue;
        }

        const cut = fwCutAtBoundary(body, Math.max(0, remaining - sep));
        if (cut.text.trim()) {
            used.push({ key: block.key, text: cut.text.trim(), truncated: cut.truncated });
            usedChars += cut.text.trim().length + sep;
        } else {
            omitted.push(block.key);
        }
        truncated = true;
    }

    const text = used.map(u => u.text).join('\n\n');
    return {
        text,
        used,
        omitted,
        truncated,
        chars: text.length,
        tokens: fwEstimateTokens(text),
        maxTokens,
        charBudget,
    };
}

/**
 * 把注入文本塞进**请求消息数组**（`CHAT_COMPLETION_PROMPT_READY` 的 `eventData.chat`）。
 *
 * 为什么不直接塞一条独立 system 消息：novel-injector 的 README 明确踩过这个坑 ——
 * Claude / Gemini 适配器会合并或丢弃额外的 system，中转常把 messages[0] 当主提示词替换。
 * 所以 `in_prompt` 模式改为**并进第一条 system 的文本**（找不到就补一条）。
 *
 * @param {{role:string,content:string}[]} chat 直接就地修改
 * @param {{text:string, position?:string, depth?:number, atHead?:boolean}} opts
 * @returns {{inserted:boolean, mode:string, index:number}}
 */
export function fwInsertIntoChatMessages(chat, opts = {}) {
    const messages = Array.isArray(chat) ? chat : null;
    const text = String(opts.text || '').trim();
    if (!messages || !text) return { inserted: false, mode: 'none', index: -1 };

    const position = opts.position === FW_INJECT_POSITION.IN_CHAT
        ? FW_INJECT_POSITION.IN_CHAT
        : FW_INJECT_POSITION.IN_PROMPT;

    if (position === FW_INJECT_POSITION.IN_CHAT) {
        const depth = Math.max(0, parseInt(opts.depth, 10) || 0);
        // depth 0 = 紧贴对话末尾；越大越靠前
        const index = Math.max(0, messages.length - depth);
        messages.splice(index, 0, { role: 'system', content: text });
        return { inserted: true, mode: 'in_chat', index };
    }

    const sysIdx = messages.findIndex(m => m && m.role === 'system');
    if (sysIdx >= 0) {
        const prev = String(messages[sysIdx].content || '');
        const atHead = opts.atHead === true;
        messages[sysIdx].content = atHead || !prev ? `${text}${prev ? `\n\n${prev}` : ''}` : `${prev}\n\n${text}`;
        return { inserted: true, mode: 'in_prompt_merge', index: sysIdx };
    }
    messages.unshift({ role: 'system', content: text });
    return { inserted: true, mode: 'in_prompt_new', index: 0 };
}

/** 续写分支分隔符（xu-xie-ji 用相同思路；模型按此切分支） */
export const FW_BRANCH_SEPARATOR = '\n===分支===\n';

/**
 * 续写 prompt：把「注入块 + 已有正文 + 本次要求」拼成一次性生成的提示词。
 * 与聊天注入共用 blocks —— 这就是「两条管线同一份记忆」。
 * @param {{blocks?:any[], assembled?:string, beforeText?:string, instruction?:string,
 *          targetWords?:number, functionType?:'continuation'|'custom'}} opts
 */
export function fwBuildContinuationPrompt(opts = {}) {
    const assembled = String(opts.assembled ?? (opts.blocks ? fwAssembleInjection(opts.blocks).text : '')).trim();
    const beforeText = String(opts.beforeText || '').trim();
    const instruction = String(opts.instruction || '').trim();
    const targetWords = Math.max(50, parseInt(opts.targetWords, 10) || 800);
    const isCustom = opts.functionType === 'custom' || Boolean(instruction);

    const head = [
        '你是长篇小说续写助手。下面提供这本书的设定与记忆，请据此续写正文。',
        '执行规则：',
        '1. 只输出小说正文，不要解释、不要总结、不要标题、不要任何元评论。',
        '2. 不得改变已发生的事实、人物关系、称呼与世界观规则。',
        '3. 保持与已提供正文自然的衔接，不要重复已写过的内容。',
        '4. 伏笔可以铺垫，但不要提前揭晓还没到该揭晓的部分。',
    ].join('\n');

    const parts = [head];
    if (assembled) parts.push(`【本书设定与记忆】\n${assembled}`);
    if (beforeText) parts.push(`【已写正文（末尾）】\n${beforeText}`);
    if (isCustom && instruction) parts.push(`【本次续写要求】\n${instruction}`);
    parts.push(`【本次任务】从已写正文后续写约 ${targetWords} 字。`);

    return parts.join('\n\n').trim();
}

/**
 * 从模型返回里切出多个分支（按分隔符切；只有一个就返回一条）。
 * @param {string} raw
 * @param {number} [count] 期望分支数，超出的截掉
 */
export function fwParseBranches(raw, count = 3) {
    const text = String(raw || '').trim();
    if (!text) return [];
    const parts = text.includes('===分支===')
        ? text.split(/===分支===/).map(s => s.trim()).filter(Boolean)
        : [text];
    return parts.slice(0, Math.max(1, parseInt(count, 10) || 1));
}
