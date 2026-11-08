/**
 * lib/text.js 的单元测试：分段、章节识别、句界截断、关键词命中。
 * 这些函数是「不切半句话」和「预算裁剪」的地基，必须钉住。
 */
import { group, ok, eq, truthy, finish } from './_assert.mjs';
import { pluginUrl } from './_paths.mjs';

const {
    FW_CHARS_PER_TOKEN,
    fwEstimateTokens,
    fwCharBudget,
    fwNormalizeText,
    fwDetectChapters,
    fwFindSafeCut,
    fwSplitBySize,
    fwCutAtBoundary,
    fwTakeTail,
    fwSplitKeywords,
    fwMatchesKeywords,
} = await import(pluginUrl('lib/text.js'));

group('A. Token 估算与预算', () => {
    eq('A1 空文本 0 token', fwEstimateTokens(''), 0);
    eq('A2 null 安全', fwEstimateTokens(null), 0);
    eq('A3 1500 字 = 1000 token', fwEstimateTokens('字'.repeat(1500)), 1000);
    eq('A4 常量仍是 1.5', FW_CHARS_PER_TOKEN, 1.5);
    eq('A5 预算换算 32000 token → 48000 字', fwCharBudget(32000), 48000);
    eq('A6 非法预算退 0', fwCharBudget('abc'), 0);
});

group('B. 文本规整', () => {
    eq('B1 CRLF 归一', fwNormalizeText('a\r\nb'), 'a\nb');
    eq('B2 去零宽字符', fwNormalizeText('a\u200Bb'), 'ab');
    eq('B3 压缩连续空行', fwNormalizeText('a\n\n\n\n\nb'), 'a\n\nb');
    eq('B4 去掉首尾空白', fwNormalizeText('  x  '), 'x');
});

group('C. 章节识别', () => {
    const text = fwNormalizeText(
        '第一章 起点\n正文一。\n第二章 转折\n正文二。\n番外 一\n正文三。',
    );
    const chapters = fwDetectChapters(text);
    eq('C1 识别出 3 章', chapters.length, 3);
    eq('C2 标题取整行', chapters[0].title, '第一章 起点');
    ok('C3 章节区间连续且覆盖全文', chapters[0].start === 0 && chapters[2].end === text.length,
        JSON.stringify(chapters));
    ok('C4 每章 chars = end - start', chapters.every(c => c.chars === c.end - c.start));

    const withPreface = fwDetectChapters(fwNormalizeText('引子正文。\n第一章 开始\n正文。'));
    eq('C5 标题前正文单独成「前言」', withPreface[0].title, '前言');

    const plain = fwDetectChapters(fwNormalizeText('没有任何章节标题的一段正文。'));
    eq('C6 无标题时整篇算一章', plain.length, 1);
    eq('C7 无标题章名', plain[0].title, '全文');
    eq('C8 空文本返回空数组', fwDetectChapters('').length, 0);
});

group('D. 句界切分（不切半句）', () => {
    const sentence = '他推开门。屋里很暗，只有桌上的一盏灯还亮着。';
    const text = (sentence + sentence + sentence).repeat(20);

    // 注意：fwSplitBySize 有 200 字下限（真实用法是几千字的清洗分段）
    const segments = fwSplitBySize(text, 300);
    truthy('D1 切出多段', segments.length > 1);
    ok('D2 每段都在句末/换行处收尾（soft=true）', segments.every(s => s.soft), JSON.stringify(segments.slice(0, 3)));
    ok('D3 段区间首尾相接不重叠', segments.every((s, i) => i === 0 || s.start === segments[i - 1].end));
    eq('D4 最后一段到文本末尾', segments[segments.length - 1].end, text.length);
    ok('D5 每段长度不超过目标 110%', segments.every(s => s.chars <= 330), JSON.stringify(segments.map(s => s.chars)));

    const noBreak = '甲'.repeat(500);
    const forced = fwSplitBySize(noBreak, 300);
    ok('D6 没有任何标点时退化为硬切（soft=false）', forced.some(s => s.soft === false));

    const cut = fwFindSafeCut(sentence, 10, 0);
    ok('D7 fwFindSafeCut 落在句末标点之后', sentence[cut.pos - 1] === '。', `pos=${cut.pos}`);
});

group('E. 边界截断', () => {
    const text = '第一句话。第二句话。第三句话。';
    const short = fwCutAtBoundary(text, 1000);
    eq('E1 未超限不截断', short.truncated, false);
    eq('E2 未超限原文返回', short.text, text);

    const long = fwCutAtBoundary(text, 12);
    eq('E3 超限标 truncated', long.truncated, true);
    truthy('E4 截断带标记', long.text.includes('已截断'));
    ok('E5 截断后在句界收尾', long.text.replace('……（已截断）', '').endsWith('。'),
        JSON.stringify(long.text));

    const tail = fwTakeTail(text, 8);
    truthy('E6 取尾从完整句子开始', tail.startsWith('第三') || tail.startsWith('第二'), tail);
});

group('F. 关键词', () => {
    eq('F1 切分顿号', fwSplitKeywords('青云宗、剑修 天阶;魔道'), ['青云宗', '剑修', '天阶', '魔道']);
    eq('F2 空关键词表 → 始终命中', fwMatchesKeywords([], '任何正文'), true);
    eq('F3 命中', fwMatchesKeywords(['青云宗'], '他回到青云宗山门'), true);
    eq('F4 未命中', fwMatchesKeywords(['青云宗'], '他去了别处'), false);
    eq('F5 空正文不命中', fwMatchesKeywords(['青云宗'], ''), false);
});

finish('text.test.mjs');
