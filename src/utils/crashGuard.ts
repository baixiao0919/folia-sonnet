// src/utils/crashGuard.ts
// 真机启动自检：旧 WebView 缺 API 时补上，并在渲染崩掉时把证据留在屏幕上，
// 避免只剩一片黑屏、无从排查。
//
// 模块顶层就跑 polyfill：index.tsx 把它放在第一个 import，保证后面加载的任何模块
// 都已经拿到补齐的 API。真机 WebView 版本往往比桌面 Chrome 旧一代，
// structuredClone / Object.hasOwn / Array.at / replaceAll 这些“现代 API”
// 在旧内核里是 undefined，而且是运行时才炸，打包和桌面浏览器都发现不了。

const globalScope = globalThis as Record<string, unknown> & typeof globalThis;

if (typeof globalScope.structuredClone !== 'function') {
    globalScope.structuredClone = ((value: unknown) => {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            // 含循环引用或函数时退化成原值：缺这个 API 的机器上，能跑比语义精确更重要。
            return value;
        }
    }) as typeof structuredClone;
}

if (typeof (Object as unknown as { hasOwn?: unknown }).hasOwn !== 'function') {
    (Object as unknown as { hasOwn: (target: object, key: PropertyKey) => boolean }).hasOwn = (target, key) =>
        Object.prototype.hasOwnProperty.call(target, key);
}

const arrayProto = Array.prototype as unknown as { at?: unknown };
if (typeof arrayProto.at !== 'function') {
    arrayProto.at = function at(this: unknown[], index: number) {
        const length = this.length;
        const offset = index < 0 ? length + index : index;
        if (offset < 0 || offset >= length) return undefined;
        return this[offset];
    };
}

const stringProto = String.prototype as unknown as { replaceAll?: unknown };
if (typeof stringProto.replaceAll !== 'function') {
    stringProto.replaceAll = function replaceAll(this: string, search: string, replacement: string) {
        return this.split(search).join(replacement);
    };
}

const PANEL_ID = 'folia-crash-panel';
const CRASHES: string[] = [];

const environmentLines = (): string[] => {
    const root = document.getElementById('root');
    let rootLine = '#root 不存在';
    if (root) {
        const rect = root.getBoundingClientRect();
        rootLine = `#root ${Math.round(rect.width)}x${Math.round(rect.height)}，子节点 ${root.children.length} 个`;
    }
    const capacity = (globalScope.Capacitor as { getPlatform?: () => string } | undefined)?.getPlatform?.();
    const htmlAttrs = Array.from(document.documentElement.attributes)
        .map((attr) => `${attr.name}="${attr.value}"`)
        .join(' ');

    return [
        `屏幕 ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
        rootLine,
        `可见文字 ${(document.body.innerText || '').trim().length} 字`,
        `平台 ${capacity ?? 'web'}｜html ${htmlAttrs || '(无属性)'}`,
        `UA ${navigator.userAgent}`,
    ];
};

const appendButton = (panel: HTMLElement, label: string, onClick: () => void) => {
    const button = document.createElement('button');
    button.textContent = label;
    button.style.cssText =
        'margin:14px 10px 0 0;padding:10px 26px;border-radius:999px;border:0;'
        + 'background:#fff;color:#000;font:600 13px system-ui,sans-serif;';
    button.addEventListener('click', onClick);
    panel.appendChild(button);
};

const showPanel = (title: string, lines: string[]): void => {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
    if (!document.body) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;overflow:auto;-webkit-overflow-scrolling:touch;'
        + 'background:#0b0b0f;color:#f4f4f5;padding:18px 16px 96px;'
        + 'font:12px/1.55 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;';
    panel.setAttribute('role', 'alert');

    const heading = document.createElement('div');
    heading.textContent = title;
    heading.style.cssText = 'font:600 15px/1.4 system-ui,sans-serif;color:#fca5a5;margin-bottom:12px;';
    panel.appendChild(heading);

    const body = document.createElement('div');
    body.textContent = lines.join('\n\n');
    panel.appendChild(body);

    appendButton(panel, '复制', () => {
        const text = `${title}\n\n${lines.join('\n\n')}`;
        void navigator.clipboard?.writeText(text).catch(() => {});
    });
    appendButton(panel, '关闭', () => panel.remove());

    document.body.appendChild(panel);
};

const record = (label: string, detail: string): void => {
    const entry = `${label}：${detail}`.trim();
    if (CRASHES.includes(entry)) return;
    CRASHES.push(entry);
    showPanel('Folia 启动异常（可以把这段截图发给开发者）', [...CRASHES, ...environmentLines()]);
};

/** 供 ErrorBoundary 调用：React 渲染期抛错时把错误摆到屏幕上。 */
export const reportCrash = (label: string, detail: string): void => record(label, detail);

const describeError = (value: unknown): string => {
    if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`.trim();
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value).slice(0, 600);
    } catch {
        return String(value);
    }
};

/**
 * 装上崩溃捕获与渲染自检。
 *
 * 自检放在 4 秒后：React 首帧正常的话，这时 #root 已经有内容且尺寸非零；
 * 如果根节点还是空的或者塌成 0 尺寸，说明界面根本没画出来 —— 把环境信息亮出来，
 * 比让用户对着黑屏描述“就是黑的”有用得多。
 */
export const installCrashGuard = (): void => {
    window.addEventListener('error', (event) => {
        const target = event.target as HTMLElement | null;
        // 资源加载失败（img/script）不冒泡到 window.onerror 的 message，单独记一条。
        if (!event.message && target && target !== (window as unknown as EventTarget)) {
            const source = target.getAttribute?.('src') ?? target.getAttribute?.('href') ?? '';
            record('资源加载失败', `${target.tagName} ${source}`);
            return;
        }
        record('运行时错误', `${event.message}\n${event.error instanceof Error ? event.error.stack ?? '' : ''}`.trim());
    }, true);

    window.addEventListener('unhandledrejection', (event) => {
        record('未处理的 Promise 拒绝', describeError(event.reason));
    });

    window.setTimeout(() => {
        const root = document.getElementById('root');
        if (!root) {
            record('界面空白', '#root 不存在');
            return;
        }
        const rect = root.getBoundingClientRect();
        const empty = root.children.length === 0;
        const collapsed = rect.width < 2 || rect.height < 2;
        if (empty || collapsed) {
            record('界面空白', '#root 没有画出内容');
        }
    }, 4000);
};
