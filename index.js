/**
 * 续写工坊 Fiction Weaver —— SillyTavern 第三方扩展入口（装配层）
 *
 * 这一层只做三件事：
 *   1. 与酒馆交互（设置持久化、事件钩子、generateRaw、chat_metadata 进度）
 *   2. 面板事件绑定
 *   3. 把 lib/ 里的纯函数串成两条管线（聊天注入 / 编辑器续写）
 *
 * 所有业务逻辑都在 lib/ 下，且被 tests/ 覆盖；这里不要写算法。
 * 上游参考：xu-xie-ji（分层总结/续写/润色/自动分章）、novel-injector-2w（清洗/注入/预算）。
 */

import { extension_settings, getContext } from '/scripts/extensions.js';
import { saveSettingsDebounced, eventSource, event_types, chat_metadata } from '/script.js';

import {
    fwListStories,
    fwLoadStory,
    fwSaveStory,
    fwDeleteStory,
    fwGetActiveStoryId,
    fwSetActiveStoryId,
    fwExportAll,
    fwImportAll,
} from './lib/store.js';

import { fwTakeTail } from './lib/text.js';

import {
    fwCreateStory,
    fwIngestText,
    fwParseCleanResult,
    fwMergeCleanResult,
    fwStoryStats,
} from './lib/kb.js';

import {
    FW_INJECT_POSITION,
    FW_INJECTION_MAX_TOKENS_DEFAULT,
    fwBuildInjectionBlocks,
    fwAssembleInjection,
    fwInsertIntoChatMessages,
    fwBuildContinuationPrompt,
    fwParseBranches,
} from './lib/injection.js';

import { fwCallChatCompletion } from './lib/clean-api.js';
import {
    FW_CLEAN_SYSTEM_PROMPT,
    fwBuildCleanUserMessage,
    fwBuildPolishMessages,
} from './lib/prompts.js';

const FW_EXT_NAME = 'fiction-weaver';

/** 设置默认值：数值全部沿用上游口径（见 docs/03-merged-architecture.md 第 6 节） */
const FW_DEFAULT_SETTINGS = {
    enabled: true,
    chunkSize: 60000,
    apiUrl: '',
    apiKey: '',
    apiModel: '',
    injPos: FW_INJECT_POSITION.IN_PROMPT,
    injDepth: 4,
    injMaxTokens: FW_INJECTION_MAX_TOKENS_DEFAULT,
    futureNodeEnabled: false,
    branchCount: 1,
    targetWords: 800,
};

/** 当前打开的书（内存里唯一一份，改动后立刻 fwSaveStory） */
let story = null;
/** 清洗循环的停止标志 */
let cleanStop = false;

const cfg = () => extension_settings[FW_EXT_NAME] || FW_DEFAULT_SETTINGS;
const el = id => document.getElementById(id);

/** 面板里的提示行 */
function setMsg(id, text, kind = '') {
    const node = el(id);
    if (!node) return;
    node.textContent = text || '';
    node.className = `fw-msg${kind ? ` is-${kind}` : ''}`;
}

/** 统一的错误摘要（不要把整段堆栈糊到面板上） */
function errText(e) {
    return e?.message || String(e || '未知错误');
}

function loadSettings() {
    extension_settings[FW_EXT_NAME] = Object.assign({}, FW_DEFAULT_SETTINGS, extension_settings[FW_EXT_NAME] || {});
}

