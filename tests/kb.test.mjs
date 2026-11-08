/**
 * lib/kb.js 的单元测试：建书 → 导入 → 解析清洗结果 → 合并 → 统计 → 分层总结。
 * 覆盖「知识库不会因为模型少写字段 / 重洗同一段而炸掉」这几条底线。
 */
import { group, ok, eq, truthy, finish } from './_assert.mjs';
import { pluginUrl } from './_paths.mjs';

const {
    fwCreateStory,
    fwIngestText,
    fwFindChapterIdx,
    fwExtractJson,
    fwParseCleanResult,
    fwMergeCleanResult,
    fwUpsertForeshadow,
    fwAddNode,
    fwBuildSummaryBlock,
    fwSelectSummariesToMerge,
    fwGetStageNodes,
    fwGetCurrentNode,
    fwStoryStats,
} = await import(pluginUrl('lib/kb.js'));

group('A. 建书与导入', () => {
    const story = fwCreateStory({ title: '测试之书' });
    eq('A1 初始书没有分段', story.chunks.length, 0);
    truthy('A2 有稳定 id', story.id.startsWith('story_'));

    const text = '第一章 开端\n他走进山门。\n第二章 风雪\n雪落在剑上。';
    fwIngestText(story, text, { chunkSize: 2000 });
    eq('A3 记录总字数', story.source.totalChars, text.length);
    eq('A4 识别 2 章', story.source.chapters.length, 2);
    eq('A5 少于 chunkSize 只切 1 段', story.chunks.length, 1);
    eq('A6 分段带原文', story.chunks[0].text.length, text.length);
    eq('A7 分段未清洗', story.chunks[0].done, false);

    const multi = fwCreateStory({ title: '长书' });
    fwIngestText(multi, '他推开门。屋里很暗。'.repeat(400), { chunkSize: 2000 });
    truthy('A8 长书切出多段', multi.chunks.length > 1);
    ok('A9 每段都归到某一章', multi.chunks.every(c => c.chapterIdx >= 1));
    eq('A10 偏移归属查询', fwFindChapterIdx([{ idx: 1, start: 0, end: 10 }, { idx: 2, start: 10, end: 20 }], 15), 2);
    eq('A11 新书的草稿是空串', story.draft, '');
});

group('B. JSON 抠取', () => {
    eq('B1 纯 JSON', fwExtractJson('{"a":1}').a, 1);
    eq('B2 带围栏', fwExtractJson('```json\n{"a":2}\n```').a, 2);
    eq('B3 前后有废话', fwExtractJson('好的，结果如下：{"a":3} 希望有帮助').a, 3);
    eq('B4 容忍尾逗号', fwExtractJson('{"a":4,}').a, 4);
    eq('B5 无法解析返回 null', fwExtractJson('完全不是 JSON'), null);
    eq('B6 空输入返回 null', fwExtractJson(''), null);
});

group('C. 清洗结果解析', () => {
    const raw = '```json\n' + JSON.stringify({
        compressed: '压缩正文',
        nodes: [
            { title: '入门', body: '主角拜入青云宗', lane: 'main', foreshadow: ['玉佩来历不明'], chars: ['林昭'] },
            { title: '夜谈', body: '与师姐夜谈', lane: 'sub' },
            { body: '' },
        ],
        chars: [
            { name: '林昭', aliases: ['小昭'], identity: '外门弟子', relations: ['师姐：苏晴'] },
            { identity: '没有名字' },
        ],
        world: [{ category: 'place', label: '青云宗', content: '正道第一大派', keywords: ['青云', '山门'] }],
    }) + '\n```';

    const parsed = fwParseCleanResult(raw);
    eq('C1 压缩正文', parsed.compressed, '压缩正文');
    eq('C2 节点过滤掉空节点', parsed.nodes.length, 2);
    eq('C3 默认 lane 补 main', parsed.nodes[0].lane, 'main');
    eq('C4 泳道保留 sub', parsed.nodes[1].lane, 'sub');
    eq('C5 角色过滤掉没名字的', parsed.chars.length, 1);
    eq('C6 别名解析', parsed.chars[0].aliases, ['小昭']);
    eq('C7 世界设定关键字', parsed.world[0].keywords.length, 2);

    const messy = fwParseCleanResult('模型什么都没按格式写');
    eq('C8 无 JSON 时不抛错，返回空结构', [messy.nodes.length, messy.chars.length, messy.world.length], [0, 0, 0]);
});

