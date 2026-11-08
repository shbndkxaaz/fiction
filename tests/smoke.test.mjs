/**
 * 装配层冒烟测试：在 Node 里用假 DOM + 桩子把 `index.js` 真正跑一遍。
 *
 * 覆盖「加载即白屏」这一类最贵的 bug：
 *   建书 → 导入 TXT → 清洗 → 预览注入 → 发送前注入 → 续写分支 → 润色
 * 静态扫描（ui-contract / wiring）管契约，这里管「点了到底有没有反应」。
 */
import fs from 'node:fs';
import { pluginUrl, readPlugin, pluginPath } from './_paths.mjs';
import { group, ok, eq, truthy, finish } from './_assert.mjs';
import { installDom, fire, flush, storage } from './_dom.mjs';
import { __context, extension_settings } from './_stubs/st-extensions.mjs';
import { __emit, chat_metadata, event_types } from './_stubs/st-script.mjs';

const templateSrc = readPlugin('template.html');

// 把两处酒馆 import 换成桩子，写成临时副本再 import（不动源文件）
const TMP = pluginPath('.tmp_index.smoke.mjs');
fs.writeFileSync(TMP, readPlugin('index.js')
    .replace("'/scripts/extensions.js'", JSON.stringify(pluginUrl('tests/_stubs/st-extensions.mjs')))
    .replace("'/script.js'", JSON.stringify(pluginUrl('tests/_stubs/st-script.mjs'))), 'utf8');

const { registry, settingsHost } = installDom();
const el = id => registry.get(id);

// ── 假 fetch：template.html / chat/completions 两种请求 ──
const CLEAN_REPLY = {
    compressed: '林昭在断桥等到沈砚，得知桥下有人埋了符。',
    nodes: [
        {
            title: '断桥夜会',
            body: '林昭在断桥等沈砚，两人约定三日后同去旧宅，桥下发现埋符。',
            lane: 'main',
            time: '子时',
            location: '断桥',
            events: ['林昭赴约', '桥下发现埋符'],
            foreshadow: ['桥下埋符是谁做的'],
            chars: ['林昭', '沈砚'],
        },
        {
            title: '埋符疑云',
            body: '沈砚认出符纸纹样属于旧宅一脉，怀疑有人抢在前面动过手。',
            lane: 'sub',
            time: '子时',
            location: '断桥',
            events: ['认出纹样'],
            foreshadow: [],
            chars: ['沈砚'],
        },
    ],
    chars: [
        { name: '林昭', aliases: ['昭儿'], identity: '主角，寒门剑修', relations: [], exitStage: 0 },
        { name: '沈砚', aliases: [], identity: '旧宅一脉后人', relations: ['与林昭是同门'], exitStage: 0 },
    ],
    world: [
        { category: 'power', label: '符纸纹样', content: '旧宅一脉独有的封禁纹样', keywords: ['符', '纹样'] },
    ],
};

/** 排队返回的 chat/completions 回复（用完后一律回 CLEAN_REPLY） */
const apiReplies = [];
const apiCalls = [];

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('template.html')) {
        return { ok: true, status: 200, text: async () => templateSrc };
    }
    if (u.includes('/chat/completions')) {
        apiCalls.push(JSON.parse(opts.body || '{}'));
        const content = apiReplies.length ? apiReplies.shift() : JSON.stringify(CLEAN_REPLY);
        return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content } }] }),
        };
    }
    throw new Error(`未预料的 fetch：${u}`);
};

// ── 加载扩展（jQuery(cb) 在酒馆里是「页面就绪后调用」） ──
let initPromise = null;
globalThis.jQuery = fn => { initPromise = Promise.resolve().then(fn); };

const importsOk = await import(pluginUrl('.tmp_index.smoke.mjs')).then(() => true, e => {
    console.error('  ❌ index.js import 失败：', e?.stack || e);
    return false;
});
await initPromise;
await flush(3);

group('A. 加载与面板挂载', () => {
    ok('A1 index.js 能被加载并完成 init()', importsOk);
    eq('A2 面板挂到酒馆设置容器里', settingsHost.children.length, 1);
    ok('A3 模板里的控件已就位', ['fw-story-select', 'fw-clean-btn', 'fw-draft', 'fw-branches']
        .every(id => Boolean(el(id))));
    eq('A4 设置同步到 UI（分段大小）', el('fw-chunk-size').value, '60000');
    eq('A5 设置同步到 UI（总开关默认开）', el('fw-enabled').checked, true);
    ok('A6 没书时统计区给出提示', String(el('fw-stats').textContent).includes('还没有打开的书'));
    ok('A7 注册了发送前注入钩子', (__context && true) && typeof event_types.CHAT_COMPLETION_PROMPT_READY === 'string');
});


