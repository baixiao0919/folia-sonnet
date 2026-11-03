// src/services/onlineMusic/lxmusic/lxRuntime.ts
// 洛雪自定义音源的运行环境：在浏览器 / WebView 里复刻 LX 桌面端暴露给脚本的 globalThis.lx API。
// 脚本通过 on('request') 注册「拿播放地址 / 歌词 / 封面」的回调，我们通过它去取歌；
// 脚本通过 send('inited', {sources}) 声明它支持哪些平台。
//
// 安全说明：导入并运行用户自带的脚本，执行环境就是页面主线程。这是用户主动导入的自定义音源，
// 与 LX 客户端一致；脚本若是恶意来源则有风险（与在 LX 里导入同源）。后续可改为 Web Worker 隔离。

import type { LxLoadedSource, LxPlatformKey, LxRequestHandler, LxSourceMeta, LxSourcePlatformInfo } from './lxTypes';
import { validateLxScript } from './lxSourceParser';

const EVENT_NAMES = { inited: 'inited', request: 'request', updateAlert: 'updateAlert' } as const;

// ---------------------------------------------------------------------------
// 工具方法：MD5
// ---------------------------------------------------------------------------

const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const add32 = (a: number, b: number): number => ((a + b) & 0xffffffff) >>> 0;
const rotl = (x: number, c: number): number => ((x << c) | (x >>> (32 - c))) >>> 0;

/** 标准 MD5，输入按 UTF-8 处理，输出 32 位小写十六进制。 */
export const md5 = (input: string): string => {
    const bytes = Array.from(new TextEncoder().encode(input));
    const origBitLen = BigInt(bytes.length) * 8n;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0x00);
    for (let i = 0; i < 8; i++) bytes.push(Number((origBitLen >> BigInt(8 * i)) & 0xffn));

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

    for (let block = 0; block < bytes.length; block += 64) {
        const M = new Array<number>(16);
        for (let i = 0; i < 16; i++) {
            M[i] = (bytes[block + i * 4] | (bytes[block + i * 4 + 1] << 8) | (bytes[block + i * 4 + 2] << 16) | (bytes[block + i * 4 + 3] << 24)) >>> 0;
        }
        let a = a0, b = b0, c = c0, d = d0;
        for (let i = 0; i < 64; i++) {
            const K = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
            let f: number;
            let g: number;
            if (i < 16) { f = (b & c) | (~b & d); g = i; }
            else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
            else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
            else { f = c ^ (b | ~d); g = (7 * i + 9) % 16; }
            const temp = d;
            d = c; c = b;
            b = add32(b, rotl(add32(add32(a, f >>> 0), K), MD5_S[i]));
            a = temp;
        }
        a0 = add32(a0, a); b0 = add32(b0, b); c0 = add32(c0, c); d0 = add32(d0, d);
    }

    const hex = (n: number): string => {
        const s = (n >>> 0).toString(16).padStart(8, '0');
        // little-endian 字节序输出
        return s.slice(6, 8) + s.slice(4, 6) + s.slice(2, 4) + s.slice(0, 2);
    };
    return hex(a0) + hex(b0) + hex(c0) + hex(d0);
};

// ---------------------------------------------------------------------------
// 工具方法：Buffer 兼容
// ---------------------------------------------------------------------------

const bufferApi = {
    from(input: string | number[] | Uint8Array, encoding?: string): Uint8Array {
        if (typeof input === 'string') {
            const enc = (encoding || 'utf-8').toLowerCase();
            if (enc === 'hex') {
                const clean = input.replace(/[^0-9a-fA-F]/g, '');
                const out = new Uint8Array(clean.length >> 1);
                for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
                return out;
            }
            if (enc === 'base64') {
                const bin = atob(input);
                const out = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
                return out;
            }
            if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') {
                const out = new Uint8Array(input.length);
                for (let i = 0; i < input.length; i++) out[i] = input.charCodeAt(i) & 0xff;
                return out;
            }
            return new TextEncoder().encode(input);
        }
        if (Array.isArray(input)) return Uint8Array.from(input);
        return new Uint8Array(input);
    },
    bufToString(buffer: Uint8Array, format?: string): string {
        const enc = (format || 'utf-8').toLowerCase();
        if (enc === 'hex') return Array.from(buffer).map(b => b.toString(16).padStart(2, '0')).join('');
        if (enc === 'base64') {
            let s = '';
            for (let i = 0; i < buffer.length; i++) s += String.fromCharCode(buffer[i]);
            return btoa(s);
        }
        if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') {
            let s = '';
            for (let i = 0; i < buffer.length; i++) s += String.fromCharCode(buffer[i]);
            return s;
        }
        return new TextDecoder().decode(buffer);
    },
};

