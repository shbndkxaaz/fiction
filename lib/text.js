/**
 * 续写工坊 · 文本层（纯函数，不依赖酒馆运行时）
 *
 * 设计来源：
 * - 分段/句界截断来自 xu-xie-ji 的 `splitTextBySize` / `findSafeChapterCutPosition`
 *   （它的 README 反复强调「不能在半句话切断」，这里做成通用工具）
 * - Token 估算比 1 字 ≈ 0.667 token（CHARS_PER_TOKEN = 1.5）沿用 novel-injector 的
 *   `NI_RAW_INJECTION_CHARS_PER_TOKEN`，两边预算口径必须一致，否则面板数字会打架。
 */

/** 1 token 约等于多少字符（中文小说经验值） */
export const FW_CHARS_PER_TOKEN = 1.5;

/** 句子结束符：这些字符之后切开算「完整句尾」 */
const SENTENCE_END_RE = /[。！？!?…；;”"』」】）\)]$/;

/**
 * 估算 token 数。空文本返回 0，避免面板显示 0/NaN 之类的怪值。
 * @param {string} text
 * @param {number} [charsPerToken]
 */
export function fwEstimateTokens(text, charsPerToken = FW_CHARS_PER_TOKEN) {
    const ratio = Number(charsPerToken) > 0 ? Number(charsPerToken) : FW_CHARS_PER_TOKEN;
    const len = String(text ?? '').length;
    return len ? Math.ceil(len / ratio) : 0;
}

/**
 * token 预算换算成字符预算（注入时真正比较的是字符数）。
 * @param {number} maxTokens
 * @param {number} [charsPerToken]
 */
export function fwCharBudget(maxTokens, charsPerToken = FW_CHARS_PER_TOKEN) {
    const ratio = Number(charsPerToken) > 0 ? Number(charsPerToken) : FW_CHARS_PER_TOKEN;
    const tokens = Math.max(0, parseInt(maxTokens, 10) || 0);
    return Math.floor(tokens * ratio);
}

/**
 * 规整文本：统一换行、去零宽字符、压掉 3 个以上连续空行。
 * 导入 TXT 时先过一遍，后续所有偏移量（start/end）才稳定。
 * @param {string} text
 */
export function fwNormalizeText(text) {
    return String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** 章节标题行：第X章 / 第X回 / 序章 / 楔子 / 尾声 / 番外 / Chapter N（标题取整行） */
const CHAPTER_NUM_RE = /^[ \t\u3000]{0,6}第[0-9０-９零〇○一二三四五六七八九十百千万两]{1,10}[章节回卷篇幕][^\n]{0,40}$/gm;
/** 「引子」这类词后面必须跟分隔符或直接换行，否则正文首句会被误判成章节名 */
const CHAPTER_WORD_RE = /^[ \t\u3000]{0,6}(?:序[章幕]|楔子|引子|尾声|后记|终章|番外|Chapter[ \t]+[0-9IVXLCivxlc]+)(?:[ \t\u3000:：·\-—]+[^\n]{0,40}|[ \t\u3000]*)$/gm;

/**
 * 识别章节。找不到任何标题时，整篇算一章（不抛错，导入体验优先）。
 * 标题取**整行**（"第一章 起点" 而不是 "第一章"），因为章节名本身对后续摘要/定位有用。
 * @param {string} text 已 fwNormalizeText 的正文
 * @returns {{idx:number,title:string,start:number,end:number,chars:number}[]}
 */
export function fwDetectChapters(text) {
    const source = String(text ?? '');
    if (!source.trim()) return [];

    const marks = [];
    const collect = re => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(source)) !== null) {
            const title = m[0].trim();
            if (title) marks.push({ start: m.index, title });
            if (m.index === re.lastIndex) re.lastIndex += 1;
        }
    };
    collect(CHAPTER_NUM_RE);
    collect(CHAPTER_WORD_RE);
    marks.sort((a, b) => a.start - b.start);

    // 同一行被两个正则同时命中时去重
    const unique = marks.filter((mark, i) => i === 0 || mark.start !== marks[i - 1].start);

    if (!unique.length) {
        return [{ idx: 1, title: '全文', start: 0, end: source.length, chars: source.length }];
    }

    // 第一个标题之前若有正文，单独算「前言」一章，避免正文被吞掉
    const chapters = [];
    if (unique[0].start > 0 && source.slice(0, unique[0].start).trim()) {
        chapters.push({ idx: 1, title: '前言', start: 0, end: unique[0].start });
    }
    unique.forEach((mark, i) => {
        const end = i + 1 < unique.length ? unique[i + 1].start : source.length;
        chapters.push({ idx: chapters.length + 1, title: mark.title || `第${chapters.length + 1}章`, start: mark.start, end });
    });

    return chapters.map(c => ({ ...c, chars: c.end - c.start }));
}