group('A2. 工作台开关与分页', () => {
    const body = globalThis.document.body;
    ok('A8 工作台挂在 body 上（不是塞在抽屉里）',
        body.children.some(child => child.id === 'fw-workshop'));
    ok('A9 抽屉里没有工作台本体', !settingsHost.children.some(child => child.id === 'fw-workshop'));
    ok('A10 默认不打开工作台', el('fw-workshop').style.display !== 'flex');

    fire(el('fw-open-workshop'), 'click');
    eq('A11 点「打开工作台」后可见', el('fw-workshop').style.display, 'flex');
    eq('A12 默认停在书库页', el('fw-pane-kb').style.display, 'block');
    eq('A13 其它分页默认隐藏', el('fw-pane-write').style.display, 'none');

    fire(el('fw-nav-write'), 'click');
    eq('A14 点导航切到续写页', el('fw-pane-write').style.display, 'block');
    eq('A15 上一个分页随之隐藏', el('fw-pane-kb').style.display, 'none');
    ok('A16 导航高亮跟着切', String(el('fw-nav-write').className).includes('is-active')
        && !String(el('fw-nav-kb').className).includes('is-active'));

    fire(el('fw-nav-kb'), 'click');
    fire(el('fw-close-workshop'), 'click');
    eq('A17 关闭后隐藏', el('fw-workshop').style.display, 'none');
});

// ── 异步用例块（group() 是同步的，这里要 await 事件处理器） ──
async function step(title, fn) {
    console.log(`\n[${title}]`);
    try {
        await fn();
    } catch (e) {
        console.error(`  ❌ ${title} 抛出异常：${e?.stack || e}`);
        process.exitCode = 1;
    }
}

const TXT = [
    '第一章 断桥',
    '夜色如墨，林昭站在断桥上，指尖冻得发麻。他在等沈砚。',
    '远处传来脚步声，沈砚提着灯笼走来，两人低声说了几句，约定三日后同去旧宅。',
    '临别时林昭低头看见桥缝里露出的半张符纸，纹样陌生又眼熟。',
    '',
    '第二章 旧宅',
    '三日后，旧宅的门虚掩着，院里落满枯叶。沈砚认出符纸纹样属于旧宅一脉。',
].join('\n');

/** 从 localStorage 里读当前这本书（走真实的 store 序列化） */
function storedStory() {
    const raw = storage.get('fiction_weaver_active_story');
    return raw ? JSON.parse(storage.get(`fiction_weaver_story_${raw}`) || 'null') : null;
}

await step('B. 建书与导入 TXT', async () => {
    fire(el('fw-story-create'), 'click');
    await flush(2);
    ok('B1 新建后统计区显示书名', String(el('fw-stats').textContent).includes('未命名小说'));
    ok('B2 书列表里出现这本', el('fw-story-select').children.length === 1);

    el('fw-txt-file').files = [{ name: '断桥记.txt', text: async () => TXT }];
    fire(el('fw-txt-file'), 'change');
    await flush(6);

    const s = storedStory();
    ok('B3 原文切成段并落盘', Boolean(s?.chunks?.length >= 1), JSON.stringify(s?.chunks?.length));
    ok('B4 没起名时用文件名当书名', s?.title === '断桥记', s?.title);
    ok('B5 章节被识别出来', s?.source?.chapters?.length >= 1);
    ok('B6 提示行报告导入结果', String(el('fw-clean-msg').textContent).includes('已导入'));
    ok('B7 统计区显示书名', String(el('fw-stats').textContent).includes('断桥记'));
    ok('B8 还没清洗时标记为未完成', s.chunks.filter(c => c.done).length === 0);
    ok('B9 入口卡片摘要跟着更新', String(el('fw-launcher-info').textContent).includes('断桥记'));
    ok('B10 工作台标题栏显示当前书', String(el('fw-workshop-sub').textContent).includes('断桥记'));
});

