import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Play, RefreshCw } from 'lucide-react';
import type { Theme, UnifiedSong } from '../../types';
import type { ProviderCollection } from '../../types/onlineMusic';
import { useLxWorkspaceStore, type LxWorkspaceTab } from '../../stores/useLxWorkspaceStore';
import { lxBrowse, lxmusicProvider } from '../../services/onlineMusic/lxmusic/lxmusicProvider';
import { lxSourceStore } from '../../services/onlineMusic/lxmusic/lxSourceStore';
import type { LxPlatformKey } from '../../services/onlineMusic/lxmusic/lxTypes';
import {
    LX_PUBLIC_PLATFORMS,
    type LxApiChart,
    type LxPublicPlatform,
} from '../../services/onlineMusic/lxmusic/lxPublicApi';
import { LxTrackList } from './LxTrackList';
import { LxSourcePanel } from './LxSourcePanel';
import { errorText, formatCount, formatDate, platformBadge } from './lxUi';
import './lxWorkspace.css';

// src/components/lxmusic/LxWorkspace.tsx
// 洛雪工作台：一页把客户端那套东西搬过来。
//   歌单 —— 每个平台的歌单广场（封面 / 作者 / 播放量），点开是曲目表；
//   榜单 —— 平台下的各个排行榜，左边选榜右边是歌；
//   搜索 —— 三家一起搜，结果交替排列；
//   音源 —— 导入 / 启用 / 删除 LX 音源脚本。
// 页面挂在应用级浮层上，播放与加入队列直接复用搜索结果那两条回调。

const TABS: ReadonlyArray<{ key: LxWorkspaceTab; label: string }> = [
    { key: 'playlist', label: '歌单' },
    { key: 'chart', label: '榜单' },
    { key: 'search', label: '搜索' },
    { key: 'source', label: '音源' },
];

// 一页 30：酷狗的歌单广场接口固定每页 30 条，页大小对不上的话翻页会漏歌。
const PAGE_SIZE = 30;
const TRACK_PAGE_SIZE = 60;
/** 搜索时每个平台各取多少（三家交替，一屏大概 3 倍条数）。 */
const SEARCH_PAGE_SIZE = 24;

type DetailView = {
    platform: LxPublicPlatform;
    id: string;
    title: string;
    subtitle?: string;
    coverUrl?: string;
};

type LxWorkspaceProps = {
    theme: Theme;
    isDaylight: boolean;
    onClose: () => void;
    onPlayTrack: (track: UnifiedSong) => void;
    onAddToQueue: (track: UnifiedSong) => void;
};

const platformOfCollection = (collection: ProviderCollection, fallback: LxPublicPlatform): LxPublicPlatform => {
    const raw = collection.providerData?.platform;
    if (raw === 'wy' || raw === 'kg' || raw === 'kw') return raw;
    return fallback;
};