/** 从 UI 读回设置（只读存在的元素，缺了就用旧值，避免半截 DOM 覆盖配置） */
function readSettingsFromUI() {
    const c = cfg();
    const num = (id, fallback, min, max) => {
        const node = el(id);
        if (!node) return fallback;
        const v = parseInt(node.value, 10);
        if (!Number.isFinite(v)) return fallback;
        return Math.max(min, Math.min(max, v));
    };
    c.enabled = el('fw-enabled')?.checked ?? c.enabled;
    c.chunkSize = num('fw-chunk-size', c.chunkSize, 2000, 200000);
    c.apiUrl = el('fw-api-url')?.value?.trim() ?? c.apiUrl;
    c.apiKey = el('fw-api-key')?.value?.trim() ?? c.apiKey;
    c.apiModel = el('fw-api-model')?.value?.trim() ?? c.apiModel;
    c.injPos = el('fw-inj-pos')?.value || c.injPos;
    c.injDepth = num('fw-inj-depth', c.injDepth, 0, 30);
    c.injMaxTokens = num('fw-inj-budget', c.injMaxTokens, 256, 200000);
    c.futureNodeEnabled = el('fw-future-enabled')?.checked ?? c.futureNodeEnabled;
    c.branchCount = num('fw-branch-count', c.branchCount, 1, 3);
    c.targetWords = num('fw-target-words', c.targetWords, 100, 4000);
    saveSettingsDebounced();
}

/** 把设置写回 UI（首次加载/切书时调用） */
function syncSettingsToUI() {
    const c = cfg();
    const set = (id, value) => {
        const node = el(id);
        if (!node) return;
        if (node.type === 'checkbox') node.checked = Boolean(value);
        else node.value = value ?? '';
    };
    set('fw-enabled', c.enabled);
    set('fw-chunk-size', c.chunkSize);
    set('fw-api-url', c.apiUrl);
    set('fw-api-key', c.apiKey);
    set('fw-api-model', c.apiModel);
    set('fw-inj-pos', c.injPos);
    set('fw-inj-depth', c.injDepth);
    set('fw-inj-budget', c.injMaxTokens);
    set('fw-future-enabled', c.futureNodeEnabled);
    set('fw-branch-count', c.branchCount);
    set('fw-target-words', c.targetWords);
}

/**
 * 进度指针：存在 chat_metadata（跟着对话走），书里的 progress 作兜底。
 * novel-injector 把整份数据挂 chat_metadata，这里只挂指针 —— 一本书可以跨多个对话。
 */
function getProgress() {
    const meta = (typeof chat_metadata !== 'undefined' && chat_metadata) ? chat_metadata : {};
    const saved = meta?.fw?.progress;
    if (saved && Number(saved.stageIdx) >= 1) {
        return { stageIdx: Number(saved.stageIdx), nodeIdx: Number(saved.nodeIdx ?? -1) };
    }
    const fallback = story?.progress || { stageIdx: 1, nodeIdx: -1 };
    return { stageIdx: Number(fallback.stageIdx) || 1, nodeIdx: Number(fallback.nodeIdx ?? -1) };
}

function setProgress(stageIdx, nodeIdx) {
    const progress = {
        stageIdx: Math.max(1, parseInt(stageIdx, 10) || 1),
        nodeIdx: Number.isFinite(parseInt(nodeIdx, 10)) ? parseInt(nodeIdx, 10) : -1,
        updatedAt: Date.now(),
    };
    try {
        if (typeof chat_metadata !== 'undefined' && chat_metadata) {
            chat_metadata.fw = chat_metadata.fw || {};
            chat_metadata.fw.progress = progress;
        }
    } catch (e) {
        console.warn('[续写工坊] 进度写入 chat_metadata 失败：', e);
    }
    if (story) {
        story.progress = progress;
        fwSaveStory(story);
    }
    const stageNode = el('fw-stage-idx');
    const nodeNode = el('fw-node-idx');
    if (stageNode) stageNode.value = String(progress.stageIdx);
    if (nodeNode) nodeNode.value = String(progress.nodeIdx);
}

// ─────────────────────────── 书管理 ───────────────────────────

function renderStorySelect() {
    const select = el('fw-story-select');
    if (!select) return;
    const list = fwListStories();
    select.innerHTML = '';
    if (!list.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '（还没有书）';
        select.appendChild(opt);
        return;
    }
    list.forEach(item => {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = `${item.title}（${Math.round((item.totalChars || 0) / 1000)}k字）`;
        select.appendChild(opt);
    });
    const activeId = story?.id || fwGetActiveStoryId();
    if (activeId) select.value = activeId;
}

