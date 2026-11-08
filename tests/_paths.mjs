/**
 * 测试公共路径助手（照搬 novel-injector `tests/_paths.mjs` 的约定）。
 * 所有测试都用它定位插件根目录，**与当前工作目录无关**：
 * 不管是从仓库根跑 `node tests/xxx.test.mjs`，还是在扩展目录里跑 `node tests/run-all.mjs`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 本文件所在目录：<plugin>/tests */
export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 插件根目录 */
export const PLUGIN_ROOT = path.resolve(TESTS_DIR, '..');

/** 拼插件内路径，例如 pluginPath('lib/kb.js') */
export function pluginPath(...parts) {
    return path.join(PLUGIN_ROOT, ...parts);
}

/** 读插件内文本文件（UTF-8） */
export function readPlugin(...parts) {
    return fs.readFileSync(pluginPath(...parts), 'utf8');
}

/** 插件内文件的 file:// URL，供动态 import 使用 */
export function pluginUrl(...parts) {
    return pathToFileURL(pluginPath(...parts)).href;
}
