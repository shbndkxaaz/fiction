/**
 * 假 DOM + 假 localStorage：只为让 `index.js` 能在 Node 里跑一遍。
 *
 * 装配层最贵的 bug 是「加载即白屏」——这层桩子能把 init()/按钮事件/注入钩子真的执行一次，
 * 而不是只做静态扫描。不要往这里加浏览器行为，缺什么补什么，保持最小。
 */
class FakeElement {
    constructor(tag = 'div') {
        this.tagName = String(tag).toUpperCase();
        this.id = '';
        this.children = [];
        this.style = {};
        this.dataset = {};
        this.listeners = Object.create(null);
        this.className = '';
        this.textContent = '';
        this.type = '';
        this.checked = false;
        this.files = null;
        this._value = '';
        this._html = '';
    }

    get value() { return this._value; }
    set value(v) { this._value = v == null ? '' : String(v); }

    get innerHTML() { return this._html; }
    set innerHTML(html) {
        this._html = String(html == null ? '' : html);
        this.children = [];
        // 模板塞进来的时候，把里面的 id 全部登记进 registry（真浏览器由解析器做这件事）
        if (this._html && htmlSink) htmlSink(this._html);
    }

    get firstElementChild() { return this.children[0] || null; }

    appendChild(node) { this.children.push(node); return node; }
    append(...nodes) { this.children.push(...nodes); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) {
        const list = this.listeners[type];
        if (list) this.listeners[type] = list.filter(item => item !== fn);
    }
    dispatchEvent(evt) {
        const type = typeof evt === 'string' ? evt : evt?.type;
        for (const fn of this.listeners[type] || []) fn(evt);
        return true;
    }
    focus() {}
    click() { this.dispatchEvent({ type: 'click', target: this }); }
    remove() {}
}

/** localStorage 内容（真 Map，测试里可以直接检查落盘结果） */
export const storage = new Map();

/** 模板 html 里每发现一个 id，就往这里丢 */
let htmlSink = null;

/** 从 html 文本里扒出带 id 的标签，造出对应的假元素 */
function harvest(html, register) {
    for (const m of String(html).matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/g)) {
        const tag = m[1].toLowerCase();
        const attrs = m[2] || '';
        const idMatch = attrs.match(/\bid="([^"]+)"/);
        if (!idMatch) continue;
        const node = new FakeElement(tag);
        node.id = idMatch[1];
        const type = attrs.match(/\btype="([^"]+)"/);
        if (type) node.type = type[1];
        const value = attrs.match(/\bvalue="([^"]*)"/);
        if (value) node.value = value[1];
        if (/\bchecked\b/.test(attrs)) node.checked = true;
        register(node);
    }
}

/**
 * 装好全局桩子（document / window / localStorage / URL.createObjectURL）。
 * @returns {{registry:Map, settingsHost:FakeElement, sendBox:FakeElement}}
 */
export function installDom() {
    const registry = new Map();
    htmlSink = html => harvest(html, node => registry.set(node.id, node));

    const sendBox = new FakeElement('textarea');
    sendBox.id = 'send_textarea';

    const settingsHost = new FakeElement('div');
    settingsHost.id = 'extensions_settings2';
    registry.set(settingsHost.id, settingsHost);

    const document = {
        getElementById: id => registry.get(id) || null,
        createElement: tag => new FakeElement(tag),
        querySelector: sel => (String(sel).includes('send_textarea') ? sendBox : null),
        body: new FakeElement('body'),
        addEventListener() {},
        removeEventListener() {},
    };

    globalThis.document = document;
    globalThis.window = globalThis.window || {};
    globalThis.window.confirm = () => true;
    globalThis.localStorage = {
        getItem: key => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => { storage.set(key, String(value)); },
        removeItem: key => { storage.delete(key); },
        clear: () => storage.clear(),
    };
    if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:fake';
    if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};

    return { registry, settingsHost, sendBox };
}

/** 让排队的 Promise / setTimeout(0) 都跑完（async 事件处理器没法直接 await） */
export async function flush(rounds = 6) {
    for (let i = 0; i < rounds; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

/** 派发一个 DOM 事件（带 target，模拟用户操作） */
export function fire(node, type, extra = {}) {
    return node.dispatchEvent({ type, target: node, ...extra });
}

export { FakeElement };