/** 入口卡片 + 工作台标题栏的状态摘要（没有书时也要给出「下一步做什么」） */
function renderHeaderStatus(s, p) {
    const info = el('fw-launcher-info');
    const sub = el('fw-workshop-sub');
    if (!s) {
        if (info) info.textContent = '还没有书：打开工作台 → ① 书库 → 导入 TXT 就能开始。';
        if (sub) sub.textContent = '未选书';
        return;
    }
    const off = cfg().enabled ? '' : '（注入已关闭）';
    if (sub) sub.textContent = `《${s.title}》 · 第 ${p.stageIdx} 阶段 / 节点 ${p.nodeIdx}${off}`;
    if (info) {
        info.textContent = `《${s.title}》 ${s.totalChars} 字 · 节点 ${s.nodes} · 已清洗 ${s.chunksDone}/${s.chunks} 段\n`
            + `进度：第 ${p.stageIdx} 阶段 / 节点 ${p.nodeIdx}${off}`;
    }
}

function renderStats() {
    const box = el('fw-stats');
    if (!box) return;
    if (!story) {
        renderHeaderStatus(null);
        box.textContent = '还没有打开的书。先新建，然后导入 TXT。';
        return;
    }
    const s = fwStoryStats(story);
    const p = getProgress();
    renderHeaderStatus(s, p);
    box.textContent = [
        `《${s.title}》 ${s.totalChars} 字 / ${s.chapters} 章 / ${s.chunks} 段（已清洗 ${s.chunksDone}）`,
        `节点 ${s.nodes} · 角色 ${s.chars} · 世界设定 ${s.world} · 阶段 ${s.stages} · 总结 ${s.summaries} · 伏笔 ${s.foreshadows}`,
        `当前进度：第 ${p.stageIdx} 阶段，节点序号 ${p.nodeIdx}（-1 = 还没开始）`,
    ].join('\n');
}

function loadStoryById(id) {
    const loaded = id ? fwLoadStory(id) : null;
    story = loaded || null;
    if (story) {
        fwSetActiveStoryId(story.id);
        if (!story.inject) story.inject = {};
        setProgress(getProgress().stageIdx, getProgress().nodeIdx);
        const draft = el('fw-draft');
        if (draft) draft.value = story.draft || '';
    }
    renderStorySelect();
    renderStats();
    return story;
}

function createStory(title) {
    const wanted = String(title || '').trim();
    const fresh = fwCreateStory({ title: wanted });
    // 用户没起名 → 记一笔，导入 TXT 时自动用文件名，省一次改名
    fresh.autoTitle = !wanted;
    fwSaveStory(fresh);
    loadStoryById(fresh.id);
    setMsg('fw-clean-msg', `已新建《${fresh.title}》，接下来导入 TXT。`);
    return fresh;
}

// ─────────────────────────── 导入原文 ───────────────────────────

async function importTxtFile(file) {
    if (!file || !story) return;
    try {
        const text = await file.text();
        if (!text || !text.trim()) {
            setMsg('fw-clean-msg', '这个 TXT 是空的。', 'error');
            return;
        }
        fwIngestText(story, text, { chunkSize: cfg().chunkSize });
        // 没起过名的书，用文件名当书名（kb 的默认名 '未命名小说' 也算没起名）
        if (story.autoTitle || !story.title || story.title === '未命名小说') {
            story.title = file.name.replace(/\.txt$/i, '').trim() || story.title;
            story.autoTitle = false;
        }
        story.fileName = file.name;
        fwSaveStory(story);
        renderStorySelect();
        renderStats();
        setMsg('fw-clean-msg', `已导入 ${story.source.chapters.length} 章 / ${story.chunks.length} 段，可以去清洗了。`, 'ok');
    } catch (e) {
        console.warn('[续写工坊] 导入 TXT 失败：', e);
        setMsg('fw-clean-msg', `导入失败：${errText(e)}`, 'error');
    }
}

