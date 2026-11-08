/**
 * lib/prompts.js 的单元测试：启发后续大纲（提示词 + 解析）、幕间约束、加料标签。
 *
 * 这两块是「模型 IO 契约」——格式一改，面板上的按钮就点不出东西，
 * 所以把分隔符、字段名、禁令关键词都钉死（参考 clean 提示词的测试思路）。
 */
import { group, ok, eq, truthy, finish } from './_assert.mjs';
import { pluginUrl } from './_paths.mjs';

const {
    FW_INTERLUDE_INSTRUCTION,
    FW_SPICE_TAGS,
    FW_OUTLINE_SEPARATOR,
    fwAppendTag,
    fwBuildOutlineMessages,
    fwParseOutlines,
} = await import(pluginUrl('lib/prompts.js'));

group('A. 启发大纲的请求', () => {
    const messages = fwBuildOutlineMessages({ assembled: '【角色人设】\n林昭', recentText: '他站在断桥上。', count: 3 });

    eq('A1 两条消息（system + user）', messages.length, 2);
    eq('A2 system 角色正确', messages[0].role, 'system');
    truthy('A3 要求三种走向', ['主线', '感情', '张力'].every(k => messages[0].content.includes(k)));
    truthy('A4 规定了输出分隔符', messages[0].content.includes(FW_OUTLINE_SEPARATOR));
    truthy('A5 user 里带知识库', messages[1].content.includes('林昭'));
    truthy('A6 user 里带已写正文', messages[1].content.includes('断桥上'));
    truthy('A7 user 里说明要几条', messages[1].content.includes('3 条'));

    eq('A8 没有上下文也能构造', fwBuildOutlineMessages().length, 2);
    truthy('A9 条数上限被夹到 4', fwBuildOutlineMessages({ count: 99 })[1].content.includes('4 条'));
    truthy('A10 条数下限被夹到 1', fwBuildOutlineMessages({ count: -5 })[1].content.includes('1 条'));
});

group('B. 大纲解析', () => {
    const raw = [
        '===大纲===',
        '[主线] 断桥埋符',
        '梗概：林昭追查埋符的人。',
        '===大纲===',
        '[感情] 灯笼下的沉默',
        '沈砚先开口道歉。',
        '===大纲===',
        '[张力] 旧宅避雨',
        '梗概：雨夜被困旧宅，两人靠得极近。',
    ].join('\n');

    const items = fwParseOutlines(raw, 4);
    eq('B1 切出三条', items.length, 3);
    eq('B2 类型被识别', items.map(i => i.kind), ['主线', '感情', '张力']);
    eq('B3 标题被识别', items[0].title, '断桥埋符');
    eq('B4 「梗概：」前缀被吃掉', items[0].body, '林昭追查埋符的人。');
    eq('B5 没有前缀的正文也保留', items[1].body, '沈砚先开口道歉。');
    eq('B6 limit 生效', fwParseOutlines(raw, 2).length, 2);
    eq('B7 空输入返回空数组', fwParseOutlines('').length, 0);
    eq('B8 不按格式来时整段当一条', fwParseOutlines('直接给一段没有标记的大纲')[0].title, '直接给一段没有标记的大纲');
    eq('B9 无标记时类型退回「走向」', fwParseOutlines('随便一段')[0].kind, '走向');
    eq('B10 全角括号也认', fwParseOutlines('【主线】某标题\n正文正文')[0].kind, '主线');
    truthy('B11 text 字段可直接塞进输入框', fwParseOutlines(raw)[1].text.includes('灯笼下的沉默'));
    eq('B12 全是分隔符时不产出空条目', fwParseOutlines(`${FW_OUTLINE_SEPARATOR}\n${FW_OUTLINE_SEPARATOR}`).length, 0);
});

group('C. 幕间约束与加料标签', () => {
    truthy('C1 明令不跳时间', FW_INTERLUDE_INSTRUCTION.includes('严禁跳过时间'));
    truthy('C2 明令不推进节点', FW_INTERLUDE_INSTRUCTION.includes('严禁推进到下一个剧情节点'));
    truthy('C3 点出感官与心理维度', FW_INTERLUDE_INSTRUCTION.includes('感官描写') && FW_INTERLUDE_INSTRUCTION.includes('心理挣扎'));
    truthy('C4 只输出正文', FW_INTERLUDE_INSTRUCTION.includes('只输出正文'));

    truthy('C5 标签库够用（至少 5 个）', FW_SPICE_TAGS.length >= 5);
    ok('C6 标签库都是非空字符串', FW_SPICE_TAGS.every(t => typeof t === 'string' && t.trim().length > 0));

    eq('C7 空要求时直接变成标签', fwAppendTag('', '言语挑逗'), '言语挑逗');
    eq('C8 已有要求时追加', fwAppendTag('让男主起疑', '慢节奏细节'), '让男主起疑；慢节奏细节');
    eq('C9 重复点同一个标签不叠加', fwAppendTag('让男主起疑；慢节奏细节', '慢节奏细节'), '让男主起疑；慢节奏细节');
    eq('C10 空标签不改动要求', fwAppendTag('原有要求', '   '), '原有要求');
    eq('C11 不拆坏整句要求', fwAppendTag('让他别急，慢慢来', '感官描写'), '让他别急，慢慢来；感官描写');
    eq('C12 首尾空白被清掉', fwAppendTag('  原有要求  ', ' 感官描写 '), '原有要求；感官描写');
});

finish('prompts.test.mjs');
