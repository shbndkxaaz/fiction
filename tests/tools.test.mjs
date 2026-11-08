/**
 * tools/install.mjs 的测试：文件清单、zip 结构、参数解析、落点推导。
 * 这些是「装不进酒馆 / 手机上传」时最直接的护栏。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq, ok, truthy, group, finish } from './_assert.mjs';
import { PLUGIN_ROOT, pluginPath, pluginUrl } from './_paths.mjs';

const tools = await import(pluginUrl('tools/install.mjs'));

group('G. 运行时要带走的文件', () => {
    eq('G1 关键文件齐全（缺一个酒馆就报 manifest 缺失）', tools.missingRuntimeFiles(PLUGIN_ROOT), []);

    const files = tools.listRuntimeFiles(PLUGIN_ROOT);
    ok('G2 清单含 manifest.json', files.includes('manifest.json'));
    ok('G3 清单含 index.js', files.includes('index.js'));
    ok('G4 清单含 template.html / style.css', files.includes('template.html') && files.includes('style.css'));

    const libs = fs.readdirSync(pluginPath('lib')).filter(f => f.endsWith('.js'));
    ok('G5 lib/ 下所有 .js 都在清单里（index.js 依赖它们）',
        libs.every(f => files.includes(`lib/${f}`)),
        `缺：${libs.filter(f => !files.includes(`lib/${f}`)).join(', ')}`);
    ok('G6 清单里没有 tests/ 或 docs/（别把 200KB 的测试塞进酒馆）',
        !files.some(f => f.startsWith('tests/') || f.startsWith('docs/')));
    ok('G7 清单里每个文件真实存在', files.every(f => fs.existsSync(pluginPath(...f.split('/')))));
});

group('H. ZIP 打包（手机上传用）', () => {
    const entries = tools.collectZipEntries({ root: PLUGIN_ROOT, name: 'fiction-weaver' });
    ok('H1 条目名带顶层目录', entries.every(e => e.name.startsWith('fiction-weaver/')));
    ok('H2 manifest 在 zip 顶层目录下', entries.some(e => e.name === 'fiction-weaver/manifest.json'));

    const buf = tools.makeZip(entries);
    eq('H3 以本地文件头 PK\\x03\\x04 开头', buf.subarray(0, 4).toString('hex'), '504b0304');
    eq('H4 以 EOCD PK\\x05\\x06 结尾', buf.subarray(-22, -18).toString('hex'), '504b0506');
    eq('H5 EOCD 记录条目数', buf.readUInt16LE(buf.length - 22 + 10), entries.length);
    ok('H6 每个文件名都写进了 zip', entries.every(e => buf.includes(Buffer.from(e.name, 'utf8'))));

    eq('H7 CRC32 对空串是 0', tools.crc32(Buffer.alloc(0)), 0);
    eq('H8 CRC32 对 "123456789" 是标准值 0xCBF43926', tools.crc32(Buffer.from('123456789')), 0xcbf43926);
});

group('I. 参数与落点推导', () => {
    const p1 = tools.parseArgs(['C:\\SillyTavern', '--global', '--name', 'fw-test']);
    eq('I1 路径 + --global', [p1.stDir, p1.global, p1.name], ['C:\\SillyTavern', true, 'fw-test']);

    const p2 = tools.parseArgs(['/opt/st', '--dry-run']);
    eq('I2 --dry-run 不写盘', [p2.stDir, p2.dryRun], ['/opt/st', true]);

    const p3 = tools.parseArgs(['--zip']);
    eq('I3 裸 --zip 用默认文件名', p3.zip, true);
    const p4 = tools.parseArgs(['--zip', 'out/fw.zip']);
    eq('I4 --zip 带路径时吃掉下一个参数', [p4.zip, p4.stDir], ['out/fw.zip', '']);

    const p5 = tools.parseArgs([]);
    eq('I5 无参数时 stDir 为空（走帮助）', p5.stDir, '');

    // 用临时目录伪造一个酒馆根目录
    const st = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-st-'));
    const target = tools.resolveTargetDir(st, { global: true });
    ok('I6 --global 落到 public/scripts/extensions/third-party/', target.replace(/\\/g, '/').endsWith('public/scripts/extensions/third-party/fiction-weaver'));
    try {
        tools.resolveTargetDir(st, {});
        ok('I7 没有 data/ 时报错（防指错目录）', false, '应该抛错');
    } catch (e) {
        truthy('I7 没有 data/ 时报错（防指错目录）', /data/.test(e.message));
    }

    fs.mkdirSync(path.join(st, 'data', 'default-user'), { recursive: true });
    const localTarget = tools.resolveTargetDir(st, {});
    ok('I8 只有一个用户时自动选它', localTarget.replace(/\\/g, '/').endsWith('data/default-user/extensions/third-party/fiction-weaver'));
    fs.mkdirSync(path.join(st, 'data', 'second-user'), { recursive: true });
    try {
        tools.resolveTargetDir(st, {});
        ok('I9 多用户时必须显式 --user', false, '应该抛错');
    } catch (e) {
        truthy('I9 多用户时必须显式 --user', /--user/.test(e.message));
    }
    ok('I10 --user 指定后可用', tools.resolveTargetDir(st, { user: 'second-user' }).replace(/\\/g, '/').endsWith('data/second-user/extensions/third-party/fiction-weaver'));

    fs.rmSync(st, { recursive: true, force: true });
});

finish('tools.test.mjs');