// ─────────────────────────── 注入 ───────────────────────────

/** 取最近几条消息做「关键词触发」的上下文（世界设定按需注入用） */
function recentContextText(limit = 6) {
    try {
        const chat = getContext()?.chat || [];
        return chat.slice(-limit)
            .map(m => String(m?.mes ?? m?.content ?? ''))
            .join('\n')
            .slice(-2000);
    } catch {
        return '';
    }
}

/** 组装本轮注入（聊天注入与续写共用） */
function buildInjection() {
    if (!story) return null;
    const blocks = fwBuildInjectionBlocks(story, {
        progress: getProgress(),
        settings: {
            futureNodeEnabled: cfg().futureNodeEnabled,
            summaryKeepRecent: 3,
        },
        contextText: recentContextText(),
    });
    return fwAssembleInjection(blocks, { maxTokens: cfg().injMaxTokens });
}

function renderPreview() {
    const box = el('fw-preview');
    if (!box) return;
    if (!story) {
        box.textContent = '还没有书。';
        return;
    }
    const assembled = buildInjection();
    if (!assembled || !assembled.text) {
        box.textContent = '这一轮没有可注入的内容（清洗完、或手工填了世界设定之后再来）。';
        return;
    }
    const head = `字数 ${assembled.chars} / 约 ${assembled.tokens} token（预算 ${assembled.maxTokens}）`
        + (assembled.omitted.length ? `\n因预算省略：${assembled.omitted.join('、')}` : '');
    const parts = assembled.used.map(u => `— ${u.key}（${u.text.length} 字）\n${u.text}`);
    box.textContent = `${head}\n\n${parts.join('\n\n')}`;
}

// ─────────────────────────── 清洗 ───────────────────────────

const apiReady = () => Boolean(cfg().apiUrl && cfg().apiModel);

/** 统一的外部 API 调用入口（清洗 / 总结 / 润色共用一套配置，v1 不做多套 API） */
function callPluginApi(messages, { maxTokens = 8000, temperature = 0.3 } = {}) {
    const c = cfg();
    return fwCallChatCompletion({
        url: c.apiUrl,
        apiKey: c.apiKey,
        model: c.apiModel,
        messages,
        temperature,
        maxTokens,
        timeoutMs: 900000,
    });
}

/** 逐段清洗（可停止；失败的那段保留 error，下次「开始清洗」会自动补跑） */
async function runClean() {
    if (!story) return setMsg('fw-clean-msg', '先新建/选择一本书。', 'error');
    if (!story.chunks.length) return setMsg('fw-clean-msg', '还没有原文，先导入 TXT。', 'error');
    if (!apiReady()) return setMsg('fw-clean-msg', '先填清洗 API 地址和模型。', 'error');

    const pending = story.chunks.filter(c => !c.done);
    if (!pending.length) return setMsg('fw-clean-msg', '所有分段都清洗过了。想重洗就删掉这本书重新导入。', 'ok');

    cleanStop = false;
    let okCount = 0;
    let failCount = 0;

    for (const chunk of pending) {
        if (cleanStop) {
            setMsg('fw-clean-msg', `已停止：完成 ${okCount} 段，失败 ${failCount} 段。`);
            renderStats();
            return;
        }
        setMsg('fw-clean-msg', `清洗第 ${chunk.idx} / ${story.chunks.length} 段（${chunk.chars} 字）…`);
        try {
            const prev = story.chunks.find(x => x.idx === chunk.idx - 1);
            const previousTail = fwTakeTail(prev ? (prev.clean || prev.text) : '', 800);
            const raw = await callPluginApi([
                { role: 'system', content: FW_CLEAN_SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: fwBuildCleanUserMessage({
                        text: chunk.text,
                        previousTail,
                        chunkIdx: chunk.idx,
                        total: story.chunks.length,
                    }),
                },
            ], { maxTokens: 8000, temperature: 0.3 });

            const parsed = fwParseCleanResult(raw);
            if (!parsed.nodes.length && !parsed.compressed) throw new Error('模型返回里没有剧情节点，也没有压缩正文');
            const merged = fwMergeCleanResult(story, chunk.idx, parsed);
            fwSaveStory(story);
            okCount += 1;
            setMsg('fw-clean-msg', `第 ${chunk.idx} 段完成：+${merged.addedNodes} 节点 / +${merged.addedChars} 角色 / +${merged.addedWorld} 设定`);
        } catch (e) {
            failCount += 1;
            chunk.error = errText(e);
            fwSaveStory(story);
            console.warn(`[续写工坊] 清洗第 ${chunk.idx} 段失败：`, e);
            setMsg('fw-clean-msg', `第 ${chunk.idx} 段失败：${chunk.error}`, 'error');
        }
        renderStats();
    }

    setMsg('fw-clean-msg', `清洗结束：完成 ${okCount} 段，失败 ${failCount} 段。`, failCount ? 'error' : 'ok');
    renderStats();
    renderPreview();
}

