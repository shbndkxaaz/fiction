/**
 * 续写工坊 · 知识库（书级数据模型 + 纯函数）
 *
 * 数据模型对应 docs/03-merged-architecture.md 第 4 节：
 *   story = { source, chunks, nodes, chars, world, stages, style, memory, progress, inject }
 *
 * 原则：
 * - 这里**只做纯计算**，不读写 localStorage、不调 API（那两件事在 store.js / clean-api.js）。
 * - 清洗结果的解析学 novel-injector：宽松取 JSON（模型常带 ```json 围栏或前后废话）。
 * - 分层总结学 xu-xie-ji：小总结带 start/end 偏移，攒够条数合并成大总结。
 */

import { fwNormalizeText, fwDetectChapters, fwSplitBySize } from './text.js';

export const FW_STORY_VERSION = 1;

/** 生成稳定 id（不依赖 crypto，Node/浏览器都能跑） */
export function fwNewId(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 新建一本空的「书」。
 * @param {{title?:string, fileName?:string, id?:string}} [init]
 */
export function fwCreateStory(init = {}) {
    const now = Date.now();
    return {
        version: FW_STORY_VERSION,
        id: init.id || fwNewId('story'),
        title: String(init.title || '未命名小说'),
        fileName: String(init.fileName || ''),
        createdAt: now,
        updatedAt: now,
        source: { totalChars: 0, chapters: [] },
        chunks: [],
        nodes: [],
        chars: [],
        world: [],
        stages: [],
        style: { name: '', guide: '' },
        memory: { summaries: [], foreshadows: [] },
        progress: { stageIdx: 0, nodeIdx: -1, updatedAt: now },
        /** 编辑器里的续写草稿（跟书走，自动保存；见 index.js persistDraft） */
        draft: '',
        inject: {},
    };
}

/**
 * 导入原文：规整 → 识别章节 → 按 chunkSize 切段（默认 60KB，可调）。
 * 重复导入会整体替换（v1 不做「追加章节」，那是 M1 之后的事）。
 * @param {object} story
 * @param {string} rawText
 * @param {{chunkSize?:number}} [opts]
 */
export function fwIngestText(story, rawText, opts = {}) {
    const text = fwNormalizeText(rawText);
    const chunkSize = Math.max(2000, parseInt(opts.chunkSize, 10) || 60000);
    const chapters = fwDetectChapters(text);
    const segments = fwSplitBySize(text, chunkSize);

    story.source = { totalChars: text.length, chapters };
    story.chunks = segments.map(seg => ({
        idx: seg.idx,
        start: seg.start,
        end: seg.end,
        chars: seg.chars,
        chapterIdx: fwFindChapterIdx(chapters, seg.start),
        text: text.slice(seg.start, seg.end),
        clean: '',
        done: false,
        nodeIds: [],
        error: '',
    }));
    story.nodes = [];
    story.chars = [];
    story.world = [];
    story.stages = [];
    story.memory = { summaries: [], foreshadows: [] };
    story.progress = { stageIdx: 0, nodeIdx: -1, updatedAt: Date.now() };
    story.updatedAt = Date.now();
    return story;
}

/** 某个字符偏移属于第几章 */
export function fwFindChapterIdx(chapters, offset) {
    const list = Array.isArray(chapters) ? chapters : [];
    const hit = list.find(c => offset >= c.start && offset < c.end);
    return hit ? hit.idx : (list.length ? list[list.length - 1].idx : 1);
}

/**
 * 从模型回复里抠出 JSON（容忍 ```json 围栏、前后说明文字、尾逗号）。
 * @param {string} rawText
 * @returns {object|null}
 */
export function fwExtractJson(rawText) {
    const raw = String(rawText ?? '').trim();
    if (!raw) return null;

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1].trim() : raw;

    const start = body.search(/[[{]/);
    if (start < 0) return null;
    const open = body[start];
    const close = open === '{' ? '}' : ']';
    const end = body.lastIndexOf(close);
    if (end <= start) return null;

    const slice = body.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
    try {
        return JSON.parse(slice);
    } catch {
        return null;
    }
}

/**
 * 解析一次清洗结果。字段名对齐 novel-injector 的清洗 schema：
 *   { compressed, nodes:[{title,body,lane,time,location,events,foreshadow,chars}], chars:[...], world:[...] }
 * 任何字段缺失都退回空数组 —— 清洗是「尽力而为」，不能因为模型少写一个键就整段丢。
 * @param {string} rawText
 */
export function fwParseCleanResult(rawText) {
    const data = fwExtractJson(rawText) || {};
    const pickArray = v => (Array.isArray(v) ? v : []);
    return {
        compressed: String(data.compressed || data.clean || data.summary || '').trim(),
        nodes: pickArray(data.nodes || data.plots).map(n => ({
            title: String(n?.title || '').trim(),
            body: String(n?.body || n?.desc || n?.description || '').trim(),
            lane: ['main', 'sub', 'pivot'].includes(n?.lane) ? n.lane : 'main',
            time: String(n?.time || '').trim(),
            location: String(n?.location || '').trim(),
            events: pickArray(n?.events || n?.sub_notes).map(String),
            foreshadow: pickArray(n?.foreshadow || n?.foreshadows).map(String),
            chars: pickArray(n?.chars || n?.characters).map(String),
        })).filter(n => n.title || n.body),
        chars: pickArray(data.chars || data.characters).map(c => ({
            name: String(c?.name || '').trim(),
            aliases: pickArray(c?.aliases).map(String),
            identity: String(c?.identity || c?.role || '').trim(),
            appearance: String(c?.appearance || '').trim(),
            personality: String(c?.personality || '').trim(),
            relations: pickArray(c?.relations).map(r => typeof r === 'string' ? r : String(r?.text || '')),
            exitStage: Number(c?.exitStage) || 0,
        })).filter(c => c.name),
        world: pickArray(data.world).map(w => ({
            category: String(w?.category || 'world').trim(),
            label: String(w?.label || w?.title || '').trim(),
            content: String(w?.content || w?.desc || '').trim(),
            keywords: pickArray(w?.keywords).map(String),
        })).filter(w => w.label || w.content),
    };
}

/**
 * 把一次清洗结果合并进知识库：
 * - 节点按「chunkIdx + 顺序」生成稳定 id，重洗同一 chunk 时先清掉旧节点
 * - 角色按名字去重合并（别名取并集），与 novel-injector 的 char-canon 思路一致
 * - 世界设定按 label 去重
 * @param {object} story
 * @param {number} chunkIdx
 * @param {{compressed:string,nodes:any[],chars:any[],world:any[]}} parsed
 */
export function fwMergeCleanResult(story, chunkIdx, parsed) {
    const chunk = (story.chunks || []).find(c => c.idx === chunkIdx);
    if (!chunk) return { addedNodes: 0, addedChars: 0, addedWorld: 0 };
    if (!story.memory) story.memory = { summaries: [], foreshadows: [] };

    // 1) 节点：重洗时先摘掉这个 chunk 的旧节点
    const oldIds = new Set(chunk.nodeIds || []);
    story.nodes = (story.nodes || []).filter(n => !oldIds.has(n.id));

    const newNodes = (parsed.nodes || []).map((node, i) => ({
        id: `${story.id}_c${chunkIdx}_n${i + 1}`,
        chunkIdx,
        chapterIdx: chunk.chapterIdx,
        stageIdx: 1,
        lane: node.lane || 'main',
        title: node.title || `节点 ${i + 1}`,
        body: node.body || '',
        events: node.events || [],
        foreshadow: node.foreshadow || [],
        chars: node.chars || [],
        time: node.time || '',
        location: node.location || '',
        blocked: false,
    }));
    story.nodes.push(...newNodes);
    chunk.nodeIds = newNodes.map(n => n.id);
    chunk.clean = parsed.compressed || chunk.clean || '';
    chunk.done = true;
    chunk.error = '';

    // 2) 角色：同名合并，别名取并集
    let addedChars = 0;
    (parsed.chars || []).forEach(incoming => {
        const exist = (story.chars || []).find(c => c.name === incoming.name);
        if (!exist) {
            story.chars.push({ id: fwNewId('char'), enabled: true, ...incoming });
            addedChars += 1;
            return;
        }
        exist.aliases = [...new Set([...(exist.aliases || []), ...(incoming.aliases || [])])];
        exist.identity = exist.identity || incoming.identity;
        exist.appearance = exist.appearance || incoming.appearance;
        exist.personality = exist.personality || incoming.personality;
        exist.relations = [...new Set([...(exist.relations || []), ...(incoming.relations || [])])];
        exist.exitStage = exist.exitStage || incoming.exitStage || 0;
    });

    // 3) 世界设定：同 label 覆盖（后洗的更完整）
    let addedWorld = 0;
    (parsed.world || []).forEach(incoming => {
        const exist = (story.world || []).find(w => w.label && w.label === incoming.label);
        if (exist) {
            exist.content = incoming.content || exist.content;
            exist.keywords = [...new Set([...(exist.keywords || []), ...(incoming.keywords || [])])];
            return;
        }
        story.world.push({ id: fwNewId('world'), enabled: true, ...incoming });
        addedWorld += 1;
    });

    // 4) 伏笔：节点里带出来的先登记成 planned，交后续章节流转
    (parsed.nodes || []).forEach(node => {
        (node.foreshadow || []).forEach(text => fwUpsertForeshadow(story, text, { stageIdx: 1 }));
    });

    story.updatedAt = Date.now();
    return { addedNodes: newNodes.length, addedChars, addedWorld };
}

/**
 * 手工 / 「采纳大纲」新增一个节点（挂到指定阶段，排在原阶段节点之后）。
 *
 * 刻意不做去重：用户点两次就是想要两个节点，脚本不替人猜。
 * 也不动 chunks —— 这个节点没有对应原文，chunkIdx 借用最后一段，只用于排序。
 * @param {object} story
 * @param {{title?:string, body?:string, stageIdx?:number, lane?:string, source?:string}} [input]
 * @returns {object|null}
 */
export function fwAddNode(story, input = {}) {
    if (!story) return null;
    const title = String(input.title || '').trim();
    const body = String(input.body || '').trim();
    if (!title && !body) return null;

    if (!Array.isArray(story.nodes)) story.nodes = [];
    const chunks = Array.isArray(story.chunks) ? story.chunks : [];
    const lastChunk = chunks[chunks.length - 1] || null;
    const stageIdx = Math.max(1, parseInt(input.stageIdx, 10) || Number(story.progress?.stageIdx) || 1);
    const chunkIdx = Number.isFinite(parseInt(input.chunkIdx, 10))
        ? parseInt(input.chunkIdx, 10)
        : Number(lastChunk?.idx) || 0;

    const node = {
        id: fwNewId('node'),
        chunkIdx,
        chapterIdx: Number(lastChunk?.idx) === chunkIdx ? (Number(lastChunk?.chapterIdx) || 0) : 0,
        stageIdx,
        lane: input.lane || 'main',
        title: title || `节点 ${story.nodes.length + 1}`,
        body,
        events: [],
        foreshadow: [],
        chars: [],
        time: '',
        location: '',
        blocked: false,
        source: input.source || 'manual',
    };
    story.nodes.push(node);
    story.updatedAt = Date.now();
    return node;
}

/**
 * 登记 / 更新一条长期伏笔（xu-xie-ji 的 registerForeshadow 的纯函数版）。
 * @param {object} story
 * @param {string} text
 * @param {{stageIdx?:number, weight?:number, status?:string}} [opts]
 */
export function fwUpsertForeshadow(story, text, opts = {}) {
    const content = String(text ?? '').trim();
    if (!content) return null;
    if (!story.memory) story.memory = { summaries: [], foreshadows: [] };
    if (!Array.isArray(story.memory.foreshadows)) story.memory.foreshadows = [];

    const exist = story.memory.foreshadows.find(f => f.text === content);
    if (exist) {
        exist.weight = Number(opts.weight) || exist.weight;
        exist.stageIdx = Number(opts.stageIdx) || exist.stageIdx;
        if (opts.status) exist.status = opts.status;
        return exist;
    }
    const item = {
        id: fwNewId('fs'),
        text: content,
        weight: Number(opts.weight) || 1,
        stageIdx: Number(opts.stageIdx) || 0,
        status: opts.status || 'planned',
        createdAt: Date.now(),
    };
    story.memory.foreshadows.push(item);
    return item;
}

/** 分层总结的注入文本（学 xu-xie-ji 的 buildSummaryBlockFromState） */
export function fwBuildSummaryBlock(memory, opts = {}) {
    const state = memory || {};
    const keepRecent = Math.max(0, parseInt(opts.keepRecent, 10) || 0);
    const summaries = Array.isArray(state.summaries) ? state.summaries : [];
    const major = summaries.filter(s => s.level === 'major');
    const small = summaries.filter(s => s.level !== 'major');
    const recent = keepRecent > 0 ? small.slice(-keepRecent) : [];

    const parts = [];
    if (major.length) {
        parts.push('【长期大总结】');
        parts.push(major.map((s, i) => `【大总结${i + 1}｜原文${s.start}-${s.end}字】\n${s.text}`).join('\n\n'));
    }
    if (recent.length) {
        parts.push('【最近小总结】');
        parts.push(recent.map((s, i) => `【最近摘要${i + 1}｜原文${s.start}-${s.end}字】\n${s.text}`).join('\n\n'));
    }
    return parts.join('\n\n').trim();
}

/**
 * 挑出「该合并成大总结」的小总结（纯选择，不含 AI 调用）。
 * 与 xu-xie-ji 的 maybeMergeAutoSummaries 同一口径：攒够 mergeCount 条，
 * 只合并「除最近 keepRecent 条之外」的部分。
 * @param {object} memory
 * @param {{mergeCount?:number, keepRecent?:number}} [opts]
 */
export function fwSelectSummariesToMerge(memory, opts = {}) {
    const mergeCount = Math.max(3, parseInt(opts.mergeCount, 10) || 8);
    const keepRecent = Math.max(0, parseInt(opts.keepRecent, 10) || 3);
    const small = (Array.isArray(memory?.summaries) ? memory.summaries : []).filter(s => s.level !== 'major');
    if (small.length < mergeCount) return [];

    const mergeLength = Math.max(mergeCount, small.length - keepRecent);
    const picked = small.slice(0, mergeLength);
    return picked.length >= mergeCount ? picked : [];
}

/** 取某阶段的节点（按 chunk 顺序，也就是原文顺序） */
export function fwGetStageNodes(story, stageIdx) {
    const nodes = (story?.nodes || []).filter(n => Number(n.stageIdx) === Number(stageIdx) && !n.blocked);
    return nodes.sort((a, b) => (a.chunkIdx - b.chunkIdx) || String(a.id).localeCompare(String(b.id)));
}

/** 当前进度节点：progress.nodeIdx 是「该阶段内序号」，-1 表示还没开始 */
export function fwGetCurrentNode(story) {
    const stageIdx = Number(story?.progress?.stageIdx) || (story?.stages?.[0]?.idx ?? 1);
    const nodes = fwGetStageNodes(story, stageIdx);
    const idx = Number(story?.progress?.nodeIdx);
    if (!nodes.length) return { stageIdx, nodes, node: null, next: null };
    const cur = idx >= 0 && idx < nodes.length ? nodes[idx] : null;
    const nextIdx = (cur ? idx : -1) + 1;
    const next = nodes[Math.min(nodes.length - 1, nextIdx)] || null;
    return { stageIdx, nodes, node: cur, next };
}

/** 面板上显示的统计 */
export function fwStoryStats(story) {
    const chunks = story?.chunks || [];
    const summaries = story?.memory?.summaries || [];
    return {
        title: story?.title || '',
        totalChars: story?.source?.totalChars || 0,
        chapters: (story?.source?.chapters || []).length,
        chunks: chunks.length,
        chunksDone: chunks.filter(c => c.done).length,
        nodes: (story?.nodes || []).length,
        chars: (story?.chars || []).length,
        world: (story?.world || []).length,
        stages: (story?.stages || []).length,
        summaries: summaries.length,
        foreshadows: (story?.memory?.foreshadows || []).length,
        progress: story?.progress?.stageIdx || 0,
    };
}
