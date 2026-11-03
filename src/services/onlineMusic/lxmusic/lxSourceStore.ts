// src/services/onlineMusic/lxmusic/lxSourceStore.ts
// 洛雪音源的持久化与运行注册表：
// - 音源的「元信息 + 原始脚本」存 IndexedDB（db.ts 的 cache），进程重启后还在；
// - 加载后的脚本（request 回调）放在内存里，用来实时续歌；
// - 提供 resolveMusicUrl / resolveLyric 给 lxmusicProvider 调用。

import { getFromCache, saveToCache } from '../../../services/db';
import type { LxLoadedSource, LxPlatformKey, LxSource } from './lxTypes';
import { loadLxSource } from './lxRuntime';
import { parseLxHeader } from './lxSourceParser';

const STORAGE_KEY = 'lxmusic_sources_v1';

type Listener = () => void;

class LxSourceStore {
    private sources: LxSource[] = [];
    private loaded = new Map<string, LxLoadedSource>();
    private listeners = new Set<Listener>();
    private initPromise: Promise<void> | null = null;

    init(): Promise<void> {
        if (this.initPromise) return this.initPromise;
        this.initPromise = (async () => {
            const stored = await getFromCache<LxSource[]>(STORAGE_KEY);
            this.sources = Array.isArray(stored) ? stored : [];
            await this.reloadAll();
            this.notify();
        })();
        return this.initPromise;
    }