await step('C. 清洗一段', async () => {
    el('fw-api-url').value = 'https://api.test/v1';
    fire(el('fw-api-url'), 'change');
    el('fw-api-model').value = 'test-model';
    fire(el('fw-api-model'), 'change');

    fire(el('fw-clean-btn'), 'click');
    await flush(10);

    const s = storedStory();
    eq('C1 分段标记为已清洗', s.chunks[0].done, true);
    eq('C2 节点入库', s.nodes.length, 2);
    eq('C3 角色入库', s.chars.length, 2);
    eq('C4 世界设定入库', s.world.length, 1);
    ok('C5 压缩正文写回分段', Boolean(s.chunks[0].clean));
    ok('C6 伏笔被登记', s.memory.foreshadows.length >= 1);
    ok('C7 提示行报告清洗结果', String(el('fw-clean-msg').textContent).includes('清洗结束'));
    ok('C8 统计区显示节点数', String(el('fw-stats').textContent).includes('节点 2'));

    const call = apiCalls[apiCalls.length - 1];
    ok('C9 请求里带了清洗 system 提示词',
        String(call.messages?.[0]?.content || '').includes('资深小说编辑'));
    eq('C10 请求 max_tokens 用 8000', call.max_tokens, 8000);
    eq('C11 请求带上了配置的模型', call.model, 'test-model');
});


await step('D. 预览与发送前注入', async () => {
    fire(el('fw-preview-btn'), 'click');
    const preview = String(el('fw-preview').textContent);
    ok('D1 预览里有节点标题', preview.includes('断桥夜会'));
    ok('D2 预览里有 token 预算提示', preview.includes('token'));

    const chat = [{ role: 'system', content: 'BASE-PROMPT' }, { role: 'user', content: '（开始）' }];
    __emit(event_types.CHAT_COMPLETION_PROMPT_READY, { chat });
    ok('D3 注入并进第一条 system 而不是新增一条', chat.length === 2 && chat[0].role === 'system');
    ok('D4 原 system 内容还在', String(chat[0].content).includes('BASE-PROMPT'));
    ok('D5 知识库内容被注入', String(chat[0].content).includes('断桥夜会'));

    el('fw-enabled').checked = false;
    fire(el('fw-enabled'), 'change');
    const chat2 = [{ role: 'system', content: 'BASE-PROMPT' }];
    __emit(event_types.CHAT_COMPLETION_PROMPT_READY, { chat: chat2 });
    ok('D6 关掉总开关后完全不注入', chat2[0].content === 'BASE-PROMPT');

    el('fw-enabled').checked = true;
    fire(el('fw-enabled'), 'change');
});

await step('E. 进度推进', async () => {
    fire(el('fw-advance'), 'click');
    await flush(1);
    eq('E1 节点指针 +1', chat_metadata.fw?.progress?.nodeIdx, 0);
    ok('E2 指针也存进书里（跨对话兜底）', storedStory().progress.nodeIdx === 0);
    ok('E3 统计区显示当前进度', String(el('fw-stats').textContent).includes('节点序号 0'));
});

await step('F. 续写分支', async () => {
    const prompts = [];
    __context.chat = [{ is_user: false, mes: '夜色如墨，林昭站在断桥上，指尖冻得发麻。' }];
    __context.generateRaw = async ({ prompt }) => {
        prompts.push(prompt);
        return '正文A：林昭抬头看见灯笼光。\n===分支===\n正文B：林昭先躲到桥柱后。';
    };

    el('fw-branch-count').value = '2';
    fire(el('fw-branch-count'), 'change');
    fire(el('fw-continue-btn'), 'click');
    await flush(4);

    ok('F1 调用了 generateRaw 且只发一次', prompts.length === 1);
    ok('F2 续写提示词里有同一份知识库', prompts[0].includes('断桥夜会'));
    ok('F3 提示词里带上了已有正文', prompts[0].includes('指尖冻得发麻'));
    ok('F4 多分支时给出分隔符要求', prompts[0].includes('===分支==='));

    const box = el('fw-branches');
    eq('F5 渲染出两个分支', box.children.length, 2);
    ok('F6 分支正文正确切分', box.children[0].children[1].textContent.startsWith('正文A'));
    ok('F7 第二个分支也切分好了', box.children[1].children[1].textContent.startsWith('正文B'));

    const appendBtn = box.children[0].children[0].children[1].children[0];
    appendBtn.click();
    ok('F8 「追加到草稿」把分支写进草稿', String(el('fw-draft').value).includes('正文A'));

    const sendBtn = box.children[1].children[0].children[1].children[1];
    sendBtn.click();
    eq('F9 「填入输入框」写的是酒馆输入框', document.querySelector('#send_textarea').value,
        '正文B：林昭先躲到桥柱后。');
});

