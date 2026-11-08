#!/usr/bin/env node
/**
 * 串行跑 tests/ 下所有 *.test.mjs，汇总通过/失败数量。
 *
 * 用法：
 *   node tests/run-all.mjs            # 跑全套
 *   node tests/run-all.mjs kb inj     # 只跑文件名包含关键字的（调试用）
 *
 * 退出码：全部通过 = 0，任一失败（或超时、崩溃）= 1。
 * 与上游 novel-injector 的 tests/run-all.mjs 同一套玩法：零依赖、串行、exit code 即门禁。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TESTS_DIR } from './_paths.mjs';

const TIMEOUT_MS = 5 * 60 * 1000;
const filters = process.argv.slice(2).filter(a => !a.startsWith('-'));
const all = fs.readdirSync(TESTS_DIR).filter(f => f.endsWith('.test.mjs')).sort();
const files = filters.length ? all.filter(f => filters.some(k => f.includes(k))) : all;

if (!files.length) {
    console.error(filters.length
        ? `没有匹配 ${JSON.stringify(filters)} 的 *.test.mjs`
        : `在 ${TESTS_DIR} 下没有找到 *.test.mjs`);
    process.exit(1);
}

const secs = ms => (ms / 1000).toFixed(1) + 's';

function runOne(file) {
    return new Promise(resolve => {
        const started = Date.now();
        const child = spawn(process.execPath, [path.join(TESTS_DIR, file)], {
            cwd: TESTS_DIR,
            stdio: 'inherit',
            windowsHide: true,
        });
        let settled = false;
        const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ file, ms: Date.now() - started, ...result });
        };
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
            finish({ code: null, reason: `超时 ${TIMEOUT_MS / 1000}s，已强杀` });
        }, TIMEOUT_MS);
        child.on('error', err => finish({ code: null, reason: `无法启动：${err.message}` }));
        child.on('exit', (code, signal) => {
            finish({ code, reason: code === 0 ? '' : (signal ? `被信号 ${signal} 终止` : `退出码 ${code}`) });
        });
    });
}

console.log(`\n=== 续写工坊 测试套件：${files.length} 个文件，串行执行 ===\n`);

const results = [];
const t0 = Date.now();
for (let i = 0; i < files.length; i++) {
    const file = files[i];
    console.log(`\n───── [${i + 1}/${files.length}] ${file} ─────`);
    const r = await runOne(file);
    results.push(r);
    console.log(r.code === 0
        ? `───── ✅ ${file} 通过（${secs(r.ms)}）`
        : `───── ❌ ${file} 失败（${secs(r.ms)}）：${r.reason}`);
}

const failed = results.filter(r => r.code !== 0);
const total = Date.now() - t0;

console.log('\n════════════════════════════════════════════════════');
console.log(`通过 ${results.length - failed.length} / ${results.length}，失败 ${failed.length}，总用时 ${secs(total)}`);
if (failed.length) {
    console.log('\n失败清单：');
    for (const r of failed) console.log(`  ❌ ${r.file} —— ${r.reason}`);
} else {
    console.log('全部通过 ✅');
}
console.log('════════════════════════════════════════════════════\n');

process.exit(failed.length ? 1 : 0);
