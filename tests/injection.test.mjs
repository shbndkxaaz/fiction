/**
 * lib/injection.js 的单元测试：注入块构造、预算裁剪、chat 数组合并、续写 prompt。
 * 这是「两条管线共用一份记忆」的关键层，任何回归都会直接让长篇跑偏。
 */
import { group, ok, eq, truthy, finish } from './_assert.mjs';
import { pluginUrl } from './_paths.mjs';

const {
    FW_INJECTION_MAX_TOKENS_DEFAULT,
    FW_INJECT_POSITION,
    fwBuildInjectionBlocks,
    fwAssembleInjection,
    fwInsertIntoChatMessages,
    fwBuildContinuationPrompt,
    fwParseBranches,
} = await import(pluginUrl('lib/injection.js'));
const { fwCreateStory, fwIngestText, fwMergeCleanResult, fwUpsertForeshadow } = await import(pluginUrl('lib/kb.js'));

/** 造一本有 2 个节点、1 角色、1 设定、1 伏笔、文风、总结的书 */
function makeStory() {
    const story = fwCreateStory({ title: '注入测试' });
    fwIngestText(story, '第一章 开端\n他走进山门。', { chunkSize: 2000 });
    fwMergeCleanResult(story, 1, {
        compressed: '压缩正文',
        nodes: [
            { title: '入门', body: '拜入青云宗', lane: 'main', foreshadow: ['玉佩'], chars: ['林昭'], events: [], time: '', location: '' },
            { title: '夜谈', body: '与师姐夜谈', lane: 'main', foreshadow: [], chars: [], events: [], time: '', location: '' },
        ],
        chars: [{ name: '林昭', aliases: ['小昭'], identity: '外门弟子', appearance: '', personality: '沉稳', relations: ['师姐：苏晴'], exitStage: 0 }],
        world: [{ category: 'place', label: '青云宗', content: '正道第一大派', keywords: ['青云'] }],
    });
    story.style = { name: '冷峻', guide: '句式短，克制情绪。' };
    story.memory.summaries = [{ level: 'small', start: 0, end: 100, text: '小总结一' }];
    fwUpsertForeshadow(story, '玉佩的真实来历');
    story.progress = { stageIdx: 1, nodeIdx: 0 };
    return story;
}

group('A. 注入块构造', () => {
    const story = makeStory();
    const blocks = fwBuildInjectionBlocks(story, { progress: story.progress, contextText: '青云宗的山门' });
    const keys = blocks.map(b => b.key);
    eq('A1 顺序按优先级排列', keys.slice(0, 4), ['stage', 'chars', 'world', 'summary']);
    truthy('A2 包含阶段剧情', keys.includes('stage'));
    truthy('A3 包含角色人设', keys.includes('chars'));
    truthy('A4 包含世界设定（关键词命中）', keys.includes('world'));
    truthy('A5 包含文风', keys.includes('style'));

    const stageBlock = blocks.find(b => b.key === 'stage');
    truthy('A6 阶段块带阶段号', stageBlock.text.includes('第1阶段'));
    truthy('A7 阶段块含节点标题', stageBlock.text.includes('入门') && stageBlock.text.includes('夜谈'));

    const charBlock = blocks.find(b => b.key === 'chars');
    truthy('A8 别名进了人设', charBlock.text.includes('小昭'));
    truthy('A9 关系进了人设', charBlock.text.includes('师姐：苏晴'));

    const fsBlock = blocks.find(b => b.key === 'foreshadow');
    truthy('A10 伏笔块存在', fsBlock && fsBlock.text.includes('玉佩的真实来历'));

    // 关键词未命中 → 世界设定不注入
    const noHit = fwBuildInjectionBlocks(story, { progress: story.progress, contextText: '他去了海边' });
    eq('A11 关键词未命中时不注入世界设定', noHit.some(b => b.key === 'world'), false);

    // 退场角色不再注入
    story.chars[0].exitStage = 1;
    const exited = fwBuildInjectionBlocks(story, { progress: story.progress, contextText: '青云' });
    eq('A12 退场阶段已到 → 不注入该角色', exited.some(b => b.key === 'chars'), false);
    story.chars[0].exitStage = 3;
    truthy('A13 退场阶段未到 → 仍然注入', fwBuildInjectionBlocks(story, { progress: { stageIdx: 1 }, contextText: '' }).some(b => b.key === 'chars'));

    // 后续剧情默认不发
    eq('A14 默认不注入后续剧情', fwBuildInjectionBlocks(story, { progress: story.progress }).some(b => b.key === 'future'), false);
    truthy('A15 开启后注入下一个节点', fwBuildInjectionBlocks(story, { progress: story.progress, settings: { futureNodeEnabled: true } })
        .find(b => b.key === 'future')?.text.includes('夜谈'));

    // 已收线的伏笔不再注入（合并节点时自动登记的「玉佩」也要一起收线）
    story.memory.foreshadows.forEach(f => { f.status = 'paid-off'; });
    eq('A16 已收线伏笔不注入', fwBuildInjectionBlocks(story, { progress: story.progress }).some(b => b.key === 'foreshadow'), false);

    // 空书不抛错
    const empty = fwCreateStory({ title: '空' });
    eq('A17 空书返回空块数组', fwBuildInjectionBlocks(empty, {}), []);
});

