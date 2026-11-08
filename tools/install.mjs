#!/usr/bin/env node
/**
 * 续写工坊 安装 / 打包工具（零依赖）
 *
 * 用法：
 *   node tools/install.mjs <SillyTavern 目录>              # 装到 data/<用户>/extensions/third-party/fiction-weaver
 *   node tools/install.mjs <SillyTavern 目录> --global     # 装到 public/scripts/extensions/third-party/fiction-weaver
 *   node tools/install.mjs <SillyTavern 目录> --user main  # data 下有多个用户目录时指定
 *   node tools/install.mjs <SillyTavern 目录> --dry-run    # 只打印将要做什么
 *   node tools/install.mjs --zip                           # 打 fiction-weaver.zip（传手机用）
 *   node tools/install.mjs --zip D:\tmp\fw.zip             # 指定输出路径
 *
 * 为什么需要它：酒馆的「安装扩展功能」只接受 http(s) 的 git 地址，
 * 会把仓库 clone 到 third-party/<仓库名>/，再要求 manifest.json 就在仓库根目录。
 * 本地这份还没有远端仓库时，只能手动复制（本工具）或打包后在手机上解压。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 扩展根目录（= tools/ 的上一层） */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 少了任何一个都不算可用的扩展 */
export const REQUIRED_RUNTIME_FILES = ['manifest.json', 'index.js', 'style.css', 'template.html'];

/** 装进酒馆后无关紧要、但带上更方便排查的文件 */
const EXTRA_RUNTIME_FILES = ['README.md'];

/** 默认装成的目录名 */
export const DEFAULT_FOLDER_NAME = 'fiction-weaver';

/**
 * 列出要安装/打包的文件（posix 相对路径，已排序）。
 * lib/ 下全部 .js 都要带走——index.js 会 import 它们。
 * @param {string} [root]
 * @returns {string[]}
 */
export function listRuntimeFiles(root = ROOT) {
    /** @type {string[]} */
    const files = [];
    for (const f of REQUIRED_RUNTIME_FILES) {
        if (fs.existsSync(path.join(root, f))) files.push(f);
    }
    const libDir = path.join(root, 'lib');
    if (fs.existsSync(libDir)) {
        for (const f of fs.readdirSync(libDir).sort()) {
            if (f.endsWith('.js')) files.push(`lib/${f}`);
        }
    }
    for (const f of EXTRA_RUNTIME_FILES) {
        if (fs.existsSync(path.join(root, f))) files.push(f);
    }
    return files;
}

/**
 * 缺了哪些必需文件（空数组 = 完整）
 * @param {string} [root]
 * @returns {string[]}
 */
export function missingRuntimeFiles(root = ROOT) {
    return REQUIRED_RUNTIME_FILES.filter(f => !fs.existsSync(path.join(root, f)));
}

/**
 * 解析酒馆根目录 → 扩展落点。
 * 本地：<ST>/data/<用户>/extensions/third-party/<name>
 * 全局：<ST>/public/scripts/extensions/third-party/<name>
 * @param {string} stDir 酒馆根目录
 * @param {{global?:boolean, name?:string, user?:string}} [opts]
 * @returns {string}
 */
export function resolveTargetDir(stDir, opts = {}) {
    const { global = false, name = DEFAULT_FOLDER_NAME, user } = opts;
    const safeName = name.replace(/[\\/:*?"<>|]/g, '');
    if (!safeName) throw new Error('目录名不合法');
    if (global) {
        return path.join(stDir, 'public', 'scripts', 'extensions', 'third-party', safeName);
    }
    const dataDir = path.join(stDir, 'data');
    if (!fs.existsSync(dataDir)) {
        throw new Error(`${dataDir} 不存在——这不像是 SillyTavern 根目录（应包含 data/ 和 public/）`);
    }
    const users = fs.readdirSync(dataDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    const picked = user || (users.length === 1 ? users[0] : '');
    if (!picked) {
        throw new Error(`data/ 下有多个用户目录（${users.join(', ') || '无'}），请加 --user <名字>`);
    }
    if (user && !users.includes(user)) {
        throw new Error(`data/ 下没有用户目录 ${user}（现有：${users.join(', ')}）`);
    }
    return path.join(dataDir, picked, 'extensions', 'third-party', safeName);
}

/**
 * 解析命令行参数
 * @param {string[]} argv 不含 node 和脚本名
 * @returns {{stDir:string, global:boolean, name:string, user:string, zip:boolean|string, dryRun:boolean, help:boolean}}
 */
export function parseArgs(argv) {
    const out = { stDir: '', global: false, name: DEFAULT_FOLDER_NAME, user: '', zip: false, dryRun: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--global') out.global = true;
        else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--zip') {
            const next = argv[i + 1];
            out.zip = next && !next.startsWith('-') ? (i++, next) : true;
        } else if (a === '--name') out.name = argv[++i] || DEFAULT_FOLDER_NAME;
        else if (a === '--user') out.user = argv[++i] || '';
        else if (!a.startsWith('-') && !out.stDir) out.stDir = a;
    }
    return out;
}

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

/**
 * CRC-32（ZIP 用）
 * @param {Buffer} buf
 * @returns {number}
 */
export function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function dosDateTime(d = new Date()) {
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
    const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
    return { time, date };
}

/**
 * 造一个 ZIP（store 模式，不压缩；文件才几十 KB，够用且零依赖）。
 * @param {{name:string, data:Buffer}[]} entries name 用 / 分隔
 * @returns {Buffer}
 */
export function makeZip(entries) {
    const { time, date } = dosDateTime();
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
        local.writeUInt16LE(20, 4);           // 解压所需版本
        local.writeUInt16LE(0x0800, 6);       // 文件名按 UTF-8
        local.writeUInt16LE(0, 8);            // 压缩方法 0 = store
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18); // 压缩后大小
        local.writeUInt32LE(data.length, 22); // 原始大小
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);           // extra 长度
        locals.push(local, nameBuf, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
        central.writeUInt16LE(20, 4);         // 创建者版本
        central.writeUInt16LE(20, 6);         // 解压所需版本
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);         // extra
        central.writeUInt16LE(0, 32);         // comment
        central.writeUInt16LE(0, 34);         // 起始磁盘
        central.writeUInt16LE(0, 36);         // 内部属性
        central.writeUInt32LE(0, 38);         // 外部属性
        central.writeUInt32LE(offset, 42);    // 本地头偏移
        centrals.push(central, nameBuf);

        offset += local.length + nameBuf.length + data.length;
    }

    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * 把运行时文件读成 zip 条目（顶层目录名 = name）
 * @param {{root?:string, name?:string}} [opts]
 * @returns {{name:string, data:Buffer}[]}
 */
