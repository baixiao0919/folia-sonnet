// src/services/onlineMusic/lxmusic/lxmusicProvider.ts
// 「洛雪音源」聚合 provider。
// 思路：搜索 / 列歌单 / 取详情复用以 folia 自带的网易云 / 酷狗 / QQ provider（它们真的会搜、会列歌单），
// 而导入的 LX 音源负责在这些歌上「续」出可播放的地址与歌词（LX 自定义源只干这件事）。
// 因此：wy→netease、kg→kugou、tx→qq；kw/mg（酷我/咪咕）folia 没有原生 provider，只能续地址、无法搜索。

import type {
    OnlineMusicProvider,
    ProviderCollection,
    ProviderPage,
    AudioQualityPreference,
    OnlineProviderId,
    MediaId,
} from '../../../types/onlineMusic';
import type { LyricData, SongResult, UnifiedSong } from '../../../types';
import { neteaseProvider } from '../netease/neteaseProvider';
import { kugouProvider } from '../kugou/kugouProvider';
import { qqProvider } from '../qq/qqProvider';
import { lxSourceStore } from './lxSourceStore';
import {
    FOLIA_QUALITY_TO_LX,
    LX_PLATFORM_TO_PROVIDER,
    PROVIDER_TO_LX_PLATFORM,
    type LxPlatformKey,
} from './lxTypes';

const NATIVE_PROVIDERS: Array<{ platform: LxPlatformKey; provider: OnlineMusicProvider }> = [
    { platform: 'wy', provider: neteaseProvider },
    { platform: 'kg', provider: kugouProvider },
    { platform: 'tx', provider: qqProvider },
];

/** 把原生 provider 的歌，重新打上 lxmusic 的标签，并记录它原本来自哪个平台 / 哪个 id。 */
const retagSong = (song: UnifiedSong, platform: LxPlatformKey, nativeProviderId: OnlineProviderId): UnifiedSong => {
    const nativeMediaId = String(song.sourceRef?.mediaId ?? song.id);
    const lxId = `${nativeProviderId}|${nativeMediaId}`;
    return {
        ...song,
        id: lxId as MediaId,
        sourceRef: {
            kind: 'online',
            providerId: 'lxmusic',
            mediaId: lxId,
            providerData: { platform, nativeProviderId, nativeMediaId },
        },
    };
};

/** 从 lxmusic 的 id 解析回原生 provider / id。 */
const parseLxId = (id: MediaId): { platform: LxPlatformKey; nativeProviderId: OnlineProviderId; nativeMediaId: string } | null => {
    const [nativeProviderId, nativeMediaId] = String(id).split('|');
    if (!nativeProviderId || !nativeMediaId) return null;
    const platform = PROVIDER_TO_LX_PLATFORM[nativeProviderId];
    if (!platform) return null;
    return { platform, nativeProviderId: nativeProviderId as OnlineProviderId, nativeMediaId };
};

/** 原生歌单 / 专辑 / 歌手：打成 lxmusic 标签，id 里带上原生 provider，providerData 里留一份还原信息。 */
const retagCollection = (
    collection: ProviderCollection,
    platform: LxPlatformKey,
    nativeProviderId: OnlineProviderId,
): ProviderCollection => ({
    ...collection,
    providerId: 'lxmusic',
    id: `${nativeProviderId}|${String(collection.id)}`,
    providerData: {
        ...(collection.providerData ?? {}),
        lxOrigin: { nativeProviderId, nativeMediaId: String(collection.id), platform },
    },
});

/** 把 lxmusic 壳还原成原生 provider 认得的歌单对象（原生 provider 的 getPlaylistTracks 会读它的数据）。 */
const restoreNativeCollection = (
    collection: ProviderCollection | undefined,
    parsed: NonNullable<ReturnType<typeof parseLxId>>,
): ProviderCollection | undefined => {
    if (!collection) return undefined;
    const providerData = { ...(collection.providerData ?? {}) };
    delete providerData.lxOrigin;
    return {
        ...collection,
        providerId: parsed.nativeProviderId,
        id: parsed.nativeMediaId as MediaId,
        providerData: Object.keys(providerData).length > 0 ? providerData : undefined,
    };
};