// ─────────────────────────── 续写 ───────────────────────────

/** 已写正文的末尾：优先用草稿，其次用最后一条 AI 消息 */
function lastRealText(limit = 4000) {
    const draft = el('fw-draft')?.value?.trim();
    if (draft) return fwTakeTail(draft, limit);
    const chat = getContext()?.chat || [];
    const last = [...chat].reverse().find(m => !m?.is_user && String(m?.mes || '').trim());
    return fwTakeTail(String(last?.mes || ''), limit);
}

/** 把文本放进酒馆的聊天输入框（不直接改聊天记录，避免越权写历史） */
function fillSendBox(text) {
    const box = document.querySelector('#send_textarea');
    if (!box) {
        setMsg('fw-write-msg', '找不到聊天输入框，请手动复制。', 'error');
        return;
    }
    box.value = String(text || '').trim();
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
    setMsg('fw-write-msg', '已填进输入框，确认无误后自己发送。', 'ok');
}

function renderBranches(branches) {
    const box = el('fw-branches');
    if (!box) return;
    box.innerHTML = '';
    branches.forEach((text, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'fw-branch';

        const head = document.createElement('div');
        head.className = 'fw-branch-head';
        const label = document.createElement('span');
        label.textContent = `分支 ${i + 1}（${text.length} 字）`;

        const actions = document.createElement('span');

        const appendBtn = document.createElement('button');
        appendBtn.className = 'menu_button';
        appendBtn.type = 'button';
        appendBtn.textContent = '追加到草稿';
        appendBtn.addEventListener('click', () => {
            const draft = el('fw-draft');
            if (!draft) return;
            draft.value = `${draft.value.trim()}\n\n${text}`.trim();
            draft.dispatchEvent(new Event('input'));
            setMsg('fw-write-msg', `分支 ${i + 1} 已追加到草稿。`, 'ok');
        });

        const sendBtn = document.createElement('button');
        sendBtn.className = 'menu_button';
        sendBtn.type = 'button';
        sendBtn.textContent = '填入输入框';
        sendBtn.addEventListener('click', () => fillSendBox(text));

        actions.append(appendBtn, sendBtn);
        head.append(label, actions);

        const body = document.createElement('div');
        body.className = 'fw-branch-text';
        body.textContent = text;

        wrap.append(head, body);
        box.appendChild(wrap);
    });
}

