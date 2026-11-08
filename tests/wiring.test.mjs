/**
 * 接线契约测试：`index.js` 是唯一碰酒馆 API 的装配层，最容易犯两类错——
 *   1. 从 lib/ 里 import 了一个不存在的导出 → 扩展一加载就白屏（运行时才炸）
 *   2. lib/ 里偷偷 import 了酒馆模块 → 纯函数层被污染，测试也跑不动
 * 这里用静态扫描 + 动态 import 把这两条钉住。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readPlugin, pluginUrl, PLUGIN_ROOT } from './_paths.mjs';
import { group, ok, truthy, finish } from './_assert.mjs';

const indexSrc = readPlugin('index.js');

/** 解析 `import { a, b } from './lib/x.js'` 形式的语句 */
function parseLocalImports(src) {
    return [...src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)';/g)].map(m => ({
        from: m[2],
        names: m[1].split(',').map(s => s.trim()).filter(Boolean),
    }));
}

const imports = parseLocalImports(indexSrc);

// 先把每个 lib 模块真实导出抓下来（这些模块不碰酒馆，Node 里可直接 import）
const moduleExports = new Map();
for (const { from } of imports) {
    const mod = await import(pluginUrl(from.replace(/^\.\//, '')));
    moduleExports.set(from, new Set(Object.keys(mod)));
}

group('A. import 能解析到真实导出', () => {
    truthy('A1 index.js 有本地 import', imports.length >= 4);
    for (const { from, names } of imports) {
        const available = moduleExports.get(from) || new Set();
        const missing = names.filter(n => !available.has(n));
        ok(`A2 ${from} 提供了 ${names.length} 个被引用的导出`, missing.length === 0,
            `缺少：${missing.join(', ')}`);
    }
});

group('B. lib/ 保持纯函数（不许 import 酒馆模块）', () => {
    const libDir = path.join(PLUGIN_ROOT, 'lib');
    const files = fs.readdirSync(libDir).filter(f => f.endsWith('.js'));
    truthy('B1 lib/ 下有模块', files.length >= 4);

    for (const file of files) {
        const src = fs.readFileSync(path.join(libDir, file), 'utf8');
        const bad = /from\s*'(\/scripts\/|\/script\.js|\/scripts)/
            .test(src) || /from\s*'(https?:)?\/\//.test(src);
        ok(`B2 lib/${file} 没有依赖酒馆/外部 URL`, !bad);
    }
});

group('C. 装配层关键函数都在', () => {
    const required = [
        'init', 'bindPanelEvents', 'registerChatHooks', 'loadTemplateHtml',
        'loadStoryById', 'createStory', 'renderStorySelect', 'renderStats',
        'renderPreview', 'buildInjection', 'importTxtFile', 'runClean',
        'runContinuation', 'runPolish', 'renderBranches', 'fillSendBox',
        'lastRealText', 'persistDraft', 'getProgress', 'setProgress',
        'loadSettings', 'readSettingsFromUI', 'syncSettingsToUI',
    ];
    const defined = new Set([...indexSrc.matchAll(/^(?:async )?function (\w+)/gm)].map(m => m[1]));
    const missing = required.filter(n => !defined.has(n));
    ok(`C1 ${required.length} 个关键函数都有定义`, missing.length === 0, `缺少：${missing.join(', ')}`);

    // 面板按钮 -> 函数，逐个点一遍（只查调用点存在，不执行）
    const wired = [
        ['runClean', 'void runClean()'],
        ['runContinuation', 'void runContinuation()'],
        ['runPolish', 'void runPolish()'],
        ['renderPreview', "on('fw-preview-btn', 'click'"],
        ['importTxtFile', 'await importTxtFile('],
        ['exportAllStories', "'fw-export', 'click', exportAllStories"],
        ['importAllStories', 'await importAllStories('],
    ];
    const unwired = wired.filter(([, needle]) => !indexSrc.includes(needle)).map(([name]) => name);
    ok('C2 面板按钮都接上了对应函数', unwired.length === 0, `未接线：${unwired.join(', ')}`);
});

group('D. index.js 不重复定义', () => {
    const names = [...indexSrc.matchAll(/^(?:async )?function (\w+)/gm)].map(m => m[1]);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    ok('D1 没有重复的 function 定义（重复会让后者静默覆盖前者）', dupes.length === 0, `重复：${dupes.join(', ')}`);
});

finish('wiring.test.mjs');