group('B. 预算裁剪', () => {
    const story = makeStory();
    const blocks = fwBuildInjectionBlocks(story, { progress: story.progress, contextText: '青云' });

    const full = fwAssembleInjection(blocks, { maxTokens: FW_INJECTION_MAX_TOKENS_DEFAULT });
    truthy('B1 预算充足时全部装下', full.used.length === blocks.length);
    eq('B2 预算充足时没有省略', full.omitted, []);
    eq('B3 预算充足时不标记截断', full.truncated, false);
    truthy('B4 返回字数与 token 估算', full.chars > 0 && full.tokens > 0);
    eq('B5 token 估算与字数一致（1.5 字/token）', full.tokens, Math.ceil(full.chars / 1.5));

    const tiny = fwAssembleInjection(blocks, { maxTokens: 12 });
    truthy('B6 预算紧张时被截断', tiny.truncated === true);
    truthy('B7 高优先级块先进（stage 一定在 used 里）', tiny.used[0]?.key === 'stage');
    truthy('B8 低优先级块进 omitted', tiny.omitted.length > 0);
    truthy('B9 截断后总字数不超过预算', tiny.chars <= tiny.charBudget, `${tiny.chars} > ${tiny.charBudget}`);

    const zero = fwAssembleInjection(blocks, { maxTokens: 0 });
    truthy('B10 预算 0 时不产出文本（或只剩极小片段）', zero.chars <= 0 || zero.truncated === true);

    eq('B11 空块数组返回空文本', fwAssembleInjection([]).text, '');
    eq('B12 全是空文本的块被过滤', fwAssembleInjection([{ key: 'x', text: '  ' }]).used.length, 0);

    // 乱序输入也要按优先级装配
    const shuffled = fwAssembleInjection([
        { key: 'style', text: '文风内容', priority: 6 },
        { key: 'stage', text: '阶段内容', priority: 0 },
    ]);
    eq('B13 乱序输入按优先级装配', shuffled.used.map(u => u.key), ['stage', 'style']);
});

