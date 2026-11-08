/**
 * `/script.js` 的桩子：事件系统 + 设置保存 + chat_metadata。
 */
export const event_types = {
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    CHAT_CHANGED: 'chat_changed',
};

export const eventSource = {
    handlers: new Map(),
    on(type, fn) {
        const list = this.handlers.get(type) || [];
        list.push(fn);
        this.handlers.set(type, list);
    },
    removeListener(type, fn) {
        const list = this.handlers.get(type) || [];
        this.handlers.set(type, list.filter(item => item !== fn));
    },
};

export const chat_metadata = {};

let saveCount = 0;
export const saveSettingsDebounced = () => { saveCount += 1; };
export const __saveCount = () => saveCount;

/** 手动触发一个酒馆事件（测试里模拟「发送消息前」） */
export function __emit(type, data) {
    const results = [];
    for (const fn of eventSource.handlers.get(type) || []) results.push(fn(data));
    return results;
}
