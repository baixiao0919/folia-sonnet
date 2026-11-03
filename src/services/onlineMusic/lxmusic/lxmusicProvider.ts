// src/services/onlineMusic/lxmusic/lxmusicProvider.ts
// 「洛雪音源」provider。
//
// 分工照 LX 客户端来：
//   · 搜索 / 歌单广场 / 榜单 / 歌单与专辑曲目 —— 走 lxPublicApi 里各家的公开网页接口，不需要账号；
//   · 播放地址 / 歌词 —— 优先用公开接口（酷我有免费直链、网易云有公开歌词），取不到时交给导入的 LX 音源
//     （LX 自定义音源只干这件事：把 musicUrl / lyric / pic 续出来）。
//
// 歌曲 id 统一编成 `平台:原生 id`（wy:123 / kg:<hash> / kw:456），providerData 里再留一份，
// 换成别的 provider 也不会丢来源。

import type {
    AudioQualityPreference,
    MediaId,
    OnlineMusicProvider,
    ProviderCollection,
    ProviderPage,
} from '../../../types/onlineMusic';
import type { LyricData, SongResult, UnifiedSong } from '../../../types';
import { lxSourceStore } from './lxSourceStore';
import { FOLIA_QUALITY_TO_LX, type LxPlatformKey } from './lxTypes';
import {
    lxApiAlbumSquare,
    lxApiAlbumTracks,
    lxApiChartTracks,
    lxApiCharts,
    lxApiFreeAudioUrl,
    lxApiLyric,
    lxApiPlaylistSquare,
    lxApiPlaylistTracks,
    lxApiRadioPrograms,
    lxApiSearchAlbums,
    lxApiSearchPlaylists,
    lxApiSearchSongs,
    LX_PUBLIC_PLATFORM_KEYS,
    type LxApiCollection,
    type LxApiPage,
    type LxApiSong,
    type LxPublicPlatform,
} from './lxPublicApi';

// ---------------------------------------------------------------- id 编解码

type ParsedId = { platform: LxPlatformKey; nativeId: string };

const KNOWN_ID_PLATFORMS = new Set<string>(['wy', 'kg', 'kw', 'tx', 'mg']);

/** `wy:123` → { platform: 'wy', nativeId: '123' }；同时兼容上一版的 `netease|123`。 */
const parseSongId = (id: MediaId | string): ParsedId | null => {
    const raw = String(id ?? '');
    const sep = raw.indexOf(':');
    if (sep > 0) {
        const platform = raw.slice(0, sep);
        const nativeId = raw.slice(sep + 1);
        if (nativeId && KNOWN_ID_PLATFORMS.has(platform)) {
            return { platform: platform as LxPlatformKey, nativeId };
        }
        return null;
    }
    const [legacyProvider, legacyId] = raw.split('|');
    const legacyMap: Record<string, LxPlatformKey> = { netease: 'wy', kugou: 'kg', qq: 'tx', kuwo: 'kw' };
    const platform = legacyMap[legacyProvider];
    if (platform && legacyId) return { platform, nativeId: legacyId };
    return null;
};

const makeId = (platform: LxPlatformKey, nativeId: string): MediaId => `${platform}:${nativeId}` as MediaId;

const platformOfSong = (song: SongResult): ParsedId | null => {
    const ref = song.sourceRef;
    if (ref?.kind === 'online' && ref.providerData) {
        const data = ref.providerData as { platform?: LxPlatformKey; nativeId?: string };
        if (data.platform && data.nativeId) return { platform: data.platform, nativeId: data.nativeId };
    }
    return parseSongId(song.id);
};

// ---------------------------------------------------------------- 结构转换

