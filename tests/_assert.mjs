/**
 * 极简断言助手（零依赖，不引 node:test）。
 * 每个测试文件末尾调用 `finish()`，失败会以非零退出码结束进程。
 */
import assert from 'node:assert';

let passed = 0;

/** 打印一条通过的用例 */
export function ok(name, condition, detail = '') {
    if (condition) {
        passed += 1;
        console.log(`  ✅ ${name}`);
        return true;
    }
    console.error(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`);
    process.exitCode = 1;
    return false;
}

/** 严格相等 */
export function eq(name, actual, expected) {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    return ok(name, same, `实际 = ${JSON.stringify(actual)}\n     期望 = ${JSON.stringify(expected)}`);
}

/** 断言不抛错 */
export function noThrow(name, fn) {
    try {
        fn();
        return ok(name, true);
    } catch (e) {
        return ok(name, false, e?.message || String(e));
    }
}

/** 真值断言 */
export function truthy(name, value) {
    return ok(name, Boolean(value), `实际 = ${JSON.stringify(value)}`);
}

/** 跑一个用例块，捕获异常并记为失败（不让整份测试中断） */
export function group(title, fn) {
    console.log(`\n[${title}]`);
    try {
        fn();
    } catch (e) {
        console.error(`  ❌ ${title} 抛出异常：${e?.stack || e}`);
        process.exitCode = 1;
    }
}

/** 收尾：打印统计并按 exitCode 退出 */
export function finish(fileName = '') {
    if (process.exitCode) {
        console.error(`\n❌ ${fileName || '测试'} 有失败用例（通过 ${passed} 条）`);
    } else {
        console.log(`\n✅ ${fileName || '测试'} 全部通过（${passed} 条）`);
    }
    if (!process.exitCode) process.exitCode = 0;
}

// 让断言库也能直接用（需要更复杂断言时）
export { assert };