group('C. 注入 chat 消息数组', () => {
    const base = () => ([
        { role: 'system', content: '主提示词' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '在' },
    ]);

    const merged = base();
    const r1 = fwInsertIntoChatMessages(merged, { text: '【注入】', position: FW_INJECT_POSITION.IN_PROMPT });
    eq('C1 并进第一条 system（不新增消息）', merged.length, 3);
    eq('C2 合并模式标记', r1.mode, 'in_prompt_merge');
    truthy('C3 原文仍在', merged[0].content.includes('主提示词'));
    truthy('C4 注入内容已追加', merged[0].content.includes('【注入】'));
    eq('C5 注入内容在后（默认不抢先）', merged[0].content.startsWith('主提示词'), true);

    const head = base();
    fwInsertIntoChatMessages(head, { text: '【注入】', atHead: true });
    truthy('C6 atHead=true 时注入在前', head[0].content.startsWith('【注入】'));

    const noSystem = [{ role: 'user', content: '只有用户消息' }];
    const r3 = fwInsertIntoChatMessages(noSystem, { text: '【注入】' });
    eq('C7 没有 system 时补一条并放到最前', r3.mode, 'in_prompt_new');
    eq('C8 补的 system 在下标 0', noSystem[0].role, 'system');
    eq('C9 原消息被后移', noSystem[1].content, '只有用户消息');

    const inChat = base();
    fwInsertIntoChatMessages(inChat, { text: '【聊天内】', position: FW_INJECT_POSITION.IN_CHAT, depth: 0 });
    eq('C10 depth 0 插到末尾', inChat[inChat.length - 1].content, '【聊天内】');
    eq('C11 消息数 +1', inChat.length, 4);

    const inChat2 = base();
    fwInsertIntoChatMessages(inChat2, { text: '【聊天内】', position: FW_INJECT_POSITION.IN_CHAT, depth: 2 });
    // novel-injector 的口径：depth = 这段之后还隔着几条消息
    eq('C12 depth 2 时插入位置之后还剩 2 条消息', inChat2.length - 1 - inChat2.findIndex(m => m.content === '【聊天内】'), 2);
    eq('C13 depth 2 的具体下标', inChat2.findIndex(m => m.content === '【聊天内】'), 1);

    const untouched = base();
    eq('C14 空文本不插入', fwInsertIntoChatMessages(untouched, { text: '   ' }).inserted, false);
    eq('C15 非数组安全返回', fwInsertIntoChatMessages(null, { text: 'x' }).inserted, false);
    eq('C16 空文本不污染消息数组', untouched.length, 3);
});

group('D. 续写 prompt 与分支', () => {
    const story = makeStory();
    const blocks = fwBuildInjectionBlocks(story, { progress: story.progress, contextText: '青云' });

    const prompt = fwBuildContinuationPrompt({ blocks, beforeText: '他已经走到门口。', targetWords: 600 });
    truthy('D1 带设定与记忆段', prompt.includes('【本书设定与记忆】'));
    truthy('D2 带已写正文段', prompt.includes('【已写正文（末尾）】') && prompt.includes('他已经走到门口。'));
    truthy('D3 带任务段与字数', prompt.includes('【本次任务】') && prompt.includes('600'));
    eq('D4 没有要求时不出现定向段', prompt.includes('【本次续写要求】'), false);
    truthy('D5 强调只输出正文', prompt.includes('只输出小说正文'));

    const custom = fwBuildContinuationPrompt({ blocks, beforeText: '正文', instruction: '让男主发现线索', targetWords: 500 });
    truthy('D6 定向要求进 prompt', custom.includes('【本次续写要求】') && custom.includes('让男主发现线索'));

    const assembled = fwAssembleInjection(blocks, { maxTokens: 2000 });
    const fromAssembled = fwBuildContinuationPrompt({ assembled: assembled.text, beforeText: '正文' });
    truthy('D7 也可直接传装配好的文本', fromAssembled.includes('【角色人设】'));

    theBranch: {
        const multi = fwParseBranches('第一版正文\n===分支===\n第二版正文\n===分支===\n第三版正文', 3);
        eq('D8 按分隔符切出 3 个分支', multi.length, 3);
        eq('D9 分支内容正确', multi[1], '第二版正文');
        eq('D10 数量上限生效', fwParseBranches('一\n===分支===\n二\n===分支===\n三', 1).length, 1);
        eq('D11 没分隔符时视为单分支', fwParseBranches('只有一段正文').length, 1);
        eq('D12 空输入返回空数组', fwParseBranches('').length, 0);
    }
});

finish('injection.test.mjs');