/**
 * 从 `from` 开始向前找一个「安全切点」，绝不切在句子中间。
 * 优先句末标点 → 段落换行 → 逗号 → 硬切（soft=false 表示没找到好切点）。
 * @param {string} text
 * @param {number} from 期望切点
 * @param {number} [minPos] 回退下限
 * @returns {{pos:number, soft:boolean}}
 */
export function fwFindSafeCut(text, from, minPos = 0) {
    const source = String(text ?? '');
    const limit = Math.min(Math.max(0, from | 0), source.length);
    const floor = Math.max(0, Math.min(minPos | 0, limit));
    // 只回看 200 字，太远不如硬切（否则一段会被无限拉长）
    const windowStart = Math.max(floor, limit - 200);

    for (let i = limit; i > windowStart; i--) {
        if (SENTENCE_END_RE.test(source[i - 1] || '')) return { pos: i, soft: true };
    }
    for (let i = limit; i > windowStart; i--) {
        if ((source[i - 1] || '') === '\n') return { pos: i, soft: true };
    }
    for (let i = limit; i > windowStart; i--) {
        const ch = source[i - 1] || '';
        if (ch === '，' || ch === ',' || ch === '、') return { pos: i, soft: true };
    }
    return { pos: limit, soft: false };
}

/**
 * 按目标字数切段。返回每段的字符区间，便于「原文偏移 ↔ 总结 start/end」对齐。
 * 这是清洗分段的底座：novel-injector 按 100KB 切，续写鸡按 6000 字切章，
 * 合并后用同一套函数，只是 size 不同。
 * @param {string} text
 * @param {number} size 每段目标字符数
 * @returns {{idx:number,start:number,end:number,chars:number,soft:boolean}[]}
 */
export function fwSplitBySize(text, size) {
    const source = String(text ?? '');
    const target = Math.max(200, parseInt(size, 10) || 200);
    const segments = [];
    let cursor = 0;

    while (cursor < source.length) {
        const desired = cursor + target;
        if (desired >= source.length) {
            segments.push({ idx: segments.length + 1, start: cursor, end: source.length, soft: true });
            break;
        }
        const cut = fwFindSafeCut(source, desired, cursor + Math.floor(target * 0.6));
        const end = cut.pos > cursor ? cut.pos : desired;
        segments.push({ idx: segments.length + 1, start: cursor, end, soft: cut.soft });
        cursor = end;
    }

    return segments.map(s => ({ ...s, chars: s.end - s.start }));
}

/**
 * 在不超过 maxChars 的前提下尽量多留文本，超了就在边界处截断并加标记。
 * @param {string} text
 * @param {number} maxChars
 * @param {string} [marker]
 * @returns {{text:string, truncated:boolean}}
 */
export function fwCutAtBoundary(text, maxChars, marker = '……（已截断）') {
    const source = String(text ?? '');
    const limit = Math.max(0, parseInt(maxChars, 10) || 0);
    if (source.length <= limit) return { text: source, truncated: false };
    if (limit <= marker.length) return { text: source.slice(0, limit), truncated: true };
    const cut = fwFindSafeCut(source, limit - marker.length, Math.floor(limit / 2));
    const pos = Math.max(0, Math.min(cut.pos, limit - marker.length));
    return { text: source.slice(0, pos) + marker, truncated: true };
}

/**
 * 取尾部 N 字，且尽量从完整句子开头开始（给「前段参考」用）。
 * @param {string} text
 * @param {number} n
 */
export function fwTakeTail(text, n) {
    const source = String(text ?? '');
    const want = Math.max(0, parseInt(n, 10) || 0);
    if (!want || source.length <= want) return source;
    const start = source.length - want;
    const next = source.slice(start).search(/[。！？!?\n]/);
    return next >= 0 ? source.slice(start + next + 1).trim() : source.slice(start);
}

/** 关键词切分（世界设定按需触发用；学 xu-xie-ji 的 splitWorldBookKeywords） */
export function fwSplitKeywords(raw) {
    return String(raw ?? '')
        .split(/[,，、;；\s/|]+/)
        .map(s => s.trim())
        .filter(s => s.length >= 1)
        .slice(0, 40);
}

/**
 * 关键词命中判定：contextText 里出现过任一关键词即算命中。
 * 空关键词表返回 true（没有关键词 = 始终注入），与 xu-xie-ji 行为一致。
 * @param {string[]} keywords
 * @param {string} contextText
 */
export function fwMatchesKeywords(keywords, contextText) {
    const list = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
    if (!list.length) return true;
    const haystack = String(contextText ?? '');
    if (!haystack) return false;
    return list.some(k => haystack.includes(k));
}
