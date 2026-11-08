/**
 * UI 契约测试：index.js 里引用的每一个 `fw-*` 元素 id，都必须在 template.html 里存在。
 *
 * 装配层最容易犯的错就是「改了模板 id，忘了改代码」——运行时只会静默失效（按钮点了没反应），
 * 这类 bug 靠手点很难发现，所以用一次静态扫描钉住（参考 novel-injector 源码扫描式测试）。
 */
import { readPlugin } from './_paths.mjs';
import { group, ok, eq, truthy, finish } from './_assert.mjs';

const indexSrc = readPlugin('index.js');
const templateSrc = readPlugin('template.html');

/** 模板里声明的所有 id */
const templateIds = new Set([...templateSrc.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

/** index.js 里通过 el('...') 或 on('...') 引用的 id */
const referenced = new Set([
    ...[...indexSrc.matchAll(/\bel\('([^']+)'\)/g)].map(m => m[1]),
    ...[...indexSrc.matchAll(/\bon\('([^']+)'/g)].map(m => m[1]),
]);

group('A. 元素 id 契约', () => {
    truthy('A1 模板里有 id', templateIds.size > 10);
    ok('A2 模板 id 全部带 fw- 前缀', [...templateIds].every(id => id.startsWith('fw-')),
        [...templateIds].filter(id => !id.startsWith('fw-')).join(', '));

    const missing = [...referenced].filter(id => !templateIds.has(id));
    ok('A3 index.js 引用的 id 在模板里都存在', missing.length === 0, `模板里缺少：${missing.join(', ')}`);
});

group('B. 设置项双向同步', () => {
    // writeList：syncSettingsToUI 里写回 UI 的 id；readList：readSettingsFromUI 里读的 id
    const syncBlock = indexSrc.slice(indexSrc.indexOf('function syncSettingsToUI'), indexSrc.indexOf('/**\n * 进度指针'));
    const readBlock = indexSrc.slice(indexSrc.indexOf('function readSettingsFromUI'), indexSrc.indexOf('/** 把设置写回 UI'));

    const synced = [...syncBlock.matchAll(/set\('([^']+)'/g)].map(m => m[1]);
    const read = [
        ...[...readBlock.matchAll(/el\('([^']+)'\)/g)].map(m => m[1]),
        ...[...readBlock.matchAll(/\bnum\('([^']+)'/g)].map(m => m[1]),
    ];

    truthy('B1 syncSettingsToUI 写了若干项', synced.length >= 8);
    truthy('B2 readSettingsFromUI 读了若干项', read.length >= 8, `实际读到 ${read.length} 项：${read.join(', ')}`);

    const notSynced = read.filter(id => !synced.includes(id));
    ok('B3 所有会被读回的设置项，也都能写回 UI（否则刷新后面板显示旧值）',
        notSynced.length === 0, `未同步：${notSynced.join(', ')}`);
});

group('C. 关键钩子存在', () => {
    ok('C1 注册了 CHAT_COMPLETION_PROMPT_READY', indexSrc.includes('event_types.CHAT_COMPLETION_PROMPT_READY'));
    ok('C2 注入走 fwInsertIntoChatMessages', indexSrc.includes('fwInsertIntoChatMessages('));
    ok('C3 续写走 generateRaw', indexSrc.includes('generateRaw('));
    ok('C4 注入异常被 catch 住（不能打断本轮生成）',
        /catch \(e\) \{\s*\/\/[^\n]*\n\s*console\.warn\('\[续写工坊\] 注入失败/.test(indexSrc));
    ok('C5 有总开关判断', indexSrc.includes("if (!cfg().enabled) return;"));
});

group('D. manifest 契约', () => {
    const manifest = JSON.parse(readPlugin('manifest.json'));
    eq('D1 js 指向 index.js', manifest.js, 'index.js');
    eq('D2 css 指向 style.css', manifest.css, 'style.css');
    truthy('D3 有 display_name', Boolean(manifest.display_name));
    ok('D4 版本号是字符串', typeof manifest.version === 'string');
});

group('E. 工作台（全屏界面）契约', () => {
    // 分页面板 fw-pane-x 与导航按钮 fw-nav-x 必须成对出现，否则点了没反应
    const paneIds = [...templateSrc.matchAll(/id="fw-pane-([a-z]+)"/g)].map(m => m[1]);
    const navIds = [...templateSrc.matchAll(/id="fw-nav-([a-z]+)"/g)].map(m => m[1]);

    truthy('E1 模板里有分页面板', paneIds.length >= 4, paneIds.join(', '));
    eq('E2 每个分页都有对应的导航按钮', navIds, paneIds);

    const paneListMatch = indexSrc.match(/const FW_PANES = \[([^\]]+)\]/);
    truthy('E3 index.js 声明了 FW_PANES', Boolean(paneListMatch));
    const paneList = [...(paneListMatch?.[1] || '').matchAll(/'([a-z]+)'/g)].map(m => m[1]);
    eq('E4 FW_PANES 与模板分页一一对应（顺序决定导航顺序）', paneList, paneIds);

    ok('E5 有打开 / 关闭工作台的函数',
        /function openWorkshop\(/.test(indexSrc) && /function closeWorkshop\(/.test(indexSrc));
    ok('E6 工作台被挪到 body（否则抽屉一关全屏层也跟着不见）',
        indexSrc.includes('document.body.appendChild(overlay)'));
    ok('E7 抽屉里保留入口卡片',
        templateIds.has('fw-launcher') && templateIds.has('fw-open-workshop') && templateIds.has('fw-launcher-info'));
    ok('E8 支持 Esc 关闭', indexSrc.includes("=== 'Escape'"));
    ok('E9 分页切换走 showPane（样式表里也定义了 .is-active）',
        indexSrc.includes('function showPane(') && readPlugin('style.css').includes('.fw-nav-item.is-active'));
});

group('F. 进阶开关契约（滑窗 / 启发大纲 / 幕间模式）', () => {
    const optionValues = [...templateSrc.matchAll(/<select id="fw-lookahead"[\s\S]*?<\/select>/g)]
        .flatMap(block => [...block[0].matchAll(/<option value="(\d)"/g)].map(m => m[1]));

    eq('F1 滑窗有 0~5 六个档位', optionValues, ['0', '1', '2', '3', '4', '5']);
    ok('F2 旧的布尔开关已经被滑窗取代',
        templateIds.has('fw-lookahead') && !templateIds.has('fw-future-enabled'));
    ok('F3 index.js 按节点数量读滑窗（不再绑旧开关的 id）',
        indexSrc.includes("num('fw-lookahead'") && !indexSrc.includes("'fw-future-enabled'"));
    ok('F4 启发大纲的按钮 / 提示 / 结果容器都在',
        templateIds.has('fw-outline-btn') && templateIds.has('fw-outline-msg') && templateIds.has('fw-outlines'));
    ok('F5 大纲按钮接了事件', indexSrc.includes("on('fw-outline-btn', 'click'"));
    ok('F6 幕间模式开关 + 标签容器都在',
        templateIds.has('fw-spice-mode') && templateIds.has('fw-spice-tags'));
    ok('F7 幕间模式进了续写 prompt', indexSrc.includes('interlude: c.spiceMode === true'));
    ok('F8 标签按钮按标签库渲染', indexSrc.includes('FW_SPICE_TAGS.forEach'));
    ok('F9 采纳大纲走 fwAddNode（不手搓节点）', indexSrc.includes('fwAddNode(story'));
});

finish('ui-contract.test.mjs');