group('D. 合并清洗结果', () => {
    const story = fwCreateStory({ title: '合并测试' });
    fwIngestText(story, '第一章 开端\n他走进山门。', { chunkSize: 2000 });

    const parsed = {
        compressed: '压缩一',
        nodes: [
            { title: '入门', body: '拜入青云宗', lane: 'main', foreshadow: ['玉佩'], chars: ['林昭'], events: [], time: '', location: '' },
        ],
        chars: [{ name: '林昭', aliases: ['小昭'], identity: '外门弟子', appearance: '', personality: '沉稳', relations: [], exitStage: 0 }],
        world: [{ category: 'place', label: '青云宗', content: '正道第一大派', keywords: ['青云'] }],
    };

    const r1 = fwMergeCleanResult(story, 1, parsed);
    eq('D1 新增 1 节点', r1.addedNodes, 1);
    eq('D2 新增 1 角色', r1.addedChars, 1);
    eq('D3 分段标记完成', story.chunks[0].done, true);
    eq('D4 分段存压缩正文', story.chunks[0].clean, '压缩一');
    eq('D5 节点挂到分段上', story.chunks[0].nodeIds.length, 1);
    eq('D6 伏笔自动登记', story.memory.foreshadows.length, 1);
    eq('D7 伏笔状态 planned', story.memory.foreshadows[0].status, 'planned');

    // 重洗同一段：节点不能重复堆积，角色/设定要合并
    const parsed2 = {
        compressed: '压缩一（新）',
        nodes: [{ title: '入门·改', body: '拜入青云宗（补）', lane: 'main', foreshadow: [], chars: [], events: [], time: '', location: '' }],
        chars: [{ name: '林昭', aliases: ['昭哥'], identity: '', appearance: '', personality: '', relations: ['师姐：苏晴'], exitStage: 0 }],
        world: [{ category: 'place', label: '青云宗', content: '正道第一大派（补）', keywords: ['山门'] }],
    };
    fwMergeCleanResult(story, 1, parsed2);
    eq('D8 重洗后节点仍只 1 个', story.nodes.length, 1);
    eq('D9 重洗后节点内容更新', story.nodes[0].title, '入门·改');
    eq('D10 角色不重复', story.chars.length, 1);
    eq('D11 别名取并集', story.chars[0].aliases.sort(), ['小昭', '昭哥'].sort());
    eq('D12 关系取并集', story.chars[0].relations, ['师姐：苏晴']);
    eq('D13 世界设定不重复', story.world.length, 1);
    eq('D14 关键词取并集', story.world[0].keywords.sort(), ['山门', '青云'].sort());
    eq('D15 压缩正文被新结果覆盖', story.chunks[0].clean, '压缩一（新）');
});

group('E. 伏笔与分层总结', () => {
    const story = fwCreateStory({ title: '伏笔' });
    fwUpsertForeshadow(story, '玉佩的真实来历');
    fwUpsertForeshadow(story, '玉佩的真实来历', { status: 'planted', stageIdx: 2 });
    eq('E1 同名伏笔不重复', story.memory.foreshadows.length, 1);
    eq('E2 状态可更新', story.memory.foreshadows[0].status, 'planted');
    eq('E3 阶段可更新', story.memory.foreshadows[0].stageIdx, 2);
    eq('E4 空文本不登记', fwUpsertForeshadow(story, '   '), null);

    const memory = {
        summaries: [
            { level: 'major', start: 0, end: 5000, text: '大总结一' },
            { level: 'small', start: 5000, end: 6000, text: '小总结一' },
            { level: 'small', start: 6000, end: 7000, text: '小总结二' },
        ],
    };
    const block = fwBuildSummaryBlock(memory, { keepRecent: 1 });
    truthy('E5 大总结出现在注入块', block.includes('【长期大总结】') && block.includes('大总结一'));
    truthy('E6 只带最近 1 条小总结', block.includes('小总结二') && !block.includes('小总结一'));
    eq('E7 空记忆返回空串', fwBuildSummaryBlock({ summaries: [] }), '');
    eq('E8 没有记忆对象也不抛错', fwBuildSummaryBlock(null), '');

    const smalls = Array.from({ length: 9 }, (_, i) => ({ level: 'small', start: i * 100, end: (i + 1) * 100, text: `s${i}` }));
    const picked = fwSelectSummariesToMerge({ summaries: smalls }, { mergeCount: 8, keepRecent: 3 });
    // 上游口径：mergeLength = max(mergeCount, 总条数 - 保留条数) = max(8, 6) = 8
    eq('E9 9 条小总结 → 挑 8 条去合并（至少 mergeCount 条）', picked.length, 8);
    eq('E10 条数不足不合并', fwSelectSummariesToMerge({ summaries: smalls.slice(0, 5) }, { mergeCount: 8 }).length, 0);
    eq('E11 空记忆不合并', fwSelectSummariesToMerge({}, {}).length, 0);
    eq('E12 大总结不参与再次合并', fwSelectSummariesToMerge({
        summaries: [...smalls, { level: 'major', start: 0, end: 900, text: '大' }],
    }, { mergeCount: 8, keepRecent: 3 }).length, 8);
});