/** 给 LX 音源拼出它要的 musicInfo：尽量带上平台歌曲 id 与常见字段名。 */
const buildMusicInfo = (song: SongResult, nativeMediaId: string): Record<string, unknown> => {
    const artistNames = song.artists.map((a) => a.name).join(',');
    const durationSec = Math.round((song.durationMs ?? 0) / 1000);
    return {
        songid: nativeMediaId,
        songmid: nativeMediaId,
        musicId: nativeMediaId,
        id: nativeMediaId,
        mid: nativeMediaId,
        // 酷狗自定义源通常读 hash；原生 kugou provider 的 mediaId 正是 hash。
        hash: nativeMediaId,
        name: song.name,
        title: song.name,
        singer: artistNames,
        artist: artistNames,
        albumName: song.album?.name ?? '',
        album: song.album?.name ?? '',
        interval: durationSec,
        duration: durationSec,
    };
};

const foliaQualityToLx = (quality: AudioQualityPreference, supported: string[]): string | null => {
    const order = FOLIA_QUALITY_TO_LX;
    const idx = order.findIndex((o) => o.folia === quality);
    // 从请求的音质往下找，取源支持的最近一档。
    for (let i = idx; i < order.length; i++) {
        if (supported.includes(order[i].lx)) return order[i].lx;
    }
    for (let i = idx - 1; i >= 0; i--) {
        if (supported.includes(order[i].lx)) return order[i].lx;
    }
    return supported[0] ?? null;
};

/** 把 LRC 文本（[mm:ss.xx] 歌词）转成 folia 的结构化 LyricData。 */
const parseLrcToLyricData = (lrc: string): LyricData => {
    const regex = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    const parsed: Array<{ time: number; text: string }> = [];
    for (const line of lrc.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const text = trimmed.replace(regex, '').trim();
        const matches = [...trimmed.matchAll(regex)];
        if (matches.length === 0) continue;
        for (const m of matches) {
            const minutes = parseInt(m[1], 10);
            const seconds = parseInt(m[2], 10);
            const fracRaw = m[3] ? m[3].padEnd(3, '0').slice(0, 3) : '000';
            const frac = parseInt(fracRaw, 10);
            parsed.push({ time: minutes * 60 + seconds + frac / 1000, text });
        }
    }
    parsed.sort((a, b) => a.time - b.time);
    const lines = parsed.map((entry, i) => {
        const start = entry.time;
        const end = i + 1 < parsed.length ? parsed[i + 1].time : start + 6;
        return {
            words: [{ text: entry.text, startTime: start, endTime: end }],
            startTime: start,
            endTime: end,
            fullText: entry.text,
            id: String(i),
        };
    });
    return { lines };
};

const emptyPage = <T>(offset = 0): ProviderPage<T> => ({ items: [], nextOffset: offset, hasMore: false });

const lxPage = <T>(items: T[], offset: number, limit: number): ProviderPage<T> => ({
    items,
    nextOffset: offset + items.length,
    hasMore: items.length === limit,
});