const cryptoApi = {
    md5,
    randomBytes(size: number): string {
        const arr = new Uint8Array(size);
        (globalThis.crypto ?? (window as { crypto?: Crypto }).crypto)?.getRandomValues?.(arr)
            ?? arr.forEach((_, i) => (arr[i] = Math.floor(Math.random() * 256)));
        return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    },
    aesEncrypt(): never {
        throw new Error('LX 运行时暂不支持 aesEncrypt（当前环境为浏览器，缺少同步 AES）。');
    },
    rsaEncrypt(): never {
        throw new Error('LX 运行时暂不支持 rsaEncrypt。');
    },
};

const zlibApi = {
    inflate(): never {
        throw new Error('LX 运行时暂不支持 zlib.inflate（需要 pako 等解压库）。');
    },
    deflate(): never {
        throw new Error('LX 运行时暂不支持 zlib.deflate。');
    },
};

// ---------------------------------------------------------------------------
// HTTP 请求：复刻 lx.request(url, options, callback)
// ---------------------------------------------------------------------------

type LxRequestOptions = {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Record<string, unknown> | FormData;
    form?: Record<string, string>;
    formData?: Record<string, string | Blob>;
    timeout?: number;
};

const buildRequestBody = (options: LxRequestOptions): { body?: BodyInit; headers?: Record<string, string> } => {
    const headers = { ...(options.headers ?? {}) };
    if (options.form) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(options.form)) params.set(k, v);
        return { body: params.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } };
    }
    if (options.formData) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(options.formData)) fd.append(k, v);
        return { body: fd, headers };
    }
    if (options.body !== undefined) {
        if (typeof options.body === 'string') return { body: options.body, headers };
        if (options.body instanceof FormData) return { body: options.body, headers };
        return { body: JSON.stringify(options.body), headers: { 'content-type': 'application/json', ...headers } };
    }
    return { headers };
};

export const lxRequest = (
    url: string,
    options: LxRequestOptions,
    callback: (err: unknown, resp?: { statusCode: number; headers: Record<string, string> }, body?: string) => void,
): (() => void) => {
    const controller = new AbortController();
    const timer = options.timeout ? window.setTimeout(() => controller.abort(), options.timeout) : null;
    const { body, headers } = buildRequestBody(options);
    fetch(url, { method: options.method || 'GET', headers, body, signal: controller.signal, mode: 'cors' })
        .then(async (resp) => {
            const text = await resp.text();
            const respHeaders: Record<string, string> = {};
            resp.headers.forEach((value, key) => { respHeaders[key] = value; });
            callback(null, { statusCode: resp.status, headers: respHeaders }, text);
        })
        .catch((err) => callback(err));
    return () => {
        if (timer) window.clearTimeout(timer);
        controller.abort();
    };
};

// ---------------------------------------------------------------------------
// 运行一个音源脚本
// ---------------------------------------------------------------------------

/**
 * 在页面环境里执行 LX 音源脚本，捕获它声明的平台与 request 回调。
 * 返回加载后的音源；若脚本初始化失败，error 字段给出原因。
 */
