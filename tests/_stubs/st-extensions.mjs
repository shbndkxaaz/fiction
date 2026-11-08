/**
 * `/scripts/extensions.js` 的桩子（只在测试里被 index.js 替身 import）。
 */
export const extension_settings = {};

/** 假的酒馆运行上下文：测试里直接改这些字段来模拟聊天 */
export const __context = {
    chat: [],
    characters: [],
    name1: 'User',
    name2: 'Char',
    generateRaw: null,
};

export function getContext() {
    return __context;
}