async function runContinuation() {
    if (!story) return setMsg('fw-write-msg', '先新建/选择一本书。', 'error');
    const ctx = getContext();
    if (typeof ctx?.generateRaw !== 'function') {
        return setMsg('fw-write-msg', '当前酒馆版本没有 generateRaw，无法续写。', 'error');
    }

    const c = cfg();
    const branchCount = Math.max(1, Math.min(3, c.branchCount));
    const instruction = el('fw-instruction')?.value?.trim() || '';
    const beforeText = lastRealText();

    if (!beforeText) {
        return setMsg('fw-write-msg', '没有任何已写正文：先聊几句，或在草稿框里贴一段开头。', 'error');
    }

    const assembled = buildInjection();
    let prompt = fwBuildContinuationPrompt({
        assembled: assembled?.text || '',
        beforeText,
        instruction,
        targetWords: c.targetWords,
    });
    if (branchCount > 1) {
        prompt += `\n\n【分支要求】请给出 ${branchCount} 个走向不同的版本，版本之间用一行「===分支===」分隔。`;
    }

    setMsg('fw-write-msg', `正在续写（${c.targetWords} 字${branchCount > 1 ? ` × ${branchCount} 分支` : ''}）…`);
    try {
        const raw = await ctx.generateRaw({ prompt, systemPrompt: '' });
        const branches = fwParseBranches(raw, branchCount);
        if (!branches.length) throw new Error('模型没有返回正文');
        renderBranches(branches);
        setMsg('fw-write-msg', `生成完成：${branches.length} 个分支。选一个「追加到草稿」或「填入输入框」。`, 'ok');
    } catch (e) {
        console.warn('[续写工坊] 续写失败：', e);
        setMsg('fw-write-msg', `续写失败：${errText(e)}`, 'error');
    }
}

async function runPolish() {
    const draft = el('fw-draft')?.value?.trim();
    if (!draft) return setMsg('fw-write-msg', '草稿是空的，没有可润色的内容。', 'error');
    if (!apiReady()) return setMsg('fw-write-msg', '先填清洗 API 地址和模型（润色也用它）。', 'error');

    setMsg('fw-write-msg', `正在润色 ${draft.length} 字…`);
    try {
        const polished = await callPluginApi(fwBuildPolishMessages(draft), { maxTokens: 8000, temperature: 0.6 });
        const box = el('fw-draft');
        if (box) {
            box.value = polished;
            box.dispatchEvent(new Event('input'));
        }
        setMsg('fw-write-msg', `润色完成（${draft.length} → ${polished.length} 字）。`, 'ok');
    } catch (e) {
        console.warn('[续写工坊] 润色失败：', e);
        setMsg('fw-write-msg', `润色失败：${errText(e)}`, 'error');
    }
}

/** 草稿落盘（跟书走，不跟聊天走） */
function persistDraft() {
    if (!story) return;
    story.draft = el('fw-draft')?.value || '';
    fwSaveStory(story);
}

// ─────────────────────────── 酒馆事件钩子 ───────────────────────────

function registerChatHooks() {
    if (typeof eventSource === 'undefined' || typeof event_types === 'undefined') return;

    // 注入：请求消息数组就绪时，把知识库并进第一条 system（不塞独立 system 消息，学 novel-injector）
    if (event_types.CHAT_COMPLETION_PROMPT_READY) {
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, eventData => {
            try {
                if (!cfg().enabled) return;
                if (eventData?.dryRun) return;
                if (!Array.isArray(eventData?.chat) || !story) return;
                const assembled = buildInjection();
                if (!assembled?.text) return;
                fwInsertIntoChatMessages(eventData.chat, {
                    text: assembled.text,
                    position: cfg().injPos,
                    depth: cfg().injDepth,
                });
            } catch (e) {
                // 注入链任何异常都不能让这一轮发不出去 → 只写控制台
                console.warn('[续写工坊] 注入失败（本轮跳过注入）：', e);
            }
        });
    } else {
        // 老版本酒馆没有这个事件：只是不能注入，续写/清洗照常可用
        console.warn('[续写工坊] 当前酒馆版本没有 CHAT_COMPLETION_PROMPT_READY，聊天注入不可用。');
    }

    // 换对话：书不变，只重新挂进度指针
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            if (!story) loadStoryById(fwGetActiveStoryId());
            const p = getProgress();
            setProgress(p.stageIdx, p.nodeIdx);
            renderStats();
        });
    }
}

