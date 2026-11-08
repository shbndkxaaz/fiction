/**
 * 续写工坊 · 外部 API 调用（OpenAI 兼容 chat/completions）
 *
 * 沿用两个上游的共同做法：插件自己配置地址 + Key + 模型，直接 fetch（不经过酒馆代理），
 * 地址容错逻辑取自 novel-injector `lib/offscreen-system.js` 的 niNormalizeChatEndpoint。
 *
 * 这里只放「纯函数 + 一个 fetch 封装」；Node 测试只测纯函数部分。
 */

/**
 * 把用户填的地址补成完整的 chat/completions 端点。
 * 允许填：裸域名 / 以 /v1 结尾 / /v1/models / 完整端点。
 * @param {string} url
 * @returns {string} 空输入返回空字符串
 */
export function fwNormalizeChatEndpoint(url) {
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    let u = raw.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(u)) return u;
    if (/\/v1$/i.test(u)) return `${u}/chat/completions`;
    if (/\/v1\/models$/i.test(u)) return u.replace(/\/models$/i, '/chat/completions');
    return `${u}/v1/chat/completions`;
}

/** 组装请求头：Key 可以带也可以不带 "Bearer " 前缀 */
export function fwBuildHeaders(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    const key = String(apiKey ?? '').trim();
    if (key) headers.Authorization = key.startsWith('Bearer ') ? key : `Bearer ${key}`;
    return headers;
}

/**
 * 从 chat/completions 响应里取文本。兼容：
 * - OpenAI: choices[0].message.content（可能是字符串，也可能是 [{type,text}] 数组）
 * - 部分中转: choices[0].text / content 直接是数组
 * @param {any} data
 * @returns {string}
 */
export function fwExtractChatText(data) {
    const choice = data?.choices?.[0];
    let content = choice?.message?.content ?? choice?.text ?? data?.content ?? '';
    if (Array.isArray(content)) {
        content = content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
    }
    return String(content || '').trim();
}

/**
 * 调用一次 chat/completions。
 * 失败时抛出的 Error 带 `status`，调用方据此决定是否重试（与 xu-xie-ji 的重试链一致）。
 *
 * @param {{url:string, apiKey?:string, model:string, messages:any[],
 *          temperature?:number, maxTokens?:number, timeoutMs?:number}} opts
 * @returns {Promise<string>} 模型回复文本
 */
export async function fwCallChatCompletion(opts = {}) {
    const endpoint = fwNormalizeChatEndpoint(opts.url);
    if (!endpoint) throw new Error('未配置 API 地址');
    const model = String(opts.model || '').trim();
    if (!model) throw new Error('未配置模型名');

    const timeoutMs = Math.max(5000, parseInt(opts.timeoutMs, 10) || 300000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: fwBuildHeaders(opts.apiKey),
            signal: controller.signal,
            body: JSON.stringify({
                model,
                messages: Array.isArray(opts.messages) ? opts.messages : [],
                temperature: Number.isFinite(Number(opts.temperature)) ? Number(opts.temperature) : 0.7,
                max_tokens: Math.max(256, parseInt(opts.maxTokens, 10) || 4096),
                stream: false,
            }),
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            const err = new Error(`API HTTP ${response.status}${errText ? `：${errText.slice(0, 300)}` : ''}`);
            err.status = response.status;
            throw err;
        }

        const data = await response.json();
        const text = fwExtractChatText(data);
        if (!text) {
            const err = new Error('API 返回内容为空');
            err.status = response.status;
            throw err;
        }
        return text;
    } catch (e) {
        if (e?.name === 'AbortError') {
            const err = new Error(`API 超时（${Math.round(timeoutMs / 1000)}s）`);
            err.status = 0;
            throw err;
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}
