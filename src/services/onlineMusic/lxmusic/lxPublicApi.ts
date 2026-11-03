// src/services/onlineMusic/lxmusic/lxPublicApi.ts
//
// 洛雪的「平台侧」：直接读各家公开接口，把搜索结果、歌单广场、排行榜取回来。
//
// 为什么不用 folia 自带的 provider：那些 provider 是围绕「登录态 + 自建 API」写的，安卓上没有
// 自建服务，未登录时路径会断在 CORS / 401 上；而 LX 客户端用的是各家网页端那套公开接口，
// 不需要任何账号。这里照同一套接口实现，于是「导入音源之前」也能搜、能看歌单与榜单。
//
// 网络：地址一律过 resolveProxiedUrl——安卓上这些主机由原生 OkHttp 桥接管（不受 CORS 约束），
// 网页端交给本地 lyric-proxy 转发。所有接口都是 GET。

import { resolveProxiedUrl } from '../../proxiedUrl';

export type LxPublicPlatform = 'wy' | 'kg' | 'kw';

export const LX_PUBLIC_PLATFORMS: ReadonlyArray<{ key: LxPublicPlatform; label: string; color: string }> = [
    { key: 'wy', label: '网易云', color: '#dc2626' },
    { key: 'kg', label: '酷狗', color: '#2563eb' },
    { key: 'kw', label: '酷我', color: '#f59e0b' },
];

export const LX_PUBLIC_PLATFORM_KEYS: readonly LxPublicPlatform[] = LX_PUBLIC_PLATFORMS.map((p) => p.key);

export type LxApiArtist = { id?: string; name: string };

export type LxApiSong = {
    platform: LxPublicPlatform;
    id: string;
    name: string;
    artists: LxApiArtist[];
    album: { id?: string; name: string; coverUrl?: string };
    durationMs: number;
    coverUrl?: string;
};

export type LxApiCollection = {
    platform: LxPublicPlatform;
    id: string;
    name: string;
    kind: 'playlist' | 'album';
    coverUrl?: string;
    description?: string;
    trackCount?: number;
    playCount?: number;
    creatorName?: string;
    updatedAt?: number;
};

export type LxApiChart = {
    platform: LxPublicPlatform;
    id: string;
    name: string;
    coverUrl?: string;
    description?: string;
};

export type LxApiPage<T> = { items: T[]; hasMore: boolean };

// ---------------------------------------------------------------- 基础工具

type Raw = Record<string, any>;

const asRecord = (value: unknown): Raw | null => (value && typeof value === 'object' ? value as Raw : null);

const asArray = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter((v): v is Raw => Boolean(asRecord(v))) : []);

const pick = <T>(record: Raw | null | undefined, ...keys: string[]): T | undefined => {
    for (const key of keys) {
        const value = record?.[key];
        if (value !== undefined && value !== null && value !== '') return value as T;
    }
    return undefined;
};

const toText = (value: unknown): string => (value == null ? '' : String(value)).trim();

/** 酷我的标题里带 `&nbsp;` 这类实体，酷狗会带 `<em>` 高亮标签：一起清掉。 */
const decodeEntities = (value: string): string => value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

