// src/services/lanCast.ts
// 局域网音响投送的前端门面。SSDP 发现与 SOAP 推送都在 FoliaLanCast 原生插件里，
// 这里只负责能力探测、把本机回环转发地址换成音响能连的局域网地址，以及归一化错误。

import { isCapacitorAndroid } from '../platform/runtime';

export type LanSpeaker = {
    id: string;
    name: string;
    location: string;
    controlUrl: string;
    manufacturer: string;
};

export type LanCastTrack = {
    url: string;
    title: string;
    artist: string;
    album?: string;
    coverUrl?: string;
    durationMs?: number;
};

type RelayPlugin = {
    lanCastPrepare?: () => Promise<{ port?: number; lanIp?: string }>;
    lanCastRelease?: () => Promise<unknown>;
};

type CastPlugin = {
    discover?: (options: { timeoutMs?: number }) => Promise<{ devices?: LanSpeaker[] }>;
    play?: (options: LanCastTrack & { controlUrl: string }) => Promise<{ ok?: boolean }>;
    stop?: (options: { controlUrl: string }) => Promise<{ ok?: boolean }>;
};

const nativePlugin = <T>(name: string): T | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as any).Capacitor;
    return (capacitor?.Plugins?.[name] ?? null) as T | null;
};

const relay = (): RelayPlugin | null => nativePlugin<RelayPlugin>('FoliaNative');
const cast = (): CastPlugin | null => nativePlugin<CastPlugin>('FoliaLanCast');

/** 桌面 / iOS / Web 上没有 SSDP 能力，播放页就不该出现投送入口。 */
export const isLanCastAvailable = (): boolean => (
    typeof window !== 'undefined' && isCapacitorAndroid() && cast()?.discover != null
);

const errorText = (error: unknown): string => {
    const raw = error instanceof Error ? error.message : String(error ?? '');
    // Capacitor 把 reject 包成 "Error: xxx"，去掉前缀免得界面上重复两遍。
    return raw.replace(/^Error:\s*/i, '').trim() || '未知错误';
};

/** 判断是不是本机回环的转发地址（音响拿到会当成它自己）。 */
const isLoopbackUrl = (value: string): boolean => {
    try {
        const url = new URL(value, location.href);
        return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    } catch {
        return false;
    }
};

/**
 * 把播放地址变成音响能真正拉到的地址。
 *
 * 安卓上绝大多数在线歌曲走 `http://127.0.0.1:<port>/remote-audio/<token>`（绕 CORS 的转发），
 * 这个地址对音响毫无意义。投送前让原生把转发服务临时对局域网开放，再把 host 换成手机 IP，
 * token 与端口保持原样，音响就能连回来拿字节，连音源需要的请求头也照样由转发服务带上。
 */
const toCastableUrl = async (raw: string): Promise<string> => {
    const value = String(raw || '').trim();
    if (!value) throw new Error('当前没有正在播放的歌曲');
    if (value.startsWith('blob:') || value.startsWith('data:')) {
        throw new Error('本机文件没有局域网地址，暂时不能投送');
    }
    if (!/^https?:\/\//i.test(value)) throw new Error('这首歌的地址不能投送');
    if (!isLoopbackUrl(value)) return value;

    const bridge = relay();
    if (!bridge?.lanCastPrepare) throw new Error('当前版本不支持本机中继投送');
    const info = await bridge.lanCastPrepare();
    if (!info?.lanIp || !info?.port) {
        throw new Error('没取到手机的局域网地址，请确认已连接 WiFi');
    }
    const url = new URL(value);
    url.protocol = 'http:';
    url.host = `${info.lanIp}:${info.port}`;
    return url.toString();
};

export const discoverLanSpeakers = async (timeoutMs = 3200): Promise<LanSpeaker[]> => {
    const plugin = cast();
    if (!plugin?.discover) throw new Error('当前设备不支持局域网投送');
    const result = await plugin.discover({ timeoutMs });
    return (result?.devices ?? []).filter(device => Boolean(device?.controlUrl && device?.name));
};

export const castTrackToSpeaker = async (speaker: LanSpeaker, track: LanCastTrack): Promise<void> => {
    const plugin = cast();
    if (!plugin?.play) throw new Error('当前设备不支持局域网投送');
    const url = await toCastableUrl(track.url);
    try {
        await plugin.play({ ...track, url, controlUrl: speaker.controlUrl });
    } catch (error) {
        throw new Error(errorText(error));
    }
};

/** 停止音响播放，并顺手关掉对局域网开放的转发入口。 */
export const stopCastingToSpeaker = async (speaker: LanSpeaker | null): Promise<void> => {
    const plugin = cast();
    try {
        if (speaker && plugin?.stop) await plugin.stop({ controlUrl: speaker.controlUrl });
    } catch (error) {
        throw new Error(errorText(error));
    } finally {
        try {
            await relay()?.lanCastRelease?.();
        } catch { /* 收口失败不影响停止本身。 */ }
    }
};

export const lanCastErrorText = errorText;
