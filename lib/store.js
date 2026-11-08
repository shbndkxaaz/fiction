/**
 * 续写工坊 · 存储层（localStorage，书维度）
 *
 * 设计取舍（见 docs/03-merged-architecture.md 第 4 节）：
 * - 学 xu-xie-ji：数据挂在「书（story）」维度，一本小说可跨多个聊天/多个章节；
 * - 不学 novel-injector 的 chat_metadata 存全量数据：chat 只存进度指针（在 index.js 里）。
 *
 * 所有函数都做了 try/catch 兜底：隐私模式 / 配额满时返回空值而不是把插件打挂。
 */

const LS_PREFIX = 'fiction_weaver';
const LS_STORY_LIST = `${LS_PREFIX}_story_list`;
const LS_ACTIVE = `${LS_PREFIX}_active_story`;
const storyKey = id => `${LS_PREFIX}_story_${id}`;

/** 安全读取 localStorage（Node 环境下没有 localStorage，返回 null） */
function safeGet(key) {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function safeSet(key, value) {
    try {
        if (typeof localStorage === 'undefined') return false;
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        console.warn('[续写工坊] localStorage 写入失败（可能超额或隐私模式）：', e);
        return false;
    }
}

function safeRemove(key) {
    try {
        if (typeof localStorage === 'undefined') return false;
        localStorage.removeItem(key);
        return true;
    } catch {
        return false;
    }
}

/** 读 JSON，坏数据自动丢弃（宁可丢一本书，也不要让插件起不来） */
function readJson(key, fallback) {
    const raw = safeGet(key);
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.warn(`[续写工坊] ${key} 解析失败，已忽略：`, e);
        return fallback;
    }
}

/**
 * 书列表：[{ id, title, totalChars, updatedAt }]
 * @returns {{id:string,title:string,totalChars?:number,updatedAt?:number}[]}
 */
export function fwListStories() {
    const list = readJson(LS_STORY_LIST, []);
    return Array.isArray(list) ? list.filter(item => item && item.id) : [];
}

/** 写入书列表（内部用） */
function writeStoryList(list) {
    safeSet(LS_STORY_LIST, JSON.stringify(Array.isArray(list) ? list : []));
}

/** 把一本书记录同步进列表（保存 story 时顺带调用） */
function touchStoryList(story) {
    if (!story?.id) return;
    const list = fwListStories().filter(item => item.id !== story.id);
    list.push({
        id: story.id,
        title: story.title || '未命名小说',
        totalChars: story.source?.totalChars || 0,
        updatedAt: story.updatedAt || Date.now(),
    });
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    writeStoryList(list);
}

/**
 * 读一本书。
 * @param {string} id
 * @returns {object|null}
 */
export function fwLoadStory(id) {
    if (!id) return null;
    const story = readJson(storyKey(id), null);
    return story && story.id ? story : null;
}

/**
 * 存一本书（并顺手更新列表与 updatedAt）。
 * @param {object} story
 * @returns {boolean}
 */
export function fwSaveStory(story) {
    if (!story?.id) return false;
    story.updatedAt = Date.now();
    const ok = safeSet(storyKey(story.id), JSON.stringify(story));
    if (ok) touchStoryList(story);
    return ok;
}

/**
 * 删一本书（只删数据和列表项，不动别的书）。
 * @param {string} id
 */
export function fwDeleteStory(id) {
    if (!id) return false;
    safeRemove(storyKey(id));
    writeStoryList(fwListStories().filter(item => item.id !== id));
    if (fwGetActiveStoryId() === id) safeRemove(LS_ACTIVE);
    return true;
}

/** 当前选中的书 id */
export function fwGetActiveStoryId() {
    return safeGet(LS_ACTIVE) || '';
}

/** 切换当前书 */
export function fwSetActiveStoryId(id) {
    if (!id) {
        safeRemove(LS_ACTIVE);
        return false;
    }
    return safeSet(LS_ACTIVE, id);
}

/**
 * 取当前书；没有就返回 null（不自动建书，交由调用方决定）。
 * @returns {object|null}
 */
export function fwLoadActiveStory() {
    const id = fwGetActiveStoryId();
    if (!id) return null;
    const story = fwLoadStory(id);
    if (!story) {
        safeRemove(LS_ACTIVE);
        return null;
    }
    return story;
}

/** 导出用：全部书的 JSON（设置页「导出」按钮） */
export function fwExportAll() {
    return {
        version: 1,
        exportedAt: Date.now(),
        stories: fwListStories().map(item => fwLoadStory(item.id)).filter(Boolean),
    };
}

/**
 * 导入：按 id 覆盖写入，返回导入数量。
 * @param {{stories?:object[]}|object[]} payload
 */
export function fwImportAll(payload) {
    const stories = Array.isArray(payload) ? payload : (payload?.stories || []);
    let count = 0;
    stories.forEach(story => {
        if (!story?.id) return;
        if (fwSaveStory(story)) count += 1;
    });
    return count;
}