export function collectZipEntries(opts = {}) {
    const { root = ROOT, name = DEFAULT_FOLDER_NAME } = opts;
    return listRuntimeFiles(root).map(rel => ({
        name: `${name}/${rel}`,
        data: fs.readFileSync(path.join(root, rel)),
    }));
}

function copyRuntimeFiles(root, targetDir, dryRun) {
    const files = listRuntimeFiles(root);
    for (const rel of files) {
        const from = path.join(root, rel);
        const to = path.join(targetDir, ...rel.split('/'));
        if (dryRun) {
            console.log(`  [dry-run] ${rel}`);
            continue;
        }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        console.log(`  ✓ ${rel}`);
    }
    return files.length;
}

const HELP = `
续写工坊 安装 / 打包工具

  node tools/install.mjs <SillyTavern 目录>            装到 data/<用户>/extensions/third-party/${DEFAULT_FOLDER_NAME}
  node tools/install.mjs <SillyTavern 目录> --global   装到 public/scripts/extensions/third-party/${DEFAULT_FOLDER_NAME}
  node tools/install.mjs <SillyTavern 目录> --user 名字  data 下有多个用户目录时指定
  node tools/install.mjs <SillyTavern 目录> --dry-run  只打印，不写盘
  node tools/install.mjs --zip [输出.zip]              打成 zip（传给手机上的酒馆用）

  装完刷新酒馆页面（Tauri / 手机端重启 App）→ 扩展 → 找到「续写工坊 Fiction Weaver」。
`;

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || (!args.stDir && !args.zip)) {
        console.log(HELP);
        return 0;
    }

    const missing = missingRuntimeFiles(ROOT);
    if (missing.length) {
        console.error(`❌ 源目录不完整，缺：${missing.join(', ')}（${ROOT}）`);
        return 1;
    }

    if (args.zip) {
        const out = path.resolve(typeof args.zip === 'string' ? args.zip : `${DEFAULT_FOLDER_NAME}.zip`);
        const entries = collectZipEntries({ root: ROOT, name: args.name });
        const buf = makeZip(entries);
        if (args.dryRun) {
            console.log(`[dry-run] 将写入 ${out}（${entries.length} 个文件，${(buf.length / 1024).toFixed(1)} KB）`);
            for (const e of entries) console.log(`  ${e.name}`);
            return 0;
        }
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, buf);
        console.log(`✅ 已打包 ${out}（${entries.length} 个文件，${(buf.length / 1024).toFixed(1)} KB）`);
        console.log('   解压后把整个目录放进酒馆的 extensions/third-party/ 下即可。');
        return 0;
    }

    let targetDir;
    try {
        targetDir = resolveTargetDir(args.stDir, { global: args.global, name: args.name, user: args.user });
    } catch (e) {
        console.error(`❌ ${e.message}`);
        return 1;
    }

    console.log(`\n源目录：${ROOT}`);
    console.log(`目标目录：${targetDir}${args.dryRun ? '（dry-run）' : ''}\n`);
    const n = copyRuntimeFiles(ROOT, targetDir, args.dryRun);
    if (args.dryRun) {
        console.log(`\n[dry-run] 共 ${n} 个文件，未写盘。`);
        return 0;
    }

    // 自检：manifest.json 必须能解析——酒馆就是卡在这一步报 "manifest.json is missing"
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, 'manifest.json'), 'utf8'));
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('不是 JSON 对象');
        console.log(`\n✅ 已安装 ${n} 个文件；manifest: ${manifest.display_name || '(无 display_name)'} v${manifest.version || '?'}`);
    } catch (e) {
        console.error(`\n❌ 目标目录里的 manifest.json 有问题：${e.message}`);
        return 1;
    }

    console.log('   下一步：刷新酒馆页面（Tauri / 手机端重启 App）→ 扩展 → 打开「续写工坊 Fiction Weaver」。');
    console.log('   列表里没出现的话，进「管理扩展」确认它没被禁用。');
    return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    try {
        process.exitCode = main();
    } catch (e) {
        console.error(`❌ ${e.message}`);
        process.exitCode = 1;
    }
}