group('F. 阶段查询与统计', () => {
    const story = fwCreateStory({ title: '阶段' });
    fwIngestText(story, '第一章 开端\n他走进山门。', { chunkSize: 2000 });
    fwMergeCleanResult(story, 1, {
        compressed: '',
        nodes: [
            { title: 'A', body: 'a', lane: 'main', foreshadow: [], chars: [], events: [], time: '', location: '' },
            { title: 'B', body: 'b', lane: 'main', foreshadow: [], chars: [], events: [], time: '', location: '' },
        ],
        chars: [],
        world: [],
    });

    eq('F1 阶段 1 有 2 个节点', fwGetStageNodes(story, 1).length, 2);
    eq('F2 不存在的阶段返回空', fwGetStageNodes(story, 9).length, 0);

    const before = fwGetCurrentNode(story);
    eq('F3 未开始时当前节点为空', before.node, null);
    eq('F4 未开始时 next 是第一个节点', before.next?.title, 'A');

    story.progress = { stageIdx: 1, nodeIdx: 0 };
    eq('F5 推进后可取当前节点', fwGetCurrentNode(story).node?.title, 'A');
    eq('F6 next 是下一个节点', fwGetCurrentNode(story).next?.title, 'B');

    story.nodes[1].blocked = true;
    eq('F7 被屏蔽的节点不参与', fwGetStageNodes(story, 1).length, 1);

    const stats = fwStoryStats(story);
    eq('F8 统计节点数', stats.nodes, 2);
    eq('F9 统计分段进度', [stats.chunks, stats.chunksDone], [1, 1]);
    eq('F10 统计进度阶段', stats.progress, 1);
});

group('G. 手工新增节点（采纳大纲用）', () => {
    const story = fwCreateStory({ title: '大纲书' });
    fwIngestText(story, '第一章 开端\n他走进山门。', { chunkSize: 2000 });
    fwMergeCleanResult(story, 1, { compressed: '', nodes: [{ title: '入门', body: '拜入青云宗' }], chars: [], world: [] });
    story.progress = { stageIdx: 2, nodeIdx: 0 };

    const node = fwAddNode(story, { title: '雨夜避雨', body: '两人被雨困在旧宅柴房' });
    eq('G1 节点进库', story.nodes.length, 2);
    eq('G2 挂到当前阶段', node.stageIdx, 2);
    eq('G3 借用最后一段的 chunkIdx（只用于排序）', node.chunkIdx, 1);
    eq('G4 默认是主线', node.lane, 'main');
    eq('G5 记下来源', node.source, 'manual');
    ok('G6 有稳定 id', String(node.id).startsWith('node_'));
    eq('G7 新阶段里能看到它', fwGetStageNodes(story, 2).map(n => n.title), ['雨夜避雨']);
    eq('G8 空内容不建节点', fwAddNode(story, { title: '  ', body: '' }), null);
    eq('G9 空内容没污染节点表', story.nodes.length, 2);
    eq('G10 统计跟着涨', fwStoryStats(story).nodes, 2);
    eq('G11 可以显式指定来源', fwAddNode(story, { title: '来自大纲', body: 'x', source: 'outline' }).source, 'outline');
    eq('G12 没有书时安全返回', fwAddNode(null, { title: 'x' }), null);
});

finish('kb.test.mjs');