const toUnifiedSong = (item: LxApiSong): UnifiedSong => {
    const id = makeId(item.platform, item.id);
    return {
        id,
        name: item.name,
        artists: item.artists.length > 0
            ? item.artists.map((artist, index) => ({
                id: (artist.id ?? `${item.platform}-artist-${index}-${artist.name}`) as MediaId,
                name: artist.name,
            }))
            : [{ id: `${item.platform}-artist-unknown` as MediaId, name: '未知歌手' }],
        album: {
            id: (item.album.id ?? `${item.platform}-album-unknown`) as MediaId,
            name: item.album.name || '未知专辑',
            coverUrl: item.album.coverUrl ?? item.coverUrl,
        },
        durationMs: item.durationMs,
        aliases: [],
        translatedNames: [],
        isPureMusic: false,
        sourceRef: {
            kind: 'online',
            providerId: 'lxmusic',
            mediaId: String(id),
            providerData: { platform: item.platform, nativeId: item.id },
        },
    };
};

const toProviderCollection = (item: LxApiCollection): ProviderCollection => ({
    providerId: 'lxmusic',
    id: makeId(item.platform, item.id),
    name: item.name,
    type: item.kind,
    coverUrl: item.coverUrl,
    description: item.description,
    trackCount: item.trackCount,
    playCount: item.playCount,
    creator: item.creatorName ? { id: `${item.platform}-creator` as MediaId, nickname: item.creatorName } : undefined,
    updatedAt: item.updatedAt,
    providerData: { platform: item.platform, nativeId: item.id, kind: item.kind },
});

const emptyPage = <T>(offset = 0): ProviderPage<T> => ({ items: [], nextOffset: offset, hasMore: false });

const toProviderPage = <T, U>(page: LxApiPage<T>, map: (item: T) => U, offset: number, limit: number): ProviderPage<U> => {
    const items = page.items.map(map);
    return { items, nextOffset: offset + items.length, hasMore: page.hasMore };
};

/** 多平台结果交替排列（wy, kg, kw, wy …），一屏里能同时看到各家，而不是先把网易云翻完。 */
const interleave = <T>(lists: T[][]): T[] => {
    const out: T[] = [];
    const max = Math.max(0, ...lists.map((list) => list.length));
    for (let index = 0; index < max; index += 1) {
        for (const list of lists) {
            if (index < list.length) out.push(list[index]);
        }
    }
    return out;
};

const dedupeSongs = (songs: UnifiedSong[]): UnifiedSong[] => {
    const seen = new Set<string>();
    const out: UnifiedSong[] = [];
    for (const song of songs) {
        const key = `${song.name}__${song.artists.map((a) => a.name).join('/')}`.toLowerCase();
        const idKey = String(song.id);
        if (seen.has(key) || seen.has(idKey)) continue;
        seen.add(key);
        seen.add(idKey);
        out.push(song);
    }
    return out;
};

// ---------------------------------------------------------------- 音源

const foliaQualityToLx = (quality: AudioQualityPreference, supported: string[]): string | null => {
    const order = FOLIA_QUALITY_TO_LX;
    const idx = Math.max(0, order.findIndex((entry) => entry.folia === quality));
    for (let i = idx; i < order.length; i += 1) {
        if (supported.includes(order[i].lx)) return order[i].lx;
    }
    for (let i = idx - 1; i >= 0; i -= 1) {
        if (supported.includes(order[i].lx)) return order[i].lx;
    }
    return supported[0] ?? null;
};

const sourceQualityFor = (platform: LxPlatformKey): string[] => {
    const supported = new Set<string>();
    for (const source of lxSourceStore.getSources()) {
        if (!source.enabled) continue;
        const info = source.sources[platform];
        if (!info?.actions.includes('musicUrl')) continue;
        info.qualitys.forEach((quality) => supported.add(quality));
    }
    return [...supported];
};

/** LX 音源要的 musicInfo：把各平台认的字段名都填上。 */
const buildMusicInfo = (song: SongResult, parsed: ParsedId): Record<string, unknown> => {
    const artistNames = song.artists.map((artist) => artist.name).join(',');
    const durationSec = Math.round((song.durationMs ?? 0) / 1000);
    const nativeId = parsed.nativeId;
    return {
        songid: nativeId,
        songmid: nativeId,
        musicId: nativeId,
        id: nativeId,
        mid: nativeId,
        // 酷狗自定义源普遍读 hash。
        hash: nativeId,
        name: song.name,
        title: song.name,
        singer: artistNames,
        artist: artistNames,
        albumName: song.album?.name ?? '',
        album: song.album?.name ?? '',
        interval: durationSec,
        duration: durationSec,
        songId: nativeId,
        musicid: nativeId,
    };
};