export const loadLxSource = (rawScript: string, meta: LxSourceMeta): LxLoadedSource => {
    validateLxScript(rawScript);

    let capturedSources: Partial<Record<LxPlatformKey, LxSourcePlatformInfo>> = {};
    let requestHandler: LxRequestHandler | null = null;
    let failed: string | undefined;

    const handlers = new Map<string, Array<(payload: unknown) => unknown>>();
    const register = (event: string, handler: (payload: unknown) => unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
    };
    const emit = async (event: string, payload: unknown): Promise<unknown> => {
        const list = handlers.get(event) ?? [];
        let last: unknown;
        for (const h of list) last = await h(payload);
        return last;
    };

    const lx = {
        version: '1.0.0',
        env: 'desktop',
        currentScriptInfo: { ...meta, rawScript },
        EVENT_NAMES,
        request: lxRequest,
        on: (event: string, handler: (payload: unknown) => unknown) => register(event, handler),
        send: (event: string, data: unknown) => {
            if (event === EVENT_NAMES.inited) {
                const d = data as { sources?: Partial<Record<LxPlatformKey, LxSourcePlatformInfo>>; openDevTools?: boolean };
                capturedSources = d.sources ?? {};
            } else if (event === EVENT_NAMES.updateAlert) {
                // 源主动提示更新：当前仅记录，不弹窗。
                console.info('[lx] source updateAlert:', data);
            }
        },
        utils: { buffer: bufferApi, crypto: cryptoApi, zlib: zlibApi },
    };

    const previousLx = (globalThis as { lx?: unknown }).lx;
    let runError: string | undefined;
    try {
        (globalThis as { lx?: unknown }).lx = lx;
        // 包一层 async 以支持脚本顶层 await；脚本里的 const { EVENT_NAMES, request, on, send } = globalThis.lx 在主作用域里取到。
        // eslint-disable-next-line no-new-func
        const runner = new Function(`"use strict";\n${rawScript}`) as () => Promise<unknown>;
        void runner();
    } catch (err) {
        runError = err instanceof Error ? err.message : String(err);
    } finally {
        (globalThis as { lx?: unknown }).lx = previousLx;
    }

    if (runError) {
        failed = runError;
    } else if (Object.keys(capturedSources).length === 0) {
        failed = '脚本未声明任何平台（没有收到 inited 事件），可能不是有效的洛雪音源。';
    } else {
        const list = handlers.get(EVENT_NAMES.request);
        if (!list || list.length === 0) {
            failed = '脚本没有注册 request 事件（无法取播放地址 / 歌词）。';
        } else {
            // LX 自定义源两种写法都支持：①回调式 on('request', (params, callback) => callback(null, result))
            // （桌面端最常用，可能是同步也可能是异步回调）；②返回式 on('request', async (params) => result)。
            // 下面把单个 handler 包成「先等返回值、再等回调」的 Promise，二者任一先给出结果即用。
            const callHandler = (handler: (payload: unknown) => unknown, payload: unknown): Promise<unknown> => (
                new Promise((resolve) => {
                    let settled = false;
                    const finish = (value: unknown) => {
                        if (!settled && value !== undefined) {
                            settled = true;
                            resolve(value);
                        }
                    };
                    const callback = (err: unknown, resp?: unknown) => {
                        if (err) return;
                        finish(resp);
                    };
                    let returned: unknown;
                    try {
                        returned = handler(payload);
                    } catch (err) {
                        console.warn('[lx] request handler 抛错：', err);
                        returned = undefined;
                    }
                    if (returned !== undefined) {
                        if (returned && typeof (returned as { then?: unknown }).then === 'function') {
                            (returned as Promise<unknown>).then((r) => finish(r)).catch(() => undefined);
                        } else {
                            finish(returned);
                        }
                    }
                    // 既不返回也不回调时，稍后让出，避免立刻 resolve(undefined) 抢在异步回调之前。
                    if (!settled) {
                        window.setTimeout(() => { if (!settled) resolve(undefined); }, 0);
                    }
                })
            );
            requestHandler = (async (payload) => {
                for (const handler of list!) {
                    const result = await callHandler(handler, payload);
                    if (result !== undefined) return result;
                }
                return undefined;
            }) as LxRequestHandler;
        }
    }

    return {
        id: '',
        meta,
        sources: capturedSources,
        requestHandler: requestHandler as LxRequestHandler,
        error: failed,
    };
};