const stripTags = (value: unknown): string => decodeEntities(toText(value).replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

const toNumber = (value: unknown): number => {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
};

/**
 * 封面地址统一成能直接给 <img> 的 https 绝对地址：
 * 酷狗带 `{size}` 模板、协议相对地址 `//`、还有 `http://`（App 里是 https 页面，混内容会被拦）。
 */
const normalizeCover = (value: unknown, size = 240): string | undefined => {
    const raw = toText(value);
    if (!raw) return undefined;
    const sized = raw.replace('{size}', String(size));
    if (sized.startsWith('//')) return `https:${sized}`;
    if (/^http:\/\//i.test(sized)) return `https://${sized.slice('http://'.length)}`;
    return sized;
};

// 酷我封面 CDN 的路径前缀；短路径 `120/85/1/4091887608.jpg` 拼在 albumcover 下面。
const KUWO_COVER_BASE = 'https://img1.kuwo.cn/star/albumcover/';
const KUWO_COVER_SHORT_PATH = /^\d+\/[\w.-]+\/[\w.-]+\/[\w.-]+\.(?:jpe?g|png|webp)$/i;

/**
 * 酷我的搜索接口经常只给 `120/85/1/4091887608.jpg` 这种相对短路径，直接塞进 <img> 会当成
 * 页面内的相对文件去取（一定 404），还曾在启动自检里被当成「资源加载失败」整屏挡住。
 */
const normalizeKuwoCover = (value: unknown, size = 240): string | undefined => {
    const raw = toText(value);
    if (!raw) return undefined;
    const path = raw.replace(/^\/+/, '');
    if (/^star\//i.test(path) && !/^https?:/i.test(raw)) return `https://img1.kuwo.cn/${path}`;
    if (KUWO_COVER_SHORT_PATH.test(path)) return `${KUWO_COVER_BASE}${path}`;
    return normalizeCover(raw, size);
};

const splitArtists = (value: unknown): LxApiArtist[] => toText(value)
    .split(/[、,&/]| feat\.? /i)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name }));