// ─────────────────────────── 面板事件 ───────────────────────────

let draftTimer = null;
function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(persistDraft, 800);
}

function exportAllStories() {
    try {
        const payload = fwExportAll();
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `fiction-weaver-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        setMsg('fw-clean-msg', `已导出 ${payload.stories.length} 本书。`, 'ok');
    } catch (e) {
        setMsg('fw-clean-msg', `导出失败：${errText(e)}`, 'error');
    }
}

async function importAllStories(file) {
    try {
        const payload = JSON.parse(await file.text());
        const count = fwImportAll(payload);
        const first = fwListStories()[0];
        if (first) loadStoryById(first.id);
        setMsg('fw-clean-msg', `已导入 ${count} 本书。`, 'ok');
    } catch (e) {
        setMsg('fw-clean-msg', `导入失败（不是有效的导出文件？）：${errText(e)}`, 'error');
    }
}

// ─────────────────────────── 工作台（全屏界面） ───────────────────────────

/**
 * 分页顺序 = 左侧导航顺序。加新分页要同时改三处：
 * template.html 里的 `fw-nav-x`、`fw-pane-x`，以及这个数组。
 */
const FW_PANES = ['kb', 'clean', 'inject', 'progress', 'write', 'help'];

/** 上次打开的分页（关闭工作台后保留，下次还停在这一页） */
let currentPane = FW_PANES[0];

/** 一次只点亮一个分页；用 style 而不是 classList，假 DOM 里也能跑 */
function showPane(name) {
    const target = FW_PANES.includes(name) ? name : FW_PANES[0];
    FW_PANES.forEach(p => {
        const pane = el(`fw-pane-${p}`);
        if (pane) pane.style.display = p === target ? 'block' : 'none';
        const nav = el(`fw-nav-${p}`);
        if (nav) nav.className = p === target ? 'fw-nav-item is-active' : 'fw-nav-item';
    });
    return target;
}

function isWorkshopOpen() {
    return el('fw-workshop')?.style?.display === 'flex';
}

function openWorkshop(pane) {
    const box = el('fw-workshop');
    if (!box) return;
    box.style.display = 'flex';
    currentPane = showPane(pane || currentPane);
    renderStats();
}

function closeWorkshop() {
    const box = el('fw-workshop');
    if (!box) return;
    persistDraft();
    box.style.display = 'none';
}

function bindPanelEvents() {
    const on = (id, evt, fn) => el(id)?.addEventListener(evt, fn);

    // 设置项：改完就存
    [
        'fw-enabled', 'fw-chunk-size', 'fw-api-url', 'fw-api-key', 'fw-api-model',
        'fw-inj-pos', 'fw-inj-depth', 'fw-inj-budget', 'fw-future-enabled',
        'fw-branch-count', 'fw-target-words',
    ].forEach(id => on(id, 'change', readSettingsFromUI));
    on('fw-inj-budget', 'input', readSettingsFromUI);

    // 书管理
    on('fw-story-select', 'change', e => loadStoryById(e.target.value));
    on('fw-story-create', 'click', () => {
        const titleNode = el('fw-story-title');
        createStory(titleNode?.value?.trim() || '');
        if (titleNode) titleNode.value = '';
    });
    on('fw-story-delete', 'click', () => {
        if (!story) return;
        if (!window.confirm(`删除《${story.title}》？它的清洗结果、总结、伏笔会一起消失。`)) return;
        fwDeleteStory(story.id);
        story = null;
        const next = fwListStories()[0];
        if (next) {
            loadStoryById(next.id);
        } else {
            renderStorySelect();
            renderStats();
            setMsg('fw-clean-msg', '已删除。');
        }
    });
    on('fw-export', 'click', exportAllStories);
    on('fw-import-btn', 'click', () => el('fw-import-file')?.click());
    on('fw-import-file', 'change', async e => {
        const file = e.target.files?.[0];
        if (file) await importAllStories(file);
        e.target.value = '';
    });

    // 导入 TXT
    on('fw-txt-file', 'change', async e => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!story) createStory(file.name.replace(/\.txt$/i, ''));
        await importTxtFile(file);
        e.target.value = '';
    });

    // 清洗
    on('fw-clean-btn', 'click', () => { void runClean(); });
    on('fw-clean-stop', 'click', () => {
        cleanStop = true;
        setMsg('fw-clean-msg', '已请求停止：当前这一段收完就停。');
    });

    // 注入
    on('fw-preview-btn', 'click', renderPreview);

    // 进度
    on('fw-stage-idx', 'change', () => setProgress(el('fw-stage-idx')?.value, getProgress().nodeIdx));
    on('fw-node-idx', 'change', () => setProgress(getProgress().stageIdx, el('fw-node-idx')?.value));
    on('fw-advance', 'click', () => {
        const p = getProgress();
        setProgress(p.stageIdx, p.nodeIdx + 1);
        renderStats();
        setMsg('fw-write-msg', `已推进到第 ${p.stageIdx} 阶段、节点 ${p.nodeIdx + 1}。`, 'ok');
    });

    // 续写
    on('fw-continue-btn', 'click', () => { void runContinuation(); });
    on('fw-polish-btn', 'click', () => { void runPolish(); });
    on('fw-draft-clear', 'click', () => {
        const draft = el('fw-draft');
        if (draft) draft.value = '';
        persistDraft();
        setMsg('fw-write-msg', '草稿已清空。');
    });
    on('fw-draft', 'input', scheduleDraftSave);

    // 工作台：开关 + 分页切换（分页按钮用模板里的固定 id，静态扫描也查得到）
    on('fw-open-workshop', 'click', () => openWorkshop());
    on('fw-close-workshop', 'click', closeWorkshop);
    on('fw-workshop-mask', 'click', closeWorkshop);
    FW_PANES.forEach(p => on(`fw-nav-${p}`, 'click', () => {
        currentPane = showPane(p);
    }));
}

// ─────────────────────────── 初始化 ───────────────────────────

/** 自己取模板：不依赖 renderExtensionTemplateAsync，装到任意目录名下都能用 */
async function loadTemplateHtml() {
    const res = await fetch(new URL('./template.html', import.meta.url));
    if (!res.ok) throw new Error(`template.html 加载失败：HTTP ${res.status}`);
    return res.text();
}

async function init() {
    loadSettings();

    const html = await loadTemplateHtml();
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) {
        console.warn('[续写工坊] 找不到扩展设置容器，面板未挂载。');
        return;
    }
    const holder = document.createElement('div');
    holder.innerHTML = html;
    // 抽屉里只留入口卡片：先整体挂进设置容器，再把全屏工作台搬到 body。
    // 不搬的话，抽屉一关闭（或容器有 overflow / transform），全屏层会跟着被隐藏或裁切。
    host.appendChild(holder.firstElementChild || holder);
    const overlay = el('fw-workshop');
    if (overlay && document.body) document.body.appendChild(overlay);

    syncSettingsToUI();
    bindPanelEvents();
    showPane('kb');
    document.addEventListener('keydown', evt => {
        if (evt?.key === 'Escape' && isWorkshopOpen()) closeWorkshop();
    });
    registerChatHooks();

    const activeId = fwGetActiveStoryId();
    if (activeId && fwLoadStory(activeId)) {
        loadStoryById(activeId);
    } else {
        renderStorySelect();
        renderStats();
    }
    console.log('[续写工坊] 已加载，书库共', fwListStories().length, '本');
}

jQuery(async () => {
    try {
        await init();
    } catch (e) {
        console.error('[续写工坊] 初始化失败：', e);
    }
});