export const LxWorkspace: React.FC<LxWorkspaceProps> = ({ theme, isDaylight, onClose, onPlayTrack, onAddToQueue }) => {
    const tab = useLxWorkspaceStore((state) => state.tab);
    const setTab = useLxWorkspaceStore((state) => state.setTab);

    const [platform, setPlatform] = useState<LxPublicPlatform>('wy');
    const platformRef = useRef(platform);
    platformRef.current = platform;

    // 音源变动后重算「能不能放」的提示（store 不是响应式的，用一个计数逼一次重渲染）。
    const [, bumpSourceTick] = useState(0);
    const handleSourceChanged = useCallback(() => bumpSourceTick((prev) => prev + 1), []);
    const [refreshTick, setRefreshTick] = useState(0);

    // 播放回执：播放器在浮层底下，点完不给一句反馈会以为没反应。
    const [playHint, setPlayHint] = useState<string | null>(null);
    const playHintTimer = useRef<number | null>(null);
    const handlePlay = useCallback((song: UnifiedSong) => {
        onPlayTrack(song);
        setPlayHint(`正在播放 · ${song.name}`);
        if (playHintTimer.current) window.clearTimeout(playHintTimer.current);
        playHintTimer.current = window.setTimeout(() => setPlayHint(null), 2600);
    }, [onPlayTrack]);
    useEffect(() => () => {
        if (playHintTimer.current) window.clearTimeout(playHintTimer.current);
    }, []);

    // 歌单广场
    const [collections, setCollections] = useState<ProviderCollection[]>([]);
    const [collectionsLoading, setCollectionsLoading] = useState(false);
    const [collectionsHasMore, setCollectionsHasMore] = useState(false);
    const [collectionsOffset, setCollectionsOffset] = useState(0);
    const [collectionsError, setCollectionsError] = useState<string | null>(null);

    // 歌单 / 榜单里的曲目
    const [detail, setDetail] = useState<DetailView | null>(null);
    const [detailSongs, setDetailSongs] = useState<UnifiedSong[]>([]);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailHasMore, setDetailHasMore] = useState(false);
    const [detailOffset, setDetailOffset] = useState(0);
    const [detailError, setDetailError] = useState<string | null>(null);

    // 榜单
    const [charts, setCharts] = useState<LxApiChart[]>([]);
    const [chartId, setChartId] = useState<string | null>(null);
    const [chartSongs, setChartSongs] = useState<UnifiedSong[]>([]);
    const [chartLoading, setChartLoading] = useState(false);
    const [chartError, setChartError] = useState<string | null>(null);

    // 搜索
    const [query, setQuery] = useState('');
    const [submittedQuery, setSubmittedQuery] = useState('');
    const [searchSongs, setSearchSongs] = useState<UnifiedSong[]>([]);
    const [searchOffset, setSearchOffset] = useState(0);
    const [searchLoading, setSearchLoading] = useState(false);
    const [searchHasMore, setSearchHasMore] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);

    // ------------------------------------------------------------ 歌单广场

    const loadCollections = useCallback(async (target: LxPublicPlatform, offset: number, append: boolean) => {
        setCollectionsLoading(true);
        if (!append) setCollectionsError(null);
        try {
            const page = await lxBrowse.playlistSquare(target, PAGE_SIZE, offset);
            if (platformRef.current !== target) return;
            const items = page.items.map(lxBrowse.toCollection);
            setCollections((prev) => (append ? [...prev, ...items] : items));
            setCollectionsOffset(offset + page.items.length);
            setCollectionsHasMore(page.hasMore);
        } catch (error) {
            if (platformRef.current !== target) return;
            setCollectionsError(`歌单读取失败：${errorText(error)}`);
        } finally {
            setCollectionsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (tab !== 'playlist') return;
        setCollections([]);
        setCollectionsOffset(0);
        setCollectionsHasMore(false);
        void loadCollections(platform, 0, false);
    }, [tab, platform, refreshTick, loadCollections]);

    // ------------------------------------------------------------ 榜单

    useEffect(() => {
        if (tab !== 'chart') return undefined;
        let cancelled = false;
        setChartError(null);
        setCharts([]);
        setChartId(null);
        setChartSongs([]);
        void lxBrowse.charts(platform)
            .then((list) => {
                if (cancelled) return;
                setCharts(list);
                setChartId(list[0]?.id ?? null);
                if (list.length === 0) setChartError('这个平台没有可读的榜单。');
            })
            .catch((error) => {
                if (!cancelled) setChartError(`榜单读取失败：${errorText(error)}`);
            });
        return () => { cancelled = true; };
    }, [tab, platform, refreshTick]);

    useEffect(() => {
        if (tab !== 'chart' || !chartId) return undefined;
        let cancelled = false;
        setChartLoading(true);
        setChartSongs([]);
        setChartError(null);
        void lxBrowse.chartTracks(platform, chartId, TRACK_PAGE_SIZE, 0)
            .then((page) => {
                if (cancelled) return;
                setChartSongs(page.items.map(lxBrowse.toSong));
            })
            .catch((error) => {
                if (!cancelled) setChartError(`榜单曲目读取失败：${errorText(error)}`);
            })
            .finally(() => { if (!cancelled) setChartLoading(false); });
        return () => { cancelled = true; };
    }, [tab, platform, chartId]);

    // ------------------------------------------------------------ 歌单曲目

    const openPlaylist = useCallback(async (collection: ProviderCollection) => {
        const owner = platformOfCollection(collection, platform);
        // 卡片 id 是带平台前缀的 `wy:123`；调接口要用原生 id（providerData 里留着）。
        const nativeId = typeof collection.providerData?.nativeId === 'string'
            ? collection.providerData.nativeId
            : String(collection.id);
        const view: DetailView = {
            platform: owner,
            id: nativeId,
            title: collection.name,
            subtitle: [collection.creator?.nickname, formatDate(collection.updatedAt)].filter(Boolean).join(' · '),
            coverUrl: collection.coverUrl,
        };
        setDetail(view);
        setDetailSongs([]);
        setDetailHasMore(false);
        setDetailOffset(0);
        setDetailError(null);
        setDetailLoading(true);
        try {
            const page = await lxBrowse.playlistTracks(owner, view.id, TRACK_PAGE_SIZE, 0);
            setDetailSongs(page.items.map(lxBrowse.toSong));
            setDetailOffset(page.items.length);
            setDetailHasMore(page.hasMore);
        } catch (error) {
            setDetailError(`曲目读取失败：${errorText(error)}`);
        } finally {
            setDetailLoading(false);
        }
    }, [platform]);

    const loadMoreDetail = useCallback(async () => {
        if (!detail || detailLoading) return;
        setDetailLoading(true);
        try {
            const page = await lxBrowse.playlistTracks(detail.platform, detail.id, TRACK_PAGE_SIZE, detailOffset);
            setDetailSongs((prev) => [...prev, ...page.items.map(lxBrowse.toSong)]);
            setDetailOffset((prev) => prev + page.items.length);
            setDetailHasMore(page.hasMore);
        } catch (error) {
            setDetailError(`曲目读取失败：${errorText(error)}`);
        } finally {
            setDetailLoading(false);
        }
    }, [detail, detailLoading, detailOffset]);

    // ------------------------------------------------------------ 搜索

    const runSearch = useCallback(async (keyword: string, append: boolean) => {
        const trimmed = keyword.trim();
        if (!trimmed) return;
        setSearchLoading(true);
        if (!append) setSearchError(null);
        const offset = append ? searchOffset : 0;
        try {
            // limit 是「每个平台各取多少」，所以一页最多 3 倍条数。
            const page = await lxmusicProvider.search?.searchSongs?.(trimmed, SEARCH_PAGE_SIZE, offset);
            if (!page) {
                setSearchError('搜索没有返回结果。');
                return;
            }
            setSubmittedQuery(trimmed);
            setSearchSongs((prev) => (append ? [...prev, ...page.items] : page.items));
            setSearchHasMore(page.hasMore);
            setSearchOffset(append ? page.nextOffset : SEARCH_PAGE_SIZE);
        } catch (error) {
            setSearchError(`搜索失败：${errorText(error)}`);
        } finally {
            setSearchLoading(false);
        }
    }, [searchOffset]);

    // ------------------------------------------------------------ 渲染片段

    const canPlayOn = (target: string): boolean => (
        target === 'kw' || lxSourceStore.canResolve(target as LxPlatformKey, 'musicUrl')
    );

    const platformChips = (
        <div className="lx-chips">
            {LX_PUBLIC_PLATFORMS.map((item) => (
                <button
                    key={item.key}
                    type="button"
                    className="lx-chip"
                    data-active={platform === item.key}
                    onClick={() => { setPlatform(item.key); setDetail(null); }}
                >
                    <span className="lx-dot" style={{ background: item.color }} />
                    {item.label}
                </button>
            ))}
        </div>
    );

    const sourceWarning = !canPlayOn(platform) ? (
        <div className="lx-notice" data-kind="warn">
            还没有能处理{platformBadge(platform).label}的音源：这一家的歌能搜、能看，但播放要等你在「音源」里导入对应平台的音源。
        </div>
    ) : null;

    const renderCard = (collection: ProviderCollection) => {
        const count = formatCount(collection.playCount);
        return (
            <button type="button" key={String(collection.id)} className="lx-card" onClick={() => void openPlaylist(collection)}>
                <div className="lx-cover">
                    {collection.coverUrl
                        ? <img src={collection.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        : <span>{collection.name.slice(0, 1)}</span>}
                    {count ? <span className="lx-cover-count"><Play size={9} />{count}</span> : null}
                </div>
                <div className="lx-card-title">{collection.name}</div>
                <div className="lx-card-meta">
                    {[collection.creator?.nickname, formatDate(collection.updatedAt)].filter(Boolean).join(' · ') || `${collection.trackCount ?? 0} 首`}
                </div>
            </button>
        );
    };

    const renderPlaylistTab = () => {
        if (detail) {
            return (
                <>
                    <div className="lx-track-head">
                        <button type="button" className="lx-icon-btn" onClick={() => setDetail(null)} aria-label="返回歌单">
                            <ArrowLeft size={16} />
                        </button>
                        <div className="lx-cover">
                            {detail.coverUrl
                                ? <img src={detail.coverUrl} alt="" referrerPolicy="no-referrer" />
                                : <span>{detail.title.slice(0, 1)}</span>}
                        </div>
                        <div className="lx-track-head-text">
                            <div className="lx-track-head-title">{detail.title}</div>
                            <div className="lx-track-head-sub">
                                {detail.subtitle || `${detailSongs.length} 首`}
                            </div>
                        </div>
                        <button
                            type="button"
                            className="lx-btn-ghost"
                            disabled={detailSongs.length === 0}
                            onClick={() => {
                                const [first, ...rest] = detailSongs;
                                rest.forEach((song) => onAddToQueue(song));
                                if (first) handlePlay(first);
                            }}
                        >
                            播放全部
                        </button>
                    </div>
                    {!canPlayOn(detail.platform) ? (
                        <div className="lx-notice" data-kind="warn">
                            没有{platformBadge(detail.platform).label}音源，这些歌可能放不出来。
                        </div>
                    ) : null}
                    {detailError ? <div className="lx-notice" data-kind="warn">{detailError}</div> : null}
                    {detailLoading && detailSongs.length === 0 ? (
                        <p className="lx-empty">正在读取曲目…</p>
                    ) : detailSongs.length === 0 ? (
                        <p className="lx-empty">这个歌单没有读到曲目。</p>
                    ) : (
                        <LxTrackList songs={detailSongs} onPlay={handlePlay} onQueue={onAddToQueue} />
                    )}
                    {detailHasMore ? (
                        <div className="lx-more">
                            <button type="button" className="lx-btn-ghost" disabled={detailLoading} onClick={() => void loadMoreDetail()}>
                                {detailLoading ? '加载中…' : '加载更多'}
                            </button>
                        </div>
                    ) : null}
                </>
            );
        }

        return (
            <>
                {platformChips}
                {sourceWarning}
                {collectionsError ? <div className="lx-notice" data-kind="warn">{collectionsError}</div> : null}
                {collectionsLoading && collections.length === 0 ? (
                    <p className="lx-empty">正在读取歌单广场…</p>
                ) : collections.length === 0 ? (
                    <p className="lx-empty">
                        {platform === 'kw' ? '酷我没有公开的歌单广场，换到网易云或酷狗看看。' : '这个平台暂时没有返回歌单。'}
                    </p>
                ) : (
                    <div className="lx-grid">{collections.map(renderCard)}</div>
                )}
                {collectionsHasMore ? (
                    <div className="lx-more">
                        <button
                            type="button"
                            className="lx-btn-ghost"
                            disabled={collectionsLoading}
                            onClick={() => void loadCollections(platform, collectionsOffset, true)}
                        >
                            {collectionsLoading ? '加载中…' : '加载更多'}
                        </button>
                    </div>
                ) : null}
            </>
        );
    };

    const renderChartTab = () => {
        const activeChart = charts.find((chart) => chart.id === chartId);
        return (
            <>
                {platformChips}
                {sourceWarning}
                {chartError ? <div className="lx-notice" data-kind="warn">{chartError}</div> : null}
                <div className="lx-chart-layout" style={{ marginTop: 12 }}>
                    <div className="lx-chart-rail">
                        {charts.map((chart) => (
                            <button
                                key={chart.id}
                                type="button"
                                className="lx-chart-item"
                                data-active={chart.id === chartId}
                                onClick={() => setChartId(chart.id)}
                            >
                                {chart.name}
                            </button>
                        ))}
                    </div>
                    <div>
                        {activeChart ? (
                            <div className="lx-track-head-title" style={{ fontSize: 13.5, margin: '2px 0 8px' }}>
                                {platformBadge(platform).label} · {activeChart.name}
                            </div>
                        ) : null}
                        {chartLoading && chartSongs.length === 0 ? (
                            <p className="lx-empty">正在读取榜单…</p>
                        ) : chartSongs.length === 0 ? (
                            <p className="lx-empty">这个榜暂时没有曲目。</p>
                        ) : (
                            <LxTrackList songs={chartSongs} onPlay={handlePlay} onQueue={onAddToQueue} />
                        )}
                    </div>
                </div>
            </>
        );
    };

    const renderSearchTab = () => (
        <>
            <div className="lx-search-row">
                <input
                    className="lx-input"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(query, false); }}
                    placeholder="搜歌名 / 歌手 / 专辑（三家一起搜）"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                />
                <button type="button" className="lx-btn" disabled={searchLoading || !query.trim()} onClick={() => void runSearch(query, false)}>
                    {searchLoading ? '搜索中…' : '搜索'}
                </button>
            </div>
            {searchError ? <div className="lx-notice" data-kind="warn">{searchError}</div> : null}
            {searchSongs.length === 0 ? (
                <p className="lx-empty">
                    {submittedQuery ? `没搜到「${submittedQuery}」。` : '输入关键词，网易云 / 酷狗 / 酷我的结果会一起列出来。'}
                </p>
            ) : (
                <>
                    <div className="lx-track-head-sub" style={{ margin: '12px 2px 4px' }}>
                        「{submittedQuery}」的结果 · {searchSongs.length} 首
                    </div>
                    <LxTrackList songs={searchSongs} onPlay={handlePlay} onQueue={onAddToQueue} />
                </>
            )}
            {searchHasMore ? (
                <div className="lx-more">
                    <button type="button" className="lx-btn-ghost" disabled={searchLoading} onClick={() => void runSearch(submittedQuery, true)}>
                        {searchLoading ? '加载中…' : '加载更多'}
                    </button>
                </div>
            ) : null}
        </>
    );

    return (
        <div
            className="lx-root"
            data-daylight={isDaylight ? 'true' : 'false'}
            style={{
                color: theme.primaryColor,
                '--lx-accent': theme.accentColor || '#e11d48',
            } as React.CSSProperties}
            role="dialog"
            aria-modal="true"
            aria-label="洛雪"
        >
            <header className="lx-header">
                <div className="lx-header-row">
                    <button type="button" className="lx-icon-btn" onClick={onClose} aria-label="关闭洛雪">
                        <ArrowLeft size={18} />
                    </button>
                    <span className="lx-title">洛雪</span>
                    <span className="lx-badge">{lxSourceStore.getSources().filter((source) => source.enabled).length} 个音源</span>
                    <div style={{ flex: '1 1 auto' }} />
                    <button
                        type="button"
                        className="lx-icon-btn"
                        aria-label="刷新"
                        title="刷新"
                        onClick={() => {
                            setDetail(null);
                            setRefreshTick((prev) => prev + 1);
                        }}
                    >
                        <RefreshCw size={15} />
                    </button>
                </div>
                <nav className="lx-tabs" aria-label="洛雪页签">
                    {TABS.map((item) => (
                        <button
                            key={item.key}
                            type="button"
                            className="lx-tab"
                            data-active={tab === item.key}
                            onClick={() => setTab(item.key)}
                        >
                            {item.label}
                        </button>
                    ))}
                </nav>
            </header>

            <div className="lx-body">
                {tab === 'playlist' ? renderPlaylistTab() : null}
                {tab === 'chart' ? renderChartTab() : null}
                {tab === 'search' ? renderSearchTab() : null}
                {tab === 'source' ? <LxSourcePanel onChanged={handleSourceChanged} /> : null}
            </div>

            {playHint ? <div className="lx-toast" role="status">{playHint}</div> : null}
        </div>
    );
};

export default LxWorkspace;