/** 酷我 r.s 返回的是单引号 JSON；解析失败时退一步把它们换成双引号再试。 */
const parseLooseJson = (text: string): unknown => {
    const trimmed = text.trim().replace(/^\uFEFF/, '');
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        // 继续往下试
    }
    try {
        return JSON.parse(trimmed.replace(/'/g, '"'));
    } catch {
        return null;
    }
};

const REQUEST_TIMEOUT_MS = 12000;

const fetchJson = async (
    url: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
    referer = 'https://music.163.com/',
): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(resolveProxiedUrl(url), {
            method: 'GET',
            signal: controller.signal,
            credentials: 'omit',
            // 网易云对没有 referer 的请求偶尔回 403；安卓桥会原样带过去，网页端由浏览器忽略。
            headers: { Referer: referer },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parseLooseJson(await response.text());
    } finally {
        clearTimeout(timer);
    }
};

const fetchText = async (url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(resolveProxiedUrl(url), {
            method: 'GET',
            signal: controller.signal,
            credentials: 'omit',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.text()).trim();
    } finally {
        clearTimeout(timer);
    }
};

const pageOf = <T>(items: T[], limit: number): LxApiPage<T> => ({
    items: items.slice(0, limit),
    hasMore: items.length >= limit,
});

const pageIndex = (offset: number, limit: number): number => Math.floor(Math.max(0, offset) / Math.max(1, limit)) + 1;

// ---------------------------------------------------------------- 网易云

const NETEASE_BASE = 'https://music.163.com';

const neteaseSong = (raw: Raw): LxApiSong => {
    const album = asRecord(raw.album) ?? asRecord(raw.al);
    const artists = asArray(raw.artists ?? raw.ar);
    return {
        platform: 'wy',
        id: toText(raw.id),
        name: toText(raw.name),
        artists: artists
            .map((artist) => ({ id: artist.id != null ? String(artist.id) : undefined, name: toText(artist.name) }))
            .filter((artist) => artist.name),
        album: {
            id: album?.id != null ? String(album.id) : undefined,
            name: toText(album?.name),
            coverUrl: normalizeCover(pick(album, 'picUrl', 'coverUrl')),
        },
        durationMs: toNumber(pick(raw, 'duration', 'dt', 'durationMs')),
        coverUrl: normalizeCover(pick(album, 'picUrl', 'coverUrl')),
    };
};

const neteaseCollection = (raw: Raw): LxApiCollection => ({
    platform: 'wy',
    id: toText(raw.id),
    name: toText(raw.name),
    kind: 'playlist',
    coverUrl: normalizeCover(pick(raw, 'coverImgUrl', 'picUrl')),
    description: toText(raw.description) || undefined,
    trackCount: toNumber(pick(raw, 'trackCount')) || undefined,
    playCount: toNumber(pick(raw, 'playCount')) || undefined,
    creatorName: toText(asRecord(raw.creator)?.nickname) || undefined,
    updatedAt: toNumber(pick(raw, 'updateTime', 'trackNumberUpdateTime')) || undefined,
});

/** 网易云偶尔回 `code: -462`（风控要求验证）之类的错误，这时不能当成「空歌单」糊过去。 */
const ensureNetease = (payload: unknown): Raw | null => {
    const record = asRecord(payload);
    const code = record ? Number(record.code) : Number.NaN;
    if (Number.isFinite(code) && code !== 200 && code !== 0) {
        throw new Error(`网易云返回 ${code}${record?.message ? `：${String(record.message)}` : ''}`);
    }
    return record;
};

const NETEASE_SEARCH_KIND = { song: 1, album: 10, playlist: 1000 } as const;

const neteaseSearch = async (
    keyword: string,
    kind: keyof typeof NETEASE_SEARCH_KIND,
    limit: number,
    offset: number,
): Promise<unknown> => fetchJson(
    `${NETEASE_BASE}/api/search/get/web?s=${encodeURIComponent(keyword)}&type=${NETEASE_SEARCH_KIND[kind]}&limit=${limit}&offset=${offset}`,
);

// 网易云的榜单就是四个固定歌单：直接按歌单详情读，曲目字段与搜索一致。
const NETEASE_CHARTS: ReadonlyArray<{ id: string; name: string }> = [
    { id: '19723756', name: '飙升榜' },
    { id: '3778678', name: '热歌榜' },
    { id: '3779629', name: '新歌榜' },
    { id: '2884035', name: '原创榜' },
];

// ---------------------------------------------------------------- 酷狗

const KUGOU_SEARCH_HOST = 'https://mobiles.kugou.com';
const KUGOU_WEB_HOST = 'https://m.kugou.com';

/** 酷狗把「歌手 - 歌名」塞在 filename 里，缺字段时用它拆。 */
const kugouSongName = (raw: Raw): { name: string; artist: string } => {
    const name = stripTags(pick(raw, 'songname', 'song_name', 'name'));
    const artist = stripTags(pick(raw, 'singername', 'singer_name', 'author_name'));
    if (name && artist) return { name, artist };
    const filename = stripTags(pick(raw, 'filename', 'fileName'));
    const split = filename.split(' - ');
    if (split.length >= 2) {
        return { name: name || split.slice(1).join(' - '), artist: artist || split[0] };
    }
    return { name: name || filename, artist };
};

const kugouSong = (raw: Raw): LxApiSong => {
    const { name, artist } = kugouSongName(raw);
    const trans = asRecord(raw.trans_param);
    const cover = normalizeCover(pick(trans, 'union_cover', 'album_sizable_cover') ?? pick(raw, 'imgurl', 'album_sizable_cover'));
    return {
        platform: 'kg',
        id: toText(pick(raw, 'hash', 'hash_128', 'FileHash')),
        name,
        artists: splitArtists(artist),
        album: {
            id: toText(pick(raw, 'album_id', 'albumid')) || undefined,
            name: stripTags(pick(raw, 'album_name', 'albumname')),
            coverUrl: cover,
        },
        // 酷狗的时长单位是秒。
        durationMs: toNumber(pick(raw, 'duration', 'timelength', 'timeLength')) * 1000,
        coverUrl: cover,
    };
};

const kugouCollection = (raw: Raw): LxApiCollection => ({
    platform: 'kg',
    id: toText(pick(raw, 'specialid', 'specialId', 'id')),
    name: stripTags(pick(raw, 'specialname', 'special_name', 'name')),
    kind: 'playlist',
    coverUrl: normalizeCover(pick(raw, 'imgurl', 'img_9', 'album_img_9', 'cover')),
    description: stripTags(pick(raw, 'intro', 'description')) || undefined,
    trackCount: toNumber(pick(raw, 'songcount', 'song_count')) || undefined,
    playCount: toNumber(pick(raw, 'playcount', 'play_count')) || undefined,
    creatorName: stripTags(pick(raw, 'nickname', 'username', 'create_user_name')) || undefined,
    updatedAt: toNumber(pick(raw, 'publishtime', 'create_time')) || undefined,
});

const kugouChart = (raw: Raw): LxApiChart => ({
    platform: 'kg',
    id: toText(pick(raw, 'rankid', 'rank_id', 'id')),
    name: stripTags(pick(raw, 'rankname', 'rank_name', 'name')),
    coverUrl: normalizeCover(pick(raw, 'imgurl', 'img_9', 'album_img_9', 'banner_9')),
    description: stripTags(pick(raw, 'intro')) || undefined,
});

// ---------------------------------------------------------------- 酷我

/** 酷我的榜单 id 是固定编号（网页端一直在用），没有目录接口。 */
const KUWO_CHARTS: ReadonlyArray<{ id: string; name: string }> = [
    { id: '93', name: '飙升榜' },
    { id: '16', name: '热歌榜' },
    { id: '17', name: '新歌榜' },
    { id: '26', name: '经典榜' },
    { id: '62', name: '华语榜' },
    { id: '145', name: '畅销榜' },
];

/** 酷我的歌曲 id 在接口里写作 `MUSIC_123456`。 */
const kuwoIdOf = (value: unknown): string => toText(value).replace(/^MUSIC_/i, '');

const kuwoSong = (raw: Raw): LxApiSong => {
    const cover = normalizeKuwoCover(pick(raw, 'web_albumpic_short', 'web_album_short', 'albumpic', 'pic'));
    // 榜单里的 `duration` 不是时长（有时是 2），`song_duration` 才是秒数；搜索结果是 `DURATION`。
    const seconds = Math.max(toNumber(pick(raw, 'DURATION', 'duration')), toNumber(pick(raw, 'song_duration')));
    return {
        platform: 'kw',
        id: kuwoIdOf(pick(raw, 'MUSICRID', 'musicrid', 'rid', 'id')),
        name: stripTags(pick(raw, 'SONGNAME', 'name', 'songname')),
        artists: splitArtists(stripTags(pick(raw, 'ARTIST', 'artist', 'aartist'))),
        album: {
            id: kuwoIdOf(pick(raw, 'ALBUMID', 'albumid')) || undefined,
            name: stripTags(pick(raw, 'ALBUM', 'album')),
            coverUrl: cover,
        },
        durationMs: seconds * 1000,
        coverUrl: cover,
    };
};

// ---------------------------------------------------------------- 对外接口

export const lxApiSearchSongs = async (
    platform: LxPublicPlatform,
    keyword: string,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiSong>> => {
    const page = pageIndex(offset, limit);
    if (platform === 'wy') {
        const payload = asRecord(await neteaseSearch(keyword, 'song', limit, offset));
        const songs = asArray(asRecord(payload?.result)?.songs).map(neteaseSong).filter((s) => s.id && s.name);
        return pageOf(songs, limit);
    }
    if (platform === 'kg') {
        const payload = asRecord(await fetchJson(
            `${KUGOU_SEARCH_HOST}/api/v3/search/song?format=json&keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}&showtype=1`,
        ));
        const songs = asArray(asRecord(payload?.data)?.info).map(kugouSong).filter((s) => s.id && s.name);
        return pageOf(songs, limit);
    }
    const payload = asRecord(await fetchJson(
        `https://search.kuwo.cn/r.s?all=${encodeURIComponent(keyword)}&ft=music&itemset=web_2013&client=kt&pn=${page - 1}&rn=${limit}&rformat=json&encoding=utf8`,
    ));
    const songs = asArray(payload?.abslist).map(kuwoSong).filter((s) => s.id && s.name);
    return pageOf(songs, limit);
};

export const lxApiSearchPlaylists = async (
    platform: LxPublicPlatform,
    keyword: string,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiCollection>> => {
    const page = pageIndex(offset, limit);
    if (platform === 'wy') {
        const payload = asRecord(await neteaseSearch(keyword, 'playlist', limit, offset));
        const list = asArray(asRecord(payload?.result)?.playlists).map(neteaseCollection).filter((c) => c.id && c.name);
        return pageOf(list, limit);
    }
    if (platform === 'kg') {
        const payload = asRecord(await fetchJson(
            `${KUGOU_SEARCH_HOST}/api/v3/search/special?format=json&keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}`,
        ));
        const list = asArray(asRecord(payload?.data)?.info).map(kugouCollection).filter((c) => c.id && c.name);
        return pageOf(list, limit);
    }
    return { items: [], hasMore: false };
};

export const lxApiSearchAlbums = async (
    platform: LxPublicPlatform,
    keyword: string,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiCollection>> => {
    if (platform !== 'wy') return { items: [], hasMore: false };
    const payload = asRecord(await neteaseSearch(keyword, 'album', limit, offset));
    const list = asArray(asRecord(payload?.result)?.albums).map((raw) => ({
        platform: 'wy' as const,
        id: toText(raw.id),
        name: toText(raw.name),
        kind: 'album' as const,
        coverUrl: normalizeCover(pick(raw, 'picUrl', 'blurPicUrl')),
        trackCount: toNumber(raw.size) || undefined,
        creatorName: toText(asRecord(raw.artist)?.name) || undefined,
        updatedAt: toNumber(pick(raw, 'publishTime')) || undefined,
    })).filter((item) => item.id && item.name);
    return pageOf(list, limit);
};

/** 歌单广场：各家「热门歌单」首页。酷我没有稳定的公开入口，返回空。 */
export const lxApiPlaylistSquare = async (
    platform: LxPublicPlatform,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiCollection>> => {
    const page = pageIndex(offset, limit);
    if (platform === 'wy') {
        const payload = asRecord(await fetchJson(
            `${NETEASE_BASE}/api/playlist/list?cat=${encodeURIComponent('全部')}&order=hot&offset=${offset}&limit=${limit}`,
        ));
        const list = asArray(payload?.playlists).map(neteaseCollection).filter((c) => c.id && c.name);
        return pageOf(list, limit);
    }
    if (platform === 'kg') {
        const payload = asRecord(await fetchJson(`${KUGOU_WEB_HOST}/plist/index&json=true&page=${page}`));
        const info = asRecord(asRecord(asRecord(payload?.plist)?.list));
        const list = asArray(info?.info).map(kugouCollection).filter((c) => c.id && c.name);
        return pageOf(list, limit);
    }
    return { items: [], hasMore: false };
};

export const lxApiCharts = async (platform: LxPublicPlatform): Promise<LxApiChart[]> => {
    if (platform === 'kg') {
        const payload = asRecord(await fetchJson(`${KUGOU_WEB_HOST}/rank/list&json=true`));
        const list = asArray(asRecord(payload?.rank)?.list).map(kugouChart).filter((c) => c.id && c.name);
        if (list.length > 0) return list;
    }
    if (platform === 'wy') {
        return NETEASE_CHARTS.map((chart) => ({ platform, id: chart.id, name: chart.name }));
    }
    return KUWO_CHARTS.map((chart) => ({ platform, id: chart.id, name: chart.name }));
};

export const lxApiChartTracks = async (
    platform: LxPublicPlatform,
    chartId: string,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiSong>> => {
    const page = pageIndex(offset, limit);
    if (platform === 'wy') {
        // 网易云的榜单本身就是歌单。
        return lxApiPlaylistTracks(platform, chartId, limit, offset);
    }
    if (platform === 'kg') {
        const payload = asRecord(await fetchJson(`${KUGOU_WEB_HOST}/rank/info/?rankid=${encodeURIComponent(chartId)}&page=${page}&json=true`));
        const songs = asArray(asRecord(payload?.songs)?.list).map(kugouSong).filter((s) => s.id && s.name);
        return pageOf(songs, limit);
    }
    const payload = asRecord(await fetchJson(
        `https://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&pn=${page - 1}&rn=${limit}&type=bang&data=content&id=${encodeURIComponent(chartId)}&show_copyright_off=1`,
    ));
    const songs = asArray(payload?.musiclist).map(kuwoSong).filter((s) => s.id && s.name);
    return pageOf(songs, limit);
};

export const lxApiPlaylistTracks = async (
    platform: LxPublicPlatform,
    playlistId: string,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiSong>> => {
    const page = pageIndex(offset, limit);
    if (platform === 'wy') {
        const payload = ensureNetease(await fetchJson(`${NETEASE_BASE}/api/playlist/detail?id=${encodeURIComponent(playlistId)}`));
        const tracks = asArray(asRecord(payload?.result)?.tracks).map(neteaseSong).filter((s) => s.id && s.name);
        // 歌单详情一次给全（上限 1000 首），在本地切片。
        return { items: tracks.slice(offset, offset + limit), hasMore: tracks.length > offset + limit };
    }
    if (platform === 'kg') {
        const payload = asRecord(await fetchJson(
            `${KUGOU_SEARCH_HOST}/api/v3/special/song?specialid=${encodeURIComponent(playlistId)}&page=${page}&pagesize=${limit}&plat=0&version=8000`,
        ));
        const songs = asArray(asRecord(payload?.data)?.info).map(kugouSong).filter((s) => s.id && s.name);
        return pageOf(songs, limit);
    }
    return { items: [], hasMore: false };
};

export const lxApiAlbumTracks = async (
    platform: LxPublicPlatform,
    albumId: string,
    limit: number,
    offset: number,
): Promise<LxApiPage<LxApiSong>> => {
    if (platform !== 'wy') return { items: [], hasMore: false };
    const payload = ensureNetease(await fetchJson(`${NETEASE_BASE}/api/album/${encodeURIComponent(albumId)}`));
    const songs = asArray(asRecord(payload?.album)?.songs).map(neteaseSong).filter((s) => s.id && s.name);
    return { items: songs.slice(offset, offset + limit), hasMore: songs.length > offset + limit };
};

/**
 * 酷狗 `m.kugou.com` 的播放信息接口：免费曲目直接给一条 CDN 直链，付费 / 独家曲目的 url 是空串。
 * 先把能放的那批放出来，剩下的再交给导入的 LX 音源。
 */
const kugouFreeAudioUrl = async (hash: string): Promise<string | null> => {
    try {
        const payload = asRecord(await fetchJson(
            `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`,
            9000,
            'https://m.kugou.com/',
        ));
        const url = toText(payload?.url);
        return /^https?:\/\//i.test(url) ? url : null;
    } catch {
        return null;
    }
};

/** 酷我 / 酷狗有免费直链（其余靠音源续）。返回 null 表示这次没取到，交给音源。 */
export const lxApiFreeAudioUrl = async (platform: LxPublicPlatform, songId: string): Promise<string | null> => {
    if (platform === 'kg') return kugouFreeAudioUrl(songId);
    if (platform !== 'kw') return null;
    try {
        const url = await fetchText(
            `https://antiserver.kuwo.cn/anti.s?type=convert_url&rvid=MUSIC_${encodeURIComponent(songId)}&format=mp3&response=url`,
            9000,
        );
        return /^https?:\/\//i.test(url) ? url : null;
    } catch {
        return null;
    }
};

const LRC_TIME = (seconds: number): string => {
    const safe = Math.max(0, seconds);
    const minutes = Math.floor(safe / 60);
    const rest = safe - minutes * 60;
    return `[${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}]`;
};

/** 歌词：网易云 / 酷我都有关联的公开接口，酷狗只能走音源。 */
export const lxApiLyric = async (
    platform: LxPublicPlatform,
    songId: string,
): Promise<{ main: string | null; translation: string | null }> => {
    if (platform === 'wy') {
        const payload = asRecord(await fetchJson(
            `${NETEASE_BASE}/api/song/lyric?id=${encodeURIComponent(songId)}&lv=1&kv=1&tv=-1`,
        ));
        return {
            main: toText(asRecord(payload?.lrc)?.lyric) || null,
            translation: toText(asRecord(payload?.tlyric)?.lyric) || null,
        };
    }
    if (platform === 'kw') {
        const payload = asRecord(await fetchJson(
            `https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(songId)}`,
        ));
        const lines = asArray(asRecord(payload?.data)?.lrclist);
        if (lines.length === 0) return { main: null, translation: null };
        const main = lines
            .map((line) => `${LRC_TIME(toNumber(line.time))}${toText(line.lineLyric)}`)
            .join('\n');
        return { main, translation: null };
    }
    return { main: null, translation: null };
};
