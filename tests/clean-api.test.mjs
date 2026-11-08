/**
 * lib/clean-api.js 的纯函数部分：端点补全、请求头、响应文本提取。
 * （真实 fetch 不在这里测，避免测试依赖网络。）
 */
import { group, eq, truthy, finish } from './_assert.mjs';
import { pluginUrl } from './_paths.mjs';

const { fwNormalizeChatEndpoint, fwBuildHeaders, fwExtractChatText } = await import(pluginUrl('lib/clean-api.js'));

group('A. 端点补全', () => {
    eq('A1 裸域名补 /v1/chat/completions', fwNormalizeChatEndpoint('https://api.x.com'), 'https://api.x.com/v1/chat/completions');
    eq('A2 以 /v1 结尾补后缀', fwNormalizeChatEndpoint('https://api.x.com/v1'), 'https://api.x.com/v1/chat/completions');
    eq('A3 /v1/models 改写', fwNormalizeChatEndpoint('https://api.x.com/v1/models'), 'https://api.x.com/v1/chat/completions');
    eq('A4 已是完整端点不变', fwNormalizeChatEndpoint('https://api.x.com/v1/chat/completions'), 'https://api.x.com/v1/chat/completions');
    eq('A5 去尾斜杠', fwNormalizeChatEndpoint('https://api.x.com/v1/'), 'https://api.x.com/v1/chat/completions');
    eq('A6 空值返回空串', fwNormalizeChatEndpoint(''), '');
    eq('A7 null 返回空串', fwNormalizeChatEndpoint(null), '');
    eq('A8 自定义路径保留', fwNormalizeChatEndpoint('https://gw.example.com/openai'), 'https://gw.example.com/openai/v1/chat/completions');
});

group('B. 请求头', () => {
    eq('B1 无 Key 只有 Content-Type', fwBuildHeaders(''), { 'Content-Type': 'application/json' });
    eq('B2 裸 Key 自动加 Bearer', fwBuildHeaders('sk-abc').Authorization, 'Bearer sk-abc');
    eq('B3 已带 Bearer 不重复加', fwBuildHeaders('Bearer sk-abc').Authorization, 'Bearer sk-abc');
});

group('C. 响应文本提取', () => {
    eq('C1 OpenAI 标准结构', fwExtractChatText({ choices: [{ message: { content: '正文' } }] }), '正文');
    eq('C2 兼容 text 字段', fwExtractChatText({ choices: [{ text: '正文2' }] }), '正文2');
    eq('C3 数组内容拼接', fwExtractChatText({ choices: [{ message: { content: [{ text: '甲' }, { text: '乙' }] } }] }), '甲乙');
    eq('C4 空响应返回空串', fwExtractChatText({}), '');
    truthy('C5 去掉首尾空白', fwExtractChatText({ choices: [{ message: { content: '  x  ' } }] }) === 'x');
});

finish('clean-api.test.mjs');