    /** 等音源初始化完（最多等 timeoutMs），播放前调用；已就绪时几乎零开销。 */
    async ensureReady(timeoutMs = 6000): Promise<void> {
        await Promise.race([
            this.init(),
            new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs)),
        ]);
    }

    private async persist(): Promise<void> {
        await saveToCache(STORAGE_KEY, this.sources);
    }

    /**
     * 重新加载全部音源。
     * 真实音源多半是「先 await 探测接口、再 send(inited)」，所以要等每条 ready 之后再读
     * sources / error；否则会把好好的音源判成「未声明任何平台」。
     */
    private async reloadAll(): Promise<void> {
        this.loaded.clear();
        const pending = this.sources
            .filter((src) => src.enabled)
            .map(async (src) => {
                try {
                    const loaded = await this.loadOne(src.rawScript, src.meta);
                    this.loaded.set(src.id, { ...loaded, id: src.id });
                    src.sources = loaded.sources;
                    src.error = loaded.error;
                } catch (err) {
                    this.loaded.set(src.id, {
                        id: src.id,
                        meta: src.meta,
                        sources: {},
                        requestHandler: async () => null,
                        error: String(err),
                        ready: Promise.resolve(),
                    });
                }
            });
        await Promise.all(pending);
    }

    /** 加载并等初始化完成。 */
    private async loadOne(rawScript: string, meta: LxSource['meta']): Promise<LxLoadedSource> {
        const loaded = loadLxSource(rawScript, meta);
        await loaded.ready;
        return loaded;
    }

    private notify(): void {
        this.listeners.forEach((l) => l());
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    getSources(): LxSource[] {
        return this.sources;
    }

    getLoaded(id: string): LxLoadedSource | undefined {
        return this.loaded.get(id);
    }

    /** 新增一个音源（来自在线导入或本地文件）。已存在同名则覆盖。 */
    async addSource(input: { rawScript: string; sourceUrl?: string }): Promise<LxSource> {
        const meta = parseLxHeader(input.rawScript);
        const id = (globalThis.crypto?.randomUUID?.() ?? `lx_${Date.now()}_${Math.random().toString(36).slice(2)}`);
        // 等初始化结束，才知道这个源到底支持哪些平台、能不能用。
        const loaded = await this.loadOne(input.rawScript, meta);
        const source: LxSource = {
            id,
            meta,
            rawScript: input.rawScript,
            sources: loaded.sources,
            enabled: true,
            importedAt: Date.now(),
            sourceUrl: input.sourceUrl,
            error: loaded.error,
        };
        const idx = this.sources.findIndex((s) => s.meta.name === meta.name);
        if (idx >= 0) this.sources[idx] = source;
        else this.sources.push(source);
        this.loaded.set(id, { ...loaded, id });
        await this.persist();
        this.notify();
        return source;
    }

    async setEnabled(id: string, enabled: boolean): Promise<void> {
        const src = this.sources.find((s) => s.id === id);
        if (!src) return;
        src.enabled = enabled;
        if (enabled) {
            const loaded = await this.loadOne(src.rawScript, src.meta);
            src.sources = loaded.sources;
            src.error = loaded.error;
            this.loaded.set(id, { ...loaded, id });
        } else {
            this.loaded.delete(id);
        }
        await this.persist();
        this.notify();
    }

    async removeSource(id: string): Promise<void> {
        this.sources = this.sources.filter((s) => s.id !== id);
        this.loaded.delete(id);
        await this.persist();
        this.notify();
    }

    /** 重新加载某个音源（编辑脚本后）。 */
    async reload(id: string): Promise<void> {
        const src = this.sources.find((s) => s.id === id);
        if (!src) return;
        const loaded = await this.loadOne(src.rawScript, src.meta);
        src.sources = loaded.sources;
        src.error = loaded.error;
        if (src.enabled) this.loaded.set(id, { ...loaded, id });
        await this.persist();
        this.notify();
    }

    /**
     * 找一个可用音源，为某平台取某种 action 的结果（musicUrl / lyric / pic）。
     * `accept` 用来验收结果（比如播放地址要先探活）：不通过就换下一个音源，
     * 而不是拿着一个 404 的地址让播放器静默失败。
     */
    private async resolveFirst(
        platform: LxPlatformKey,
        action: 'musicUrl' | 'lyric' | 'pic',
        info: { type?: string | null; musicInfo: Record<string, unknown> },
        accept?: (value: unknown) => Promise<boolean>,
    ): Promise<unknown> {
        for (const src of this.sources) {
            if (!src.enabled) continue;
            const platformInfo = src.sources[platform];
            if (!platformInfo || !platformInfo.actions.includes(action)) continue;
            const loaded = this.loaded.get(src.id);
            if (!loaded || !loaded.requestHandler || loaded.error) continue;
            try {
                const result = await loaded.requestHandler({ source: platform, action, info });
                if (result === undefined || result === null) continue;
                if (accept && !(await accept(result))) {
                    console.warn(`[lx] 音源 ${src.meta.name} 给出的 ${action}/${platform} 地址不可用，换下一个源`);
                    continue;
                }
                return result;
            } catch (err) {
                console.warn(`[lx] 音源 ${src.meta.name} 处理 ${action}/${platform} 失败：`, err);
            }
        }
        return null;
    }

    /** 取播放地址：返回 url 字符串，或 { url, headers }。 */
    async resolveMusicUrl(
        platform: LxPlatformKey,
        quality: string,
        musicInfo: Record<string, unknown>,
        accept?: (value: unknown) => Promise<boolean>,
    ): Promise<string | { url: string; headers?: Record<string, string> } | null> {
        const result = await this.resolveFirst(platform, 'musicUrl', { type: quality, musicInfo }, accept);
        if (result == null) return null;
        if (typeof result === 'string') return result;
        if (typeof result === 'object' && 'url' in (result as object)) {
            const r = result as { url: string; headers?: Record<string, string> };
            if (typeof r.url === 'string' && r.url.length > 0) return { url: r.url, headers: r.headers };
        }
        return null;
    }

    async resolveLyric(platform: LxPlatformKey, musicInfo: Record<string, unknown>): Promise<unknown> {
        return this.resolveFirst(platform, 'lyric', { musicInfo });
    }

    /** 有没有音源能处理这个平台的某种 action。UI 用它提示「没导入音源就放不了歌」。 */
    canResolve(platform: LxPlatformKey, action: 'musicUrl' | 'lyric' | 'pic' = 'musicUrl'): boolean {
        return this.sources.some((src) => {
            if (!src.enabled) return false;
            const platformInfo = src.sources[platform];
            if (!platformInfo || !platformInfo.actions.includes(action)) return false;
            const loaded = this.loaded.get(src.id);
            return Boolean(loaded?.requestHandler) && !loaded?.error;
        });
    }

    /** 有没有任何音源能处理某种 action（不限定平台）。跨平台兜底时用它判断「还有没有戏」。 */
    canResolveAny(action: 'musicUrl' | 'lyric' | 'pic' = 'musicUrl'): boolean {
        return this.sources.some((src) => {
            if (!src.enabled) return false;
            const loaded = this.loaded.get(src.id);
            if (!loaded?.requestHandler || loaded.error) return false;
            return Object.values(src.sources).some((info) => Boolean(info?.actions.includes(action)));
        });
    }

    /** 统计可用 / 有错误的音源数，给 UI 用。 */
    stats(): { total: number; enabled: number; errors: number } {
        return {
            total: this.sources.length,
            enabled: this.sources.filter((s) => s.enabled).length,
            errors: this.sources.filter((s) => s.error).length,
        };
    }
}

export const lxSourceStore = new LxSourceStore();