/** 把 LRC 文本转成 folia 的结构化歌词。 */
const parseLrcToLyricData = (lrc: string): LyricData => {
    const regex = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    const parsed: Array<{ time: number; text: string }> = [];
    for (const line of lrc.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const text = trimmed.replace(regex, '').trim();
        const matches = [...trimmed.matchAll(regex)];
        if (matches.length === 0) continue;
        for (const match of matches) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const fracRaw = match[3] ? match[3].padEnd(3, '0').slice(0, 3) : '000';
            parsed.push({ time: minutes * 60 + seconds + parseInt(fracRaw, 10) / 1000, text });
        }
    }
    parsed.sort((a, b) => a.time - b.time);
    const lines = parsed.map((entry, index) => {
        const start = entry.time;
        const end = index + 1 < parsed.length ? parsed[index + 1].time : start + 6;
        return {
            words: [{ text: entry.text, startTime: start, endTime: end }],
            startTime: start,
            endTime: end,
            fullText: entry.text,
            id: String(index),
        };
    });
    return { lines };
};

const isPublicPlatform = (platform: LxPlatformKey): platform is LxPublicPlatform => (
    platform === 'wy' || platform === 'kg' || platform === 'kw' || platform === 'tx'
);

// ---------------------------------------------------------------- provider

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
        // 免登录：导入音源就能用，不弹登录窗。
        auth: false,
        playlists: true,
        albums: true,
        artists: false,
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
            const results = await Promise.allSettled(
                LX_PUBLIC_PLATFORM_KEYS.map((platform) => lxApiSearchSongs(platform, query, limit, offset)),
            );
            const pages = results
                .filter((result): result is PromiseFulfilledResult<LxApiPage<LxApiSong>> => result.status === 'fulfilled')
                .map((result) => result.value);
            if (pages.length === 0) {
                const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
                console.warn('[lxmusic] 搜索全部平台失败：', failure?.reason);
                return emptyPage<UnifiedSong>(offset);
            }
            // `limit` 是「每个平台各取多少」，不是总数：各家的 offset 才能对齐，翻页不会漏歌。
            const songs = dedupeSongs(interleave(pages.map((page) => page.items.map(toUnifiedSong))));
            return {
                items: songs,
                nextOffset: offset + limit,
                hasMore: pages.some((page) => page.hasMore),
            };
        },
        async searchPlaylists(query, limit, offset) {
            if (!query.trim()) return emptyPage<ProviderCollection>(offset);
            const results = await Promise.allSettled(
                (['wy', 'kg', 'tx'] as const).map((platform) => lxApiSearchPlaylists(platform, query, limit, offset)),
            );
            const pages = results
                .filter((result): result is PromiseFulfilledResult<LxApiPage<LxApiCollection>> => result.status === 'fulfilled')
                .map((result) => result.value);
            const collections = interleave(pages.map((page) => page.items)).map(toProviderCollection);
            return {
                items: collections,
                nextOffset: offset + limit,
                hasMore: pages.some((page) => page.hasMore),
            };
        },
        async searchAlbums(query, limit, offset) {
            if (!query.trim()) return emptyPage<ProviderCollection>(offset);
            const page = await lxApiSearchAlbums('wy', query, limit, offset);
            return toProviderPage(page, toProviderCollection, offset, limit);
        },
    },

    playback: {
        async getSongDetail() {
            // 这个 provider 的歌曲都带着完整元信息；拿不到单曲详情时不假装有。
            return null;
        },
        async getAudioSource(song, quality) {
            const parsed = platformOfSong(song);
            if (!parsed) return null;

            // 1) 公开直链（目前只有酷我给）。
            if (isPublicPlatform(parsed.platform)) {
                const freeUrl = await lxApiFreeAudioUrl(parsed.platform, parsed.nativeId);
                if (freeUrl) return { url: freeUrl, fetchedAt: Date.now(), quality };
            }

            // 2) 导入的音源。
            const supported = sourceQualityFor(parsed.platform);
            if (supported.length === 0) return null;
            const lxQuality = foliaQualityToLx(quality, supported);
            if (!lxQuality) return null;
            const result = await lxSourceStore.resolveMusicUrl(parsed.platform, lxQuality, buildMusicInfo(song, parsed));
            if (!result) return null;
            const url = typeof result === 'string' ? result : result.url;
            if (!url) return null;
            return { url, fetchedAt: Date.now(), quality };
        },
    },

    lyrics: {
        async getLyrics(song) {
            const parsed = platformOfSong(song);
            if (!parsed) return { lyrics: null, isPureMusic: false };

            // 1) 公开歌词接口。
            if (isPublicPlatform(parsed.platform)) {
                try {
                    const { main, translation } = await lxApiLyric(parsed.platform, parsed.nativeId);
                    if (main) {
                        return {
                            lyrics: parseLrcToLyricData(main),
                            mainText: main,
                            translationText: translation ?? undefined,
                            isPureMusic: false,
                        };
                    }
                } catch (error) {
                    console.warn('[lxmusic] 公开歌词接口失败，改走音源：', error);
                }
            }

            // 2) 音源。
            const raw = await lxSourceStore.resolveLyric(parsed.platform, buildMusicInfo(song, parsed));
            const record = raw && typeof raw === 'object' ? raw as { lyric?: string; tlyric?: string; rlyric?: string } : null;
            const main = record?.lyric ?? null;
            if (!main) return { lyrics: null, isPureMusic: false };
            return {
                lyrics: parseLrcToLyricData(main),
                mainText: main,
                translationText: record?.tlyric ?? undefined,
                romanizationText: record?.rlyric ?? undefined,
                isPureMusic: false,
            };
        },
    },

    catalog: {
        async getPlaylistTracks(id, limit, offset) {
            const parsed = parseSongId(id);
            if (!parsed || !isPublicPlatform(parsed.platform)) return emptyPage<UnifiedSong>(offset);
            const page = await lxApiPlaylistTracks(parsed.platform, parsed.nativeId, limit, offset);
            return toProviderPage(page, toUnifiedSong, offset, limit);
        },
        async getPlaylistDetail(id, collection) {
            // 歌单卡片本身已经带着名字与封面；没有卡片时给一个能看的占位。
            if (collection) return collection;
            const parsed = parseSongId(id);
            if (!parsed) return null;
            return { providerId: 'lxmusic', id, name: '歌单', type: 'playlist' };
        },
        async getAlbumTracks(id, limit, offset) {
            const take = limit ?? 50;
            const skip = offset ?? 0;
            const parsed = parseSongId(id);
            if (!parsed || !isPublicPlatform(parsed.platform)) return emptyPage<UnifiedSong>(skip);
            const page = await lxApiAlbumTracks(parsed.platform, parsed.nativeId, take, skip);
            return toProviderPage(page, toUnifiedSong, skip, take);
        },
        async getAlbumDetail(id, collection) {
            if (collection) return collection;
            const parsed = parseSongId(id);
            if (!parsed) return null;
            return { providerId: 'lxmusic', id, name: '专辑', type: 'album' };
        },
    },
};

// 以下是给「洛雪工作台」页面用的：把平台侧的数据顺手暴露出去，页面不必再认识 lxPublicApi。
export const lxBrowse = {
    platforms: LX_PUBLIC_PLATFORM_KEYS,
    charts: lxApiCharts,
    chartTracks: lxApiChartTracks,
    playlistSquare: lxApiPlaylistSquare,
    playlistTracks: lxApiPlaylistTracks,
    albumSquare: lxApiAlbumSquare,
    albumTracks: lxApiAlbumTracks,
    radioPrograms: lxApiRadioPrograms,
    searchSongs: lxApiSearchSongs,
    toSong: toUnifiedSong,
    toCollection: toProviderCollection,
};

void lxSourceStore.init();