await step('G. 润色草稿', async () => {
    el('fw-draft').value = '这段写得有点 AI 味。';
    apiReplies.push('这段写得自然多了。');
    fire(el('fw-polish-btn'), 'click');
    await flush(6);
    eq('G1 草稿被润色结果替换', el('fw-draft').value, '这段写得自然多了。');
    const call = apiCalls[apiCalls.length - 1];
    ok('G2 润色请求用的是润色提示词',
        String(call.messages?.[0]?.content || '').includes('润色'));
});

await step('H. 草稿落盘与导出', async () => {
    await new Promise(resolve => setTimeout(resolve, 900));
    eq('H1 草稿自动存进书里', storedStory().draft, '这段写得自然多了。');
    fire(el('fw-export'), 'click');
    ok('H2 导出按钮给出反馈', String(el('fw-clean-msg').textContent).includes('已导出'));
});

await step('I. 进阶开关：未来大纲滑窗 / 启发大纲 / 幕间标签', async () => {
    // 1) 滑窗设置落盘（0~5 个节点）
    el('fw-lookahead').value = '2';
    fire(el('fw-lookahead'), 'change');
    eq('I1 滑窗设置存进 extension_settings', extension_settings['fiction-weaver'].lookaheadNodes, 2);

    // 2) 滑窗真的进了注入
    fire(el('fw-preview-btn'), 'click');
    ok('I2 预览里出现「后续剧情指引」', String(el('fw-preview').textContent).includes('后续剧情指引'));

    // 3) 启发后续大纲
    apiReplies.push([
        '===大纲===',
        '[主线] 旧宅探符',
        '梗概：林昭夜里潜回旧宅查符纸。',
        '===大纲===',
        '[感情] 灯笼下的沉默',
        '沈砚先开口替林昭挡下责难。',
        '===大纲===',
        '[张力] 雨夜避雨',
        '梗概：两人被雨困在旧宅柴房，靠得极近。',
    ].join('\n'));
    fire(el('fw-outline-btn'), 'click');
    await flush(6);

    const outlineBox = el('fw-outlines');
    eq('I3 渲染出三条大纲', outlineBox.children.length, 3);
    ok('I4 卡片标出类型与标题',
        String(outlineBox.children[0].children[0].children[0].textContent).includes('主线｜旧宅探符'));
    ok('I5 卡片正文被渲染', String(outlineBox.children[2].children[1].textContent).includes('旧宅柴房'));

    outlineBox.children[2].children[0].children[1].children[0].click();
    await flush(2);
    ok('I6 「采纳为节点」把大纲写进书里', storedStory().nodes.some(n => n.title === '雨夜避雨'));
    ok('I7 采纳后有反馈', String(el('fw-outline-msg').textContent).includes('采纳'));

    outlineBox.children[0].children[0].children[1].children[1].click();
    ok('I8 「带入续写要求」写进定向要求', String(el('fw-instruction').value).includes('旧宅探符'));

    // 4) 幕间模式 + 加料标签
    const tagBox = el('fw-spice-tags');
    ok('I9 标签按钮渲染出来了', tagBox.children.length >= 5);
    tagBox.children[0].click();
    ok('I10 点标签拼进定向要求', String(el('fw-instruction').value).includes('言语挑逗'));

    el('fw-spice-mode').checked = true;
    fire(el('fw-spice-mode'), 'change');
    eq('I11 幕间开关被存下来', extension_settings['fiction-weaver'].spiceMode, true);

    const prompts = [];
    __context.generateRaw = async ({ prompt }) => {
        prompts.push(prompt);
        return '幕间正文：她把灯放在门槛上。';
    };
    el('fw-branch-count').value = '1';
    fire(el('fw-branch-count'), 'change');
    el('fw-draft').value = '林昭推开门，屋里很暗。';
    fire(el('fw-continue-btn'), 'click');
    await flush(5);

    ok('I12 幕间模式下提示词带禁令', prompts.length === 1 && prompts[0].includes('严禁跳过时间'));
    ok('I13 幕间模式下任务改成不推进剧情', prompts[0].includes('不要推进剧情'));
    ok('I14 幕间模式下仍有已写正文', prompts[0].includes('林昭推开门'));
    ok('I15 幕间模式下仍带知识库', prompts[0].includes('断桥夜会'));
});

fs.rmSync(TMP, { force: true });
finish('smoke.test.mjs');