export const lxmusicProvider: OnlineMusicProvider = {
    id: 'lxmusic',
    displayName: '洛雪音源',
    shortName: '洛雪',
    mark: { letter: '雪', color: '#e11d48' },
    getAvailability: () => ({ configured: true }),
    capabilities: {
        search: true,
        playback: true,
        lyrics: true,
        auth: false,
        playlists: true,
        albums: true,
        artists: true,
        recommendations: false,
        userLibrary: false,
        likes: false,
        mutations: false,
        wordByWordLyrics: false,
        passwordLogin: false,
    },
    normalizeSong: (raw: unknown) => raw as UnifiedSong,

    search: {
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return emptyPage<UnifiedSong>(offset);
            const perNative = Math.max(limit, 20);
            const results = await Promise.allSettled(
                NATIVE_PROVIDERS.map(async ({ platform, provider }) => {
                    if (!provider.search) return [] as UnifiedSong[];
                    const page = await provider.search.searchSongs(query, perNative, offset);
                    return page.items.map((song) => retagSong(song, platform, provider.id));
                }),
            );
            const songs = results
                .filter((r): r is PromiseFulfilledResult<UnifiedSong[]> => r.status === 'fulfilled')
                .flatMap((r) => r.value);
            // 按 lxId 去重。
            const seen = new Set<string>();
            const deduped = songs.filter((s) => {
                const id = String(s.id);
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
            });
            return lxPage(deduped, offset, limit);
        },
        async searchAlbums(query, limit, offset) {
            if (!query.trim()) return emptyPage<ProviderCollection>(offset);
            const results = await Promise.allSettled(
                NATIVE_PROVIDERS.map(async ({ platform, provider }) => {
                    if (!provider.search?.searchAlbums) return [] as ProviderCollection[];
                    const page = await provider.search.searchAlbums(query, limit, offset);
                    return page.items.map((c) => retagCollection(c, platform, provider.id));
                }),
            );
            const items = results
                .filter((r): r is PromiseFulfilledResult<ProviderCollection[]> => r.status === 'fulfilled')
                .flatMap((r) => r.value);
            return lxPage(items, offset, limit);
        },
        async searchPlaylists(query, limit, offset) {
            if (!query.trim()) return emptyPage<ProviderCollection>(offset);
            const results = await Promise.allSettled(
                NATIVE_PROVIDERS.map(async ({ platform, provider }) => {
                    if (!provider.search?.searchPlaylists) return [] as ProviderCollection[];
                    const page = await provider.search.searchPlaylists(query, limit, offset);
                    return page.items.map((c) => retagCollection(c, platform, provider.id));
                }),
            );
            const items = results
                .filter((r): r is PromiseFulfilledResult<ProviderCollection[]> => r.status === 'fulfilled')
                .flatMap((r) => r.value);
            return lxPage(items, offset, limit);
        },
    },

    playback: {
        async getSongDetail(id) {
            const parsed = parseLxId(id);
            if (!parsed) return null;
            const native = NATIVE_PROVIDERS.find((p) => p.platform === parsed.platform)?.provider;
            if (!native?.playback?.getSongDetail) return null;
            const nativeSong = await native.playback.getSongDetail(parsed.nativeMediaId as MediaId);
            return nativeSong ? retagSong(nativeSong, parsed.platform, parsed.nativeProviderId) : null;
        },
        async getAudioSource(song, quality) {
            const ref = song.sourceRef;
            const data = ref?.kind === 'online' ? (ref.providerData as
                | { platform?: LxPlatformKey; nativeMediaId?: string }
                | undefined) : undefined;
            const platform = data?.platform;
            const nativeMediaId = data?.nativeMediaId;
            if (!platform || !nativeMediaId) return null;
            const nativeProviderId = LX_PLATFORM_TO_PROVIDER[platform];
            if (!nativeProviderId) return null;
            const source = lxSourceStore.getSources().find((s) => s.enabled && s.sources[platform]?.actions.includes('musicUrl'));
            if (!source) return null;
            const supported = source.sources[platform]?.qualitys ?? [];
            const lxQuality = foliaQualityToLx(quality, supported);
            if (!lxQuality) return null;
            const musicInfo = buildMusicInfo(song, nativeMediaId);
            const result = await lxSourceStore.resolveMusicUrl(platform, lxQuality, musicInfo);
            if (!result) return null;
            if (typeof result === 'string') {
                return { url: result, fetchedAt: Date.now(), quality };
            }
            return { url: result.url, fetchedAt: Date.now(), quality };
        },
    },

    lyrics: {
        async getLyrics(song) {
            const ref = song.sourceRef;
            const data = ref?.kind === 'online' ? (ref.providerData as
                | { platform?: LxPlatformKey; nativeMediaId?: string }
                | undefined) : undefined;
            const platform = data?.platform;
            const nativeMediaId = data?.nativeMediaId;
            if (!platform || !nativeMediaId) {
                return { lyrics: null, isPureMusic: false };
            }
            const musicInfo = buildMusicInfo(song, nativeMediaId);
            const raw = await lxSourceStore.resolveLyric(platform, musicInfo);
            if (!raw || typeof raw !== 'object') {
                return { lyrics: null, isPureMusic: false };
            }
            const r = raw as { lyric?: string; tlyric?: string; rlyric?: string; lxlyric?: string };
            const main = r.lyric ?? null;
            const translated = r.tlyric ?? null;
            const romanized = r.rlyric ?? null;
            return {
                lyrics: main ? parseLrcToLyricData(main) : null,
                mainText: main,
                translationText: translated,
                romanizationText: romanized,
                isPureMusic: false,
            };
        },
    },

    catalog: {
        async getPlaylistTracks(id, limit, offset, collection) {
            const parsed = parseLxId(id);
            if (!parsed) return emptyPage<UnifiedSong>(offset);
            const native = NATIVE_PROVIDERS.find((p) => p.platform === parsed.platform)?.provider;
            const tracks = await native?.catalog?.getPlaylistTracks?.(
                parsed.nativeMediaId as MediaId, limit, offset, restoreNativeCollection(collection, parsed),
            );
            if (!tracks) return emptyPage<UnifiedSong>(offset);
            return { ...tracks, items: tracks.items.map((s) => retagSong(s, parsed.platform, parsed.nativeProviderId)) };
        },
        async getPlaylistDetail(id, collection) {
            const parsed = parseLxId(id);
            if (!parsed) return null;
            const native = NATIVE_PROVIDERS.find((p) => p.platform === parsed.platform)?.provider;
            const detail = await native?.catalog?.getPlaylistDetail?.(
                parsed.nativeMediaId as MediaId, restoreNativeCollection(collection, parsed),
            ) ?? null;
            return detail ? retagCollection(detail, parsed.platform, parsed.nativeProviderId) : null;
        },
        async getAlbumTracks(id, limit, offset, collection) {
            const parsed = parseLxId(id);
            if (!parsed) return emptyPage<UnifiedSong>(offset);
            const native = NATIVE_PROVIDERS.find((p) => p.platform === parsed.platform)?.provider;
            const tracks = await native?.catalog?.getAlbumTracks?.(
                parsed.nativeMediaId as MediaId, limit, offset, restoreNativeCollection(collection, parsed),
            );
            if (!tracks) return emptyPage<UnifiedSong>(offset);
            return { ...tracks, items: tracks.items.map((s) => retagSong(s, parsed.platform, parsed.nativeProviderId)) };
        },
        async getAlbumDetail(id, collection) {
            const parsed = parseLxId(id);
            if (!parsed) return null;
            const native = NATIVE_PROVIDERS.find((p) => p.platform === parsed.platform)?.provider;
            const detail = await native?.catalog?.getAlbumDetail?.(
                parsed.nativeMediaId as MediaId, restoreNativeCollection(collection, parsed),
            ) ?? null;
            return detail ? retagCollection(detail, parsed.platform, parsed.nativeProviderId) : null;
        },
        async getArtistSongs(id, limit, offset) {
            const parsed = parseLxId(id);
            if (!parsed) return emptyPage<UnifiedSong>(offset);
            const native = NATIVE_PROVIDERS.find((p) => p.platform === parsed.platform)?.provider;
            const songs = await native?.catalog?.getArtistSongs?.(parsed.nativeMediaId as MediaId, limit, offset);
            if (!songs) return emptyPage<UnifiedSong>(offset);
            return { ...songs, items: songs.items.map((s) => retagSong(s, parsed.platform, parsed.nativeProviderId)) };
        },
        async getArtistDetail(id) {
            const parsed = parseLxId(id);
            if (!parsed) return null;
            const native = NATIVE_PROVIDERS.find((p) => p.platform === parsed.platform)?.provider;
            const detail = await native?.catalog?.getArtistDetail?.(parsed.nativeMediaId as MediaId) ?? null;
            return detail ? retagCollection(detail, parsed.platform, parsed.nativeProviderId) : null;
        },
    },
};

// 进程启动后异步初始化音源注册表（从 IndexedDB 载入已导入的音源）。
void lxSourceStore.init();
