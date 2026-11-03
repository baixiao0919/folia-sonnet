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
import { raceCandidates, type LxRaceTask } from './lxRace';
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
const buildMusicInfo = (platform: LxPlatformKey, nativeId: string, song: SongResult): Record<string, unknown> => {
    const artistNames = song.artists.map((artist) => artist.name).join(',');
    const durationSec = Math.round((song.durationMs ?? 0) / 1000);
    return {
        songid: nativeId,
        songmid: nativeId,
        musicId: nativeId,
        id: nativeId,
        mid: nativeId,
        // 酷狗自定义源普遍读 hash。
        hash: nativeId,
        // 酷我系音源会读这几个。
        rid: nativeId,
        songId: nativeId,
        copyrightId: nativeId,
        name: song.name,
        title: song.name,
        singer: artistNames,
        artist: artistNames,
        albumName: song.album?.name ?? '',
        album: song.album?.name ?? '',
        interval: durationSec,
        duration: durationSec,
        musicid: nativeId,
        platform,
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

/**
 * 「全都走音源」的实现（v15 改成并发竞速）：
 *   1. 本平台所有音源**同时**出手，谁先给出「能被 <audio> 打开」的地址就用谁；
 *   2. 同时并行去别家平台搜同一首歌（各家一条链），用那家的 id 再让音源出地址；
 *   3. 最后还有公开免费直链一起参与竞速。
 *
 * 这样「一个源不行」不再是「等它超时再试下一个」，而是「别人早就跑在前面了」。
 * 死源会被记进健康度（lxSourceHealth），连续失败后进入冷却，下次直接排到最后。
 *
 * 地址按「平台:原生 id:音质」缓存：内存 30 分钟（同一次会话里直接命中，不探活），
 * 落盘 3 小时（下次开 App 也能秒开，但命中时先探一下活，免得拿到过期的签名）。
 */
const PLAYBACK_CACHE_TTL = 30 * 60 * 1000;
const PERSISTED_CACHE_TTL = 3 * 60 * 60 * 1000;
const CACHE_STORAGE_KEY = 'lxmusic_playback_cache_v1';
const CACHE_LIMIT = 400;

type PlaybackCacheEntry = { url: string; at: number; persisted: boolean };

const playbackCache = new Map<string, PlaybackCacheEntry>();
let persistedCacheLoaded = false;
let cacheSaveTimer: number | null = null;

const loadPersistedCache = (): void => {
    if (persistedCacheLoaded) return;
    persistedCacheLoaded = true;
    try {
        const raw = localStorage.getItem(CACHE_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, { url?: string; at?: number }>;
        const now = Date.now();
        Object.entries(parsed).forEach(([key, value]) => {
            if (typeof value?.url !== 'string' || typeof value?.at !== 'number') return;
            if (now - value.at > PERSISTED_CACHE_TTL) return;
            playbackCache.set(key, { url: value.url, at: value.at, persisted: true });
        });
    } catch {
        // 缓存坏了就当没有。
    }
};

const saveCacheSoon = (): void => {
    if (cacheSaveTimer !== null) return;
    cacheSaveTimer = window.setTimeout(() => {
        cacheSaveTimer = null;
        try {
            const now = Date.now();
            const entries = [...playbackCache.entries()]
                .filter(([, entry]) => now - entry.at < PERSISTED_CACHE_TTL)
                .sort((a, b) => b[1].at - a[1].at)
                .slice(0, CACHE_LIMIT);
            localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
        } catch {
            // 存不下就算了，下次多花几百毫秒。
        }
    }, 2000);
};

const readCachedUrl = (key: string): PlaybackCacheEntry | null => {
    loadPersistedCache();
    const entry = playbackCache.get(key);
    if (!entry) return null;
    const ttl = entry.persisted ? PERSISTED_CACHE_TTL : PLAYBACK_CACHE_TTL;
    if (Date.now() - entry.at > ttl) {
        playbackCache.delete(key);
        return null;
    }
    return entry;
};

const writeCachedUrl = (key: string, url: string): void => {
    playbackCache.set(key, { url, at: Date.now(), persisted: false });
    saveCacheSoon();
};

/** 跨平台兜底时的尝试顺序：优先音源生态里最稳的酷狗 / 酷我，再网易云、QQ。 */
const FALLBACK_PLATFORM_ORDER: LxPublicPlatform[] = ['kg', 'kw', 'wy', 'tx'];

const simplifyText = (text: string): string => text
    .toLowerCase()
    .replace(/[\s\-_/\\()（）[\]【】<>《》·,，.。!！?？'"“”‘’&+]/g, '');

/** 在搜索结果里挑同名同歌手的那首，时长差太多的直接判负。 */
const pickBestMatch = (candidates: LxApiSong[], song: SongResult): LxApiSong | null => {
    const name = simplifyText(song.name);
    const artists = song.artists.map((artist) => simplifyText(artist.name));
    let best: { item: LxApiSong; score: number } | null = null;
    for (const item of candidates) {
        const itemName = simplifyText(item.name);
        let score = 0;
        if (itemName === name) score += 6;
        else if (itemName.includes(name) || name.includes(itemName)) score += 3;
        else continue;

        const itemArtists = item.artists.map((artist) => simplifyText(artist.name));
        if (itemArtists.some((artist) => artists.includes(artist))) score += 4;
        else if (itemArtists.some((artist) => artists.some((target) => artist.includes(target) || target.includes(artist)))) score += 2;

        if (song.durationMs && item.durationMs) {
            const diff = Math.abs(song.durationMs - item.durationMs);
            if (diff < 3000) score += 2;
            else if (diff > 20000) score -= 2;
        }
        if (!best || score > best.score) best = { item, score };
    }
    return best && best.score >= 6 ? best.item : null;
};

/**
 * 音源给的地址先探一下活。
 * 第三方音源的后端经常「地址给得出来、点开是 404 / 一段 HTML」，播放器只会静默失败。
 *
 * 这里用隐藏的 <audio> 加载 metadata，而不是 fetch：音频 CDN 基本都不带 CORS 头，
 * fetch 会因为跨域直接失败，会把好好的地址判成死链；<audio> 走的正是真正播放的路径。
 * 探活是并发竞速里最贵的一段，所以超时压到 6 秒，到点就当这个源不行、让位给下一个。
 */
const probeAudioUrl = (value: unknown): Promise<boolean> => new Promise((resolve) => {
    const url = typeof value === 'string'
        ? value
        : (value as { url?: unknown } | null)?.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        resolve(false);
        return;
    }

    const audio = new Audio();
    let settled = false;
    const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        audio.removeEventListener('loadedmetadata', onLoaded);
        audio.removeEventListener('error', onError);
        // 主动释放，避免探活把连接一直挂着。
        try {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
        } catch {
            // 忽略：只是清理。
        }
        resolve(ok);
    };
    const onLoaded = () => finish(true);
    const onError = () => finish(false);
    const timer = window.setTimeout(() => finish(false), 6000);

    audio.addEventListener('loadedmetadata', onLoaded, { once: true });
    audio.addEventListener('error', onError, { once: true });
    audio.preload = 'metadata';
    audio.muted = true;
    audio.src = url;
    audio.load();
});

type AudioCandidate = { url: string; headers?: Record<string, string> };

const asCandidate = (value: string | AudioCandidate | null): AudioCandidate | null => {
    if (!value) return null;
    return typeof value === 'string' ? { url: value } : value;
};

/** 某个平台上所有可用音源，各建一条取地址的任务（内部已按健康度排好序）。 */
const sourceTasksFor = (
    platform: LxPlatformKey,
    nativeId: string,
    song: SongResult,
    quality: AudioQualityPreference,
): LxRaceTask<AudioCandidate>[] => {
    const supported = sourceQualityFor(platform);
    if (supported.length === 0) return [];
    const lxQuality = foliaQualityToLx(quality, supported);
    if (!lxQuality) return [];
    return lxSourceStore
        .musicTasksFor(platform, lxQuality, buildMusicInfo(platform, nativeId, song), probeAudioUrl)
        .map((task) => ({
            label: task.label,
            run: async () => asCandidate(await task.run()),
        }));
};

/** 去别家平台找同一首歌，返回那家的 id。 */
const findNativeIdOn = async (platform: LxPublicPlatform, song: SongResult): Promise<string | null> => {
    try {
        const query = `${song.name} ${song.artists[0]?.name ?? ''}`.trim();
        const page = await lxApiSearchSongs(platform, query, 8, 0);
        return pickBestMatch(page.items, song)?.id ?? null;
    } catch (error) {
        console.warn(`[lxmusic] 在 ${platform} 找同一首歌失败：`, error);
        return null;
    }
};

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

            const cacheKey = `${parsed.platform}:${parsed.nativeId}:${quality}`;
            const cached = readCachedUrl(cacheKey);
            if (cached) {
                // 同一会话里刚用过：直接用。落盘的（上次开 App 时拿的）先探一下活，
                // 签名过期的地址别拿去喂播放器 —— 探活几百毫秒，重解析要几秒。
                if (!cached.persisted || await probeAudioUrl(cached.url)) {
                    return { url: cached.url, fetchedAt: cached.at, quality };
                }
                playbackCache.delete(cacheKey);
            }

            // 音源是异步初始化的（不少脚本要先探测接口才 send('inited')），
            // 刚打开 App 就点播放时它可能还没就绪，这里等一小会儿。
            await lxSourceStore.ensureReady();

            /**
             * 给定音质，把所有候选一起放出去：
             *   1) 本平台每个音源一条任务，谁先出「能播」的地址谁赢；
             *   2) 每家跨平台一条链（搜同款 → 那家的音源出地址），各家并行不排队；
             *   3) 公开免费直链一起参与，酷我 / 酷狗的免费曲目常常比音源还快。
             */
            const raceFor = (targetQuality: AudioQualityPreference): Promise<AudioCandidate | null> => {
                const tasks: LxRaceTask<AudioCandidate>[] = [];
                tasks.push(...sourceTasksFor(parsed.platform, parsed.nativeId, song, targetQuality));

                for (const platform of FALLBACK_PLATFORM_ORDER) {
                    if (platform === parsed.platform) continue;
                    if (!lxSourceStore.canResolve(platform, 'musicUrl')) continue;
                    // 已知全在冷却的平台往后排：别让它们占着并发名额。
                    const priority = lxSourceStore.hasLiveSourceFor(platform, 'musicUrl') ? 0 : 1;
                    tasks.push({
                        label: `跨平台/${platform}`,
                        priority,
                        run: async () => {
                            const nativeId = await findNativeIdOn(platform, song);
                            if (!nativeId) return null;
                            const chain = sourceTasksFor(platform, nativeId, song, targetQuality);
                            if (chain.length === 0) return null;
                            // 链内部也竞速，但别和外面抢太多并发：两个一起试就够。
                            return raceCandidates(chain, { initial: 2, staggerMs: 300, maxConcurrent: 2 });
                        },
                    });
                }

                const publicPlatform = parsed.platform;
                if (isPublicPlatform(publicPlatform)) {
                    tasks.push({
                        label: `公开直链/${publicPlatform}`,
                        run: async () => {
                            const url = await lxApiFreeAudioUrl(publicPlatform, parsed.nativeId);
                            if (!url) return null;
                            return (await probeAudioUrl(url)) ? { url } : null;
                        },
                    });
                }

                if (tasks.length === 0) return Promise.resolve(null);
                tasks.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
                return raceCandidates(tasks, { initial: 3, staggerMs: 220, maxConcurrent: 6 });
            };

            let winner = await raceFor(quality);
            // 首选音质整轮都没成（源只给无损、而设备放不动，或这一档的链接全过期）时，
            // 再用标准音质试一轮：能出声比音质重要。
            if (!winner && quality !== 'standard') {
                console.warn(`[lxmusic] ${parsed.platform}:${parsed.nativeId} 在 ${quality} 没有可用地址，降到标准音质再试`);
                winner = await raceFor('standard');
            }

            if (!winner) return null;
            writeCachedUrl(cacheKey, winner.url);
            return { url: winner.url, fetchedAt: Date.now(), quality };
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
            const raw = await lxSourceStore.resolveLyric(parsed.platform, buildMusicInfo(parsed.platform, parsed.nativeId, song));
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
