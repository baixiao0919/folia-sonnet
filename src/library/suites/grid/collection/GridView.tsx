import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, useMotionValue, animate, AnimatePresence, useDragControls, useIsPresent } from 'framer-motion';
import { ChevronLeft, Crosshair, Disc, Download, ImagePlus, Play, Plus, Loader2, Heart, ListPlus, Pencil, RefreshCw, Trash2, Star, Tags } from 'lucide-react';
import GridPanelToggleIndicator from '../shared/GridPanelToggleIndicator';
import { useGlass } from '@/shinoinject/useGlass';
import { useTranslation } from 'react-i18next';
import { SongResult, type LocalSong, type StatusMessage, Theme } from '../../../../types';
import { getLowResCoverUrl, toHttps } from './gridViewText';
import GridViewCutInPanel from './GridViewCutInPanel';
import GridViewChrome from './GridViewChrome';
import { useGridViewLayout } from './useGridViewLayout';
import { useGridViewViewport } from './useGridViewViewport';
import { useGridViewCards } from './useGridViewCards';
import { useGridViewMutations } from './useGridViewMutations';
import { useGridViewKeyboard } from './useGridViewKeyboard';
import { useGridViewLocate } from './useGridViewLocate';
import { useGridViewCollection } from './useGridViewCollection';
import { useGridViewStandIn } from './useGridViewStandIn';
import { useGridViewSurface } from './useGridViewSurface';
import GridViewStandInCard from './GridViewStandInCard';
import GridViewCanvas from './GridViewCanvas';
import GridViewDialogs from './GridViewDialogs';
import GridViewTracksPanel from './GridViewTracksPanel';
import { onlineFailureMessage } from '../../../../services/onlineMusic/failure/onlineFailureTexts';
import { GridLocateButton } from '../../../../components/app/playing-song-locator/GridLocateButton';
import { usePlaybackStore } from '../../../../stores/usePlaybackStore';
import { usePlayingSongLocatorStore } from '../../../../stores/usePlayingSongLocatorStore';
import { resolveLocateStep } from '../../../../components/app/playing-song-locator/resolveLocateStep';
import { useFoliaHexViewport } from '../shared/useFoliaHexViewport';
import { PolaroidCard, type GridItem } from '../shared/PolaroidCard';
import type { GridPlaybackMark } from '../shared/useGridStayPlayback';
import { gridViewStateStorageKey, readStoredGridViewState, resolveGridRestoreTarget, type GridRestoreTarget } from '../shared/gridViewRestore';
import { useMorphPageExit } from '../transitions/collectionMorphStore';
import { type CollectionMorphPlan } from '../transitions/morphGeometry';
import ActiveGridMarker from '../shared/ActiveGridMarker';
import PlaylistSelectionDialog from '../../../../components/shared/PlaylistSelectionDialog';
import TextInputDialog from '../../../../components/shared/TextInputDialog';
import ConfirmDialog from '../../../../components/shared/ConfirmDialog';
import { SidePanelList } from '../../../../components/shared/SidePanelList';
import { GridListSearchButton } from '../../../../components/shared/GridListSearchButton';
import { TrackSortMenu } from '../../../../components/shared/TrackSortMenu';
import { CustomSelect } from '../../../../components/shared/CustomSelect';
import { deriveProgressiveLoadingState } from '../shared/progressiveGrid';
import { useProgressiveItemEntrance } from '../shared/useProgressiveItemEntrance';
import { useLocalCoverPreloader } from '../../../../hooks/useLocalCoverPreloader';
import { resolveCollectionSyncCounts } from '../../../core/collection/collectionProgress';
import { useGridSurfaceRegistration } from '../../../../hooks/useGridSurfaceRegistration';
import type { CollectionResource } from '../../../core/shared/resource.contract';
import type { CollectionMutationController } from '../../../core/collection/mutations/mutations.contract';
import type { LibraryDeclaredActions } from '../../../core/suite/suite.contract';
import { useGridViewSettingsStore } from '../../../../stores/useGridViewSettingsStore';
import { collectionKey } from '../../../core/collection/collectionIdentity';
import { useCollectionResourceState } from '../../../core/collection/resource/useCollectionResourceState';
import { useCollectionView } from '../../../core/collection/useCollectionView';
import { useCommittedQuery } from '../../../core/shared/useCommittedQuery';
import { useLibrarySessionQuery } from '../../../core/shared/useLibrarySessionQuery';
import { useGridCommandFilter } from '../../../../hooks/useGridCommandFilter';
import { getLibraryBrowseSession, useLibraryBrowseSessionStore } from '../../../core/shared/useLibraryBrowseSessionStore';
import { useTrackSorting } from '../../../core/collection/useTrackSorting';

interface GridViewProps {
    title: string;
    subtitle?: string;
    items?: GridItem[];
    mode: 'collection' | 'tracks';
    onBack: () => void;
    /** 返回按钮：看完了（宿主清会话与布局记录再返回）。 */
    onDone: () => void;
    onSelectTrack?: (track: SongResult, queue: SongResult[]) => void;
    onSelectCollection?: (item: any) => void;
    onAddTrackToQueue?: (track: SongResult) => void;
    /** fb3：「留在原处」时正在播放的那首的卡片画成暂停 / 继续（useGridStayPlayback.markFor）；不给就是普通的播放键。 */
    trackPlaybackMark?: (track: SongResult | undefined) => GridPlaybackMark | null;
    isLoading?: boolean;
    theme: Theme;
    isDaylight: boolean;

    // Optional self-contained collection props
    collection?: any;
    onPlayAll?: (songs: SongResult[]) => void;
    onAddAllToQueue?: (songs: SongResult[], options?: { suppressToast?: boolean }) => number | void;
    onSelectAlbum?: (albumId: number | string, album?: any, track?: SongResult) => void;
    onSelectArtist?: (artistId: number | string, artist?: any, track?: SongResult) => void;
    /**
     * 曲目的来源：加载、缓存、后台补页、错误与重新拉取都在资源里（见 library/core/collection/resource）。
     * 宿主持有它，切换 renderer 不会重新请求。
     */
    resource?: CollectionResource | null;
    /**
     * 集合的变更动作控制器（宿主按集合会话持有，见 library/core/collection/mutations/collectionMutations.service）：删条目、订阅、
     * 改名、删除、重扫、导出、加入歌单……都经它，按钮的可见与可点也读它的快照。没有时（性能探针）什么都不支持。
     */
    mutations?: CollectionMutationController | null;
    localSongs?: LocalSong[];
    onStatusMessage?: (message: StatusMessage) => void;
    isInteractive?: boolean;
    /**
     * The key the app's navigation knows this page by: collectionKey of the descriptor it was
     * opened with. `collection` may be a refreshed copy with another key (a local album or artist
     * takes the id of the entity it was merged into).
     */
    navigationKey?: string;
    /**
     * Optional shared-element「移形换影」plan, as it stands when the page is
     * first rendered. Either way every non-hero card settles into its grid
     * slot from a short push, in a distance sequence; `kind: 'morph'`
     * additionally means a cover is flying to this page: the page puts up a
     * stand-in card at the hero's place, showing the plan's `coverUrl`, for
     * the cover to land on, which then hands over to the hero. `kind:
     * 'cascade'` (no cover flying) leaves the hero visible. Absent for every
     * other caller, so behavior is unchanged unless the collection morph
     * hands it in.
     */
    morphPlan?: CollectionMorphPlan | null;
    /**
     * 网格 suite 在 entry.ts 里为集合 surface 声明的动作（宿主经 registry 解析后传入）。命令面板只发布
     * 声明过的；直接挂 GridView 的探针不传，不过滤。
     */
    declaredActions?: LibraryDeclaredActions;
}

// What a page that is given no `items` has for them: the one list, render after render. A list
// made anew in every render made the grid's items anew, and with them every card on the page.
const NO_ITEMS: GridItem[] = [];

export const GridView: React.FC<GridViewProps> = ({
    title,
    subtitle,
    items = NO_ITEMS,
    mode,
    onBack,
    onDone,
    onSelectTrack,
    onSelectCollection,
    onAddTrackToQueue,
    trackPlaybackMark,
    isLoading = false,
    theme,
    isDaylight,
    collection,
    onPlayAll,
    onAddAllToQueue,
    onSelectAlbum,
    onSelectArtist,
    resource = null,
    mutations = null,
    localSongs,
    onStatusMessage,
    isInteractive = true,
    navigationKey,
    morphPlan = null,
    declaredActions,
}) => {
    const { t } = useTranslation();
    const fullBleedCover = useGridViewSettingsStore(state => state.gridViewFullBleedCover);
    // Only the full-bleed layout can be square: the polaroid frame needs the extra height for the
    // printed label under its artwork.
    const squareCards = useGridViewSettingsStore(state => state.gridViewSquareCards) && fullBleedCover;
    const minCardScale = useGridViewSettingsStore(state => state.gridViewMinCardScale);
    const minCardOpacity = useGridViewSettingsStore(state => state.gridViewMinCardOpacity);
    const pageExit = useMorphPageExit();
    const containerRef = useRef<HTMLDivElement>(null);
    const dragControls = useDragControls();
    const isDraggingRef = useRef(false);

    const {
        containerSize,
        layoutConfig,
        clipRadius,
        cardFrameOptions,
        renderRadius,
        renderRing,
    } = useGridViewLayout({ containerRef, squareCards, minCardScale, minCardOpacity });
    // 恢复记录按集合身份分开存：只用 id 时，不同来源、不同 provider 下同 id 的集合会互相恢复对方的焦点和筛选。
    const collectionIdentity = collection?.source ? collectionKey(collection) : '';
    const navigationStorageKey = useMemo(() => {
        if (mode !== 'tracks' || !collection) return null;
        return gridViewStateStorageKey(collectionIdentity || collection.name || title);
    }, [collection, collectionIdentity, mode, title]);
    // 浏览会话（筛选词、看到哪首）的键：与列表等别的 renderer 共用，换 renderer 时会话还在。
    const sessionKey = collectionIdentity || `${mode}:${title}`;
    // 恢复目标在挂载时定下（网格按集合 key 挂载）：恢复 effect 和移形换影的 hero 用同一份。
    const [initialRestoreTarget] = useState<GridRestoreTarget | null>(() => (
        navigationStorageKey
            ? resolveGridRestoreTarget(readStoredGridViewState(navigationStorageKey), getLibraryBrowseSession(sessionKey))
            : null
    ));

    const [showCutInPanel, setShowCutInPanel] = useState(false);
    const [showSidePanel, setShowSidePanel] = useState(false);
    // 退场动画期间旧网格仍挂着：只有在场的那一个接键盘、筛选框和命令面板，
    // 否则在上一个网格还没退完时按下的 Enter 会落到它身上。
    const isPresent = useIsPresent();
    const isActive = isInteractive && isPresent;
    // The filter box is the command palette now; this grid only says who owns typing and where the
    // box belongs. See useGridCommandFilter for why all three grids stopped carrying their own.
    // 筛选词存在浏览会话里（见 useLibrarySessionQuery），换 renderer 不丢。
    const { query: searchQuery, setQuery: setSearchQuery, port: searchQueryPort } = useLibrarySessionQuery(sessionKey);
    const isFiltering = useGridCommandFilter({
        isInteractive: isActive,
        port: searchQueryPort,
        // The box used to be an absolutely positioned child of the canvas; it still is.
        anchorRef: containerRef,
        reopenIfFiltered: true,
    });
    const deferredSearchQuery = useCommittedQuery(searchQuery);

    const {
        resourceSnapshot,
        flushHeldResourceSnapshot,
        holdPresentation,
        releasePresentation,
        tracks,
        loading,
        backgroundLoading,
        backgroundLoadError,
        loadError,
        loadFailure,
        backgroundFailure,
        collectionDetail,
        mutationSnapshot,
        mutationBranches,
        mutationCapabilities,
        isSourceActionPending,
        collectionSource,
        isLocalCollection,
        isNavidromeCollection,
        isAlbumCollection,
        isDailyRecommendationsCollection,
        isCloudThemeCollection,
        canReloadThisCollection,
        isLocalFolderCollection,
        isLocalAllSongsCollection,
        canEditOwnedPlaylist,
        canEditProviderPlaylist,
        canEditPlaylist,
        showSubscribeButton,
        isOnlineAlbum,
        canAddNavidromeToPlaylist,
        collectionName,
        sorting,
        supportsTrackSorting,
        supportsLocalTrackSorting,
        getAlbumTrackLabel,
        collectionView,
        displayTracks,
        playableTracks,
        matchIndexes,
        contextActionTracks,
        trackOccurrences,
        gridItems,
        hasSearchQuery,
        shouldAnimateItemEntrance,
    } = useGridViewCollection({
        resource,
        mutations,
        collection,
        mode,
        items,
        localSongs,
        title,
    ]);

    // 删除成功才返回上一层（文件夹先经确认对话框）。
    const handleDeleteSourceCollection = useCallback(async () => {
        const result = await mutations?.deleteCollection();
        if (result?.ok) onBack();
    }, [mutations, onBack]);

    const handleResyncLocalFolder = useCallback(() => void mutations?.resyncFolder(), [mutations]);
    const handleResyncAllLocalFolders = useCallback(() => void mutations?.resyncAllFolders(), [mutations]);
    const handleExportLocalPlaylist = useCallback(() => void mutations?.exportPlaylist(), [mutations]);
    const handleOrganizeSongInfo = useCallback(() => void mutations?.organizeSongInfo(), [mutations]);
    const handleEditEntity = useCallback(() => void mutations?.editEntity(), [mutations]);
    const handleSetCover = useCallback(() => void mutations?.setCover(), [mutations]);

    const handleAddNavidromeCollectionToPlaylist = useCallback(async (playlistId: string | number) => {
        await mutations?.addToPlaylist(playlistId, playableTracks);
    }, [mutations, playableTracks]);

    const handleCreateNavidromePlaylist = useCallback(async (name: string) => {
        const result = await mutations?.createPlaylist(name, playableTracks);
        if (result?.ok) setIsCreatePlaylistOpen(false);
    }, [mutations, playableTracks]);

    // 续传、重新拉取都交给资源；资源负责作废晚到的旧结果。
    const resumeBackgroundSync = () => resource?.resumeSync();
    const reloadOnlineCollection = () => resource?.reload();

    // An owned online playlist edits in place; a local or Navidrome one commits a rename on the way
    // out. Shared so the command palette and the panel button cannot end up meaning different things.
    const handleEditModeToggle = useCallback(() => {
        if (canEditOwnedPlaylist || canEditProviderPlaylist) {
            setIsEditMode(prev => !prev);
            return;
        }
        void handleSourceEditToggle();
    }, [canEditOwnedPlaylist, canEditProviderPlaylist, handleSourceEditToggle]);

    // 订阅状态在控制器第一次被订阅时取。星星一按就变：控制器先改显示，再在后台问平台，请求期间再按只改「要的」，
    // 请求跟着它走；平台没答应时星星回到平台上的样子，这里说一句（按下时的那一页已经关了也说）。
    const playlistSubscribed = mutationSnapshot.subscribed;
    const [starPresses, setStarPresses] = useState(0);
    const handleToggleSubscribe = async () => {
        if (!mutations) return;
        setStarPresses(count => count + 1);
        const result = await mutations.toggleSubscribe();
        if (!result.ok && result.reason === 'failed') {
            onStatusMessage?.({
                type: 'error',
                text: t(mutations.getSnapshot().subscribed ? 'status.collectionUnsaveFailed' : 'status.collectionSaveFailed'),
                nonce: Date.now(),
            });
        }
    };

    // Switches the virtual playlist between today's recommendations and a supported history date.
    const handleDailyRecommendationDateChange = useCallback(async (date: string, afresh = false) => {
        if (!mutations || !mutationCapabilities.dailyDate.supported) return;
        setIsEditMode(false);
        // 整表替换经控制器交给资源（加载中状态、作废晚到结果都在那里）；失败时保持原样，日期也不切。
        await mutations.setDailyDate(date, { afresh });
    }, [mutationCapabilities.dailyDate.supported, mutations]);

    // 删一个条目（每日推荐是「不喜欢并换一首」）：先按住展示，控制器在上游确认后立即提交给资源；成功就给卡片
    // 打上 removing 播退出动画，动画结束再放开展示，失败立即放开。entryKey 就是卡片 id：重复序号在完整的
    // 展示列表上算（不受筛选影响），控制器自己在资源里解出原始下标。
    const handleRemoveTrack = useCallback(async (track: SongResult, entryKey: string) => {
        if (!mutations || trackRemovalTimeoutsRef.current.has(entryKey)) return;
        trackRemovalSeqRef.current += 1;
        // 每次点击一个 token：同一张卡连点时，被挡掉（busy）的那一次只放开自己的，不会提前放开第一次的。
        const holdToken = `remove:${entryKey}:${trackRemovalSeqRef.current}`;
        holdPresentation(holdToken);
        let result: LibraryMutationResult;
        try {
            result = await mutations.removeEntry({ entryKey, track });
        } catch (error) {
            console.error('Failed to remove track in GridView', error);
            result = { ok: false, reason: 'failed' };
        }
        if (!isMountedRef.current) return;
        if (result.ok) {
            playTrackRemovalAnimation(entryKey, holdToken);
            return;
        }
        releasePresentation(holdToken);
        if (result.reason === 'limit-reached') {
            onStatusMessage?.({
                type: 'info',
                text: t('home.noMoreDailyRecommendations'),
                nonce: Date.now(),
            });
        } else if (result.reason === 'failed') {
            onStatusMessage?.({
                type: 'error',
                text: isDailyRecommendationsCollection ? t('home.dislikeRecommendationFailed') : t('home.removeTrackFailed'),
                nonce: Date.now(),
            });
        }
    }, [
        holdPresentation,
        isDailyRecommendationsCollection,
        mutations,
        onStatusMessage,
        playTrackRemovalAnimation,
        releasePresentation,
        t,
    ]);

    // 网格项**惰性**塑形（见 lazyGridItems.ts）：length 立刻可用，真对象只在被读到下标时才塑形。
    // 原来整表 map 一遍，5000 首实测 120ms，而分页每来一页都要重算 —— 大歌单打开时卡在这里。
    // 重复序号由集合视图维护（分页追加时复用前缀），与条目键是同一份。
    const allGridItems = useMemo((): GridItem[] => {
        if (mode === 'collection') {
            return items || [];
        }
        return createLazyGridItems(displayTracks, trackOccurrences);
    }, [mode, items, displayTracks, trackOccurrences]);

    // 曲目模式按曲目本身做匹配，只取命中的网格项：不必为了筛选把整张歌单的卡片都塑形一遍。
    const gridItems = useMemo(() => {
        if (mode === 'tracks') {
            return matchIndexes ? matchIndexes.map(index => allGridItems[index]) : allGridItems;
        }
        // 集合模式（目前没有调用方）沿用对网格项的匹配。
        const query = deferredSearchQuery.trim().toLowerCase();
        if (!query) return allGridItems;

        return allGridItems.filter((item) => {
            const track = item.rawTrack;
            const searchableText = [
                item.searchText,
                typeof item.name === 'string' ? item.name : undefined,
                item.description,
                track?.album?.name,
                track?.artists?.map((artist) => artist.name).join(' '),
            ]
                .filter((value) => value !== undefined && value !== null)
                .join(' ')
                .toLowerCase();

            return searchableText.includes(query);
        });
    }, [allGridItems, deferredSearchQuery, matchIndexes, mode]);
    const hasSearchQuery = deferredSearchQuery.trim().length > 0;
    const shouldAnimateItemEntrance = useProgressiveItemEntrance(
        `${mode}:${collectionIdentity || title}`
    );

    // Coordinate motion values mapping grid drags
    const dragX = useMotionValue(0);
    const dragY = useMotionValue(0);

    // 「看到哪首」以条目键写进浏览会话（别的 renderer 也认），网格自己的布局另存一份。
    const persistNavigationState = useCallback((index: number) => {
        if (!navigationStorageKey) return;

        const safeIndex = Math.max(0, Math.min(index, Math.max(gridItems.length - 1, 0)));
        const focusedEntryKey = gridItems[safeIndex] ? String(gridItems[safeIndex].id) : undefined;
        const state: StoredGridViewNavigationState = {
            focusedEntryKey,
            focusedIndex: safeIndex,
            dragX: dragX.get(),
            dragY: dragY.get(),
        };

        sessionStorage.setItem(navigationStorageKey, JSON.stringify(state));
        useLibraryBrowseSessionStore.getState().setFocusedEntry(sessionKey, focusedEntryKey ?? null);
    }, [dragX, dragY, gridItems, navigationStorageKey, sessionKey]);

    // 切换 renderer 之前，切换器会让当前网格把焦点写回会话。写的是已提交的焦点（Enter 播放的那张），
    // 不是拖拽帧循环里的 focusedIndexRef：筛选刚变化时那个值可能还来自旧的渲染环。
    const committedFocusIndexRef = useRef(focusedIndex);
    committedFocusIndexRef.current = focusedIndex;
    useEffect(() => registerLibrarySessionFlush(sessionKey, () => persistNavigationState(committedFocusIndexRef.current)), [
        persistNavigationState,
        sessionKey,
    ]);

    useEffect(() => {
        const syncWheelTarget = () => {
            wheelTargetRef.current = { x: dragX.get(), y: dragY.get() };
        };
        const unsubX = dragX.on('change', syncWheelTarget);
        const unsubY = dragY.on('change', syncWheelTarget);
        return () => {
            unsubX();
            unsubY();
        };
    }, [dragX, dragY]);

    const {
        removingTrackKeys,
        isEditMode,
        setEditableTitle,
        editableTitle,
        isPlaylistPickerOpen,
        setIsPlaylistPickerOpen,
        isCreatePlaylistOpen,
        setIsCreatePlaylistOpen,
        isDeleteFolderOpen,
        setIsDeleteFolderOpen,
        pendingLocalRemoval,
        setPendingLocalRemoval,
        canRename,
        canMatchSong,
        handleSourceEditToggle,
        handleDeleteSourceCollection,
        handleResyncLocalFolder,
        handleResyncAllLocalFolders,
        handleExportLocalPlaylist,
        handleOrganizeSongInfo,
        handleEditEntity,
        handleSetCover,
        handleAddNavidromeCollectionToPlaylist,
        handleCreateNavidromePlaylist,
        resumeBackgroundSync,
        reloadOnlineCollection,
        handleEditModeToggle,
        playlistSubscribed,
        starPresses,
        handleToggleSubscribe,
        handleDailyRecommendationDateChange,
        confirmLocalSongRemoval,
        runRemoveTrack,
        handleRemoveTrack,
    } = useGridViewMutations({
        title,
        collection,
        collectionName,
        mutations,
        mutationSnapshot,
        mutationCapabilities,
        mutationBranches,
        playableTracks,
        resource,
        holdPresentation,
        releasePresentation,
        onBack,
        onStatusMessage,
        isLocalFolderCollection,
        isLocalAllSongsCollection,
        isDailyRecommendationsCollection,
        t,
    });


    // 重复序号由集合视图维护（分页追加时复用前缀），与条目键是同一份。


    const {
        dragX,
        dragY,
        dragBounds,
        focusedIndex,
        focusedIndexRef,
        pendingFocusCommitTimeoutRef,
        baseCoords,
        renderedIndexes,
        renderedIndexesRef,
        updateRenderedIndexesForViewport,
        centerOnIndex,
        commitFocusedIndex,
        scheduleFocusedIndexCommit,
        persistNavigationState,
        pendingRestoreStateRef,
        hasRestoredNavigationRef,
    } = useGridViewViewport({
        containerRef,
        layoutConfig,
        containerSize,
        renderRadius,
        renderRing,
        gridItems,
        isDraggingRef,
        navigationStorageKey,
        sessionKey,
        initialRestoreTarget,
        findEntryIndex: collectionView.findEntryIndex,
        matchIndexes,
    });

    // Centre on the first card when cards first appear, and when the filter changes which ones
    // are shown. Not when further cards join the ones there: an online collection is read page
    // by page (15 or 100 songs a page on YouTube Music), and every page that arrived pulled the
    // listener back to the first card from wherever they had scrolled to.
    const firstCardShownForRef = useRef<string | null>(null);
    useEffect(() => {
        if (gridItems.length === 0) {
            firstCardShownForRef.current = null;
            return;
        }
        if (pendingRestoreStateRef.current && !hasRestoredNavigationRef.current) return;
        const shownFor = firstCardShownForRef.current;
        firstCardShownForRef.current = deferredSearchQuery;
        if (hasRestoredNavigationRef.current) return;
        if (shownFor !== deferredSearchQuery) {
            centerOnIndex(0, false);
        }
    }, [deferredSearchQuery, gridItems.length]);

    useGridViewKeyboard({
        isActive,
        onBack,
        searchQuery,
        setSearchQuery,
        isFiltering,
        showSidePanel,
        setShowSidePanel,
        showCutInPanel,
        setShowCutInPanel,
        isEditMode,
        isPlaylistPickerOpen,
        isCreatePlaylistOpen,
        isDeleteFolderOpen,
        mode,
        gridItems,
        focusedIndex,
        baseCoords,
        contextActionTracks,
        onSelectTrack,
        onSelectCollection,
        persistNavigationState,
        centerOnIndex,
    });

    useEffect(() => {
        updateRenderedIndexesForViewport(dragX.get(), dragY.get(), true);
    }, [dragX, dragY, updateRenderedIndexesForViewport]);

    // 替身卡（移形换影）：入场计划与交棒见 useGridViewStandIn，画出来的是 GridViewStandInCard。
    const { standIn, standInCardRef, entranceKind } = useGridViewStandIn({
        morphPlan,
        readHandoverInputs: () => ({
            showLoading,
            gridItemCount: gridItems.length,
            renderedIndexCount: renderedIndexes.length,
            cardWrapperRefs,
            morphHeroIndex,
        }),
    });

    // 卡片层（入场 hero、卡片节点与集中式帧循环）见 useGridViewCards。
    const { cards: memoizedCards, cardWrapperRefs, morphHeroIndex } = useGridViewCards({
        gridItems,
        baseCoords,
        renderedIndexes,
        renderedIndexesRef,
        dragX,
        dragY,
        cardFrameOptions,
        layoutConfig,
        containerSize,
        focusedIndex,
        focusedIndexRef,
        pendingFocusCommitTimeoutRef,
        updateRenderedIndexesForViewport,
        initialRestoreTarget,
        findEntryIndex: collectionView.findEntryIndex,
        matchIndexes,
        entranceKind,
        shouldAnimateItemEntrance,
        removingTrackKeys,
        isDaylight,
        theme,
        mode,
        fullBleedCover,
        isEditMode,
        contextActionTracks,
        onSelectTrack,
        onSelectCollection,
        onSelectArtist,
        onSelectAlbum,
        onAddTrackToQueue,
        trackPlaybackMark,
        canMatchSong,
        mutations,
        onRemoveTrack: handleRemoveTrack,
        persistNavigationState,
        centerOnIndex,
        isDraggingRef,
        t,
    });

    const progressiveLoading = deriveProgressiveLoadingState(
        gridItems.length,
        isLoading || (mode === 'tracks' && loading),
        backgroundLoading
    );
    const showLoading = progressiveLoading.initialLoading;
    const {
        playingSongKey,
        isPlayingSongHere,
        isLocateAsked,
        locateOnThisPage,
        locatedTimes,
        listFocusedIndex,
    } = useGridViewLocate({
        mode,
        displayTracks,
        gridItems,
        hasSearchQuery,
        focusedIndex,
        navigationKey,
        collection,
        isActive,
        searchQuery,
        setSearchQuery,
        isLoading,
        loading,
        backgroundLoading,
        loadError,
        backgroundLoadError,
        centerOnIndex,
    });
    // 大歌单要分几十页补齐，只写「加载中」用户会以为歌丢了；拿得到总数就把进度写出来。
    const backgroundSyncTotal = collectionDetail?.trackCount ?? collection?.trackCount;
    const backgroundSyncCounts = resolveCollectionSyncCounts(tracks.length, backgroundSyncTotal);
    const backgroundSyncLabel = backgroundLoadError
        ? (backgroundSyncCounts ? t('playlist.syncInterruptedProgress', backgroundSyncCounts) : t('playlist.syncInterrupted'))
        : (backgroundSyncCounts ? t('playlist.syncProgress', backgroundSyncCounts) : t('playlist.loading'));
    // What went wrong, said in the empty page and in the background banner's hover text.
    const loadFailureSaid = loadFailure && !hasSearchQuery ? onlineFailureMessage(loadFailure, t) : null;
    const backgroundFailureSaid = backgroundFailure ? onlineFailureMessage(backgroundFailure, t) : null;

    const displayCollection = mutationSnapshot.renamedTo && collection ? { ...collection, name: mutationSnapshot.renamedTo } : collection;
    const infoCollection = collectionDetail ? { ...displayCollection, ...collectionDetail } : displayCollection;
    const coverUrl = infoCollection?.coverUrl || '';
    // 只有 tracks 模式下的合集才有切入面板，没有面板时标题不做成可点控件
    const hasCutInPanel = mode === 'tracks' && Boolean(collection);

    // 命令面板的集合 surface（core 动作 + 网格自己的面板 / 侧栏 / 编辑模式）见 useGridViewSurface。
    useGridViewSurface({
        isInteractive: isActive,
        declaredActions,
        contextActionTracks,
        hasSearchQuery,
        supportsLocalTrackSorting,
        supportsTrackSorting,
        sorting,
        canReloadThisCollection,
        loading,
        onPlayAll,
        onAddAllToQueue,
        reloadOnlineCollection,
        mutationSnapshot,
        mutations,
        hasCutInPanel,
        mode,
        displayTrackCount: displayTracks.length,
        canEditPlaylist,
        isCutInPanelOpen: showCutInPanel,
        isTrackListOpen: showSidePanel,
        isEditMode,
        toggleInfoPanel: () => setShowCutInPanel(current => !current),
        toggleTrackList: () => setShowSidePanel(current => !current),
        toggleEditMode: handleEditModeToggle,
    });

    const albumArtists = Array.isArray(infoCollection?.artists) ? infoCollection.artists : [];
    const albumAlias = infoCollection?.aliases?.[0];
    const albumPublishedAt = infoCollection?.publishedAt;
    const albumPublisher = infoCollection?.publisher;

    useGlass();

    return (
        <motion.div
            data-ponder-page-scope="grid-view-page"
            data-library-renderer="grid"
            data-library-surface="collection"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={pageExit}
            className="fixed inset-0 z-[110] flex flex-col justify-between overflow-hidden select-none"
            style={{
                backgroundColor: 'var(--bg-color)',
                color: 'var(--text-primary)',
            }}
        >
            {coverUrl && (
                <div
                    className="absolute inset-0 pointer-events-none overflow-hidden select-none z-0"
                    style={{ opacity: isDaylight ? 0.18 : 0.12 }}
                >
                    <img
                        src={toHttps(getLowResCoverUrl(coverUrl))}
                        alt=""
                        className="w-full h-full object-cover scale-110 filter blur-[30px]"
                    />
                </div>
            )}
            {/* 「我是当前这层网格」的标记，放在根节点里：移形换影的测量只在这个子树里找卡片和
                落点，否则正在退出的上一层网格会被当成落点。订阅关在子组件里，见 ActiveGridMarker。 */}
            <ActiveGridMarker />

            {/* Back Button */}
            <button
                // 返回按钮表示看完了（onDone）：宿主清掉浏览会话、让每套 suite 忘掉布局记录（网格的 sessionStorage
                // 记录经 entry 的 layout.forget），再返回。Escape 与浏览器后退保留（onBack）。P4.5 起不在这里清。
                onClick={onDone}
                data-glass
                data-glass-jelly
                data-glass-light
                className="absolute left-6 top-5 w-12 h-12 rounded-full flex items-center justify-center transition-all shadow-lg hover:scale-105 active:scale-95 z-[70]"
                style={{
                    backgroundColor: isDaylight
                        ? "rgba(255,255,255,0.4)"
                        : "rgba(0,0,0,0.4)",
                    borderTop: isDaylight
                        ? "1px solid rgba(0,0,0,0.08)"
                        : "1px solid rgba(255,255,255,0.12)",
                    borderBottom: isDaylight
                        ? "1px solid rgba(0,0,0,0.08)"
                        : "1px solid rgba(255,255,255,0.12)",
                    outline: "1px solid rgba(40,40,40,0.2)",
                    boxShadow: "2px 2px 8px 2px rgba(40,40,40,0.4)",
                }}
            >
                <ChevronLeft size={20} />
            </button>

            {(progressiveLoading.backgroundLoading || backgroundLoadError) && (
                <button
                    type="button"
                    onClick={resumeBackgroundSync}
                    disabled={!backgroundLoadError}
                    className="absolute right-6 top-5 z-[70] flex items-center gap-2 rounded-full px-3 py-2 text-xs tabular-nums backdrop-blur-md disabled:cursor-default"
                    style={{ backgroundColor: 'color-mix(in srgb, var(--bg-color) 65%, transparent)' }}
                    title={backgroundFailureSaid
                        ? t('playlist.syncFailedHint', {
                            error: backgroundFailureSaid.quote
                                ? `${backgroundFailureSaid.title}: ${[backgroundFailureSaid.quote.text, backgroundFailureSaid.quote.code].filter(Boolean).join(' ')}`
                                : backgroundFailureSaid.title,
                        })
                        : backgroundSyncLabel}
                >
                    <RefreshCw size={14} className={progressiveLoading.backgroundLoading ? 'animate-spin' : ''} />
                    {backgroundSyncLabel}
                    {backgroundLoadError && <span className="font-semibold">{t('ui.retry')}</span>}
                </button>
            )}

            {/* Center Clickable Area */}
            <div
                onClick={() => {
                    if (!hasCutInPanel) return;
                    setShowCutInPanel(!showCutInPanel);
                }}
                data-glass
                data-glass-jelly
                data-glass-light
                className={`group/grid-title absolute left-1/2 top-5 -translate-x-1/2 z-[70] text-center flex flex-col items-center select-none transition-all px-5 py-2 rounded-2xl backdrop-blur-md ${hasCutInPanel ? 'cursor-pointer hover:scale-[1.01] active:scale-98' : ''}`}
                style={{
                backgroundColor: isDaylight
                    ? "rgba(255,255,255,0.4)"
                    : "rgba(0,0,0,0.4)",
                borderTop: isDaylight
                    ? "1px solid rgba(0,0,0,0.08)"
                    : "1px solid rgba(255,255,255,0.12)",
                borderBottom: isDaylight
                    ? "1px solid rgba(0,0,0,0.08)"
                    : "1px solid rgba(255,255,255,0.12)",
                outline: "1px solid rgba(40,40,40,0.2)",
                boxShadow: "2px 2px 8px 2px rgba(40,40,40,0.4)",
                }}
            >
                <h2 className="text-lg font-bold tracking-tight flex items-center gap-1.5 justify-center">
                    {infoCollection?.name || collectionName || title}
                    {hasCutInPanel && <GridPanelToggleIndicator isOpen={showCutInPanel} />}
                </h2>
                {(infoCollection?.description || subtitle) && (
                    <p className="mt-0.5 max-w-[min(40rem,calc(100vw-8rem))] text-xs leading-relaxed opacity-50 line-clamp-2 whitespace-normal break-words">
                        {infoCollection?.description || subtitle}
                    </p>
                )}
            </div>

            {/* Honeycomb Drag/Viewport Canvas Area */}
            <GridViewCanvas
                containerRef={containerRef}
                dragControls={dragControls}
                showLoading={showLoading}
                hasStandIn={Boolean(standIn)}
                gridItemCount={gridItems.length}
                loadFailureSaid={loadFailureSaid}
                hasSearchQuery={hasSearchQuery}
                loadError={loadError}
                dragBounds={dragBounds}
                dragX={dragX}
                dragY={dragY}
                onDragStart={() => {
                    if (pendingFocusCommitTimeoutRef.current) {
                        clearTimeout(pendingFocusCommitTimeoutRef.current);
                        pendingFocusCommitTimeoutRef.current = null;
                    }
                    isDraggingRef.current = true;
                }}
                className="w-full flex-1 relative flex items-center justify-center cursor-grab active:cursor-grabbing overflow-hidden"
                style={{ touchAction: 'none' }}
            >
                {showLoading ? (
                    // (The stand-in says it where it shows: both stand at the middle.)
                    !standIn && (
                        <div className="flex flex-col items-center gap-4 opacity-50">
                            <Loader2 className="animate-spin" size={32} />
                            <span className="text-sm font-semibold font-sans">{t('playlist.loading')}</span>
                        </div>
                    )
                ) : gridItems.length === 0 ? (
                    <div className="max-w-md px-6 text-center text-sm font-sans opacity-40">
                        {loadFailureSaid
                            ? (
                                <>
                                    <p>{loadFailureSaid.title}</p>
                                    {loadFailureSaid.note && <p>{loadFailureSaid.note}</p>}
                                    {loadFailureSaid.quote && (
                                        <p className="mt-1 text-xs [overflow-wrap:anywhere]">
                                            {loadFailureSaid.quote.text}
                                            {loadFailureSaid.quote.code && <code className="ml-1.5 font-mono">{loadFailureSaid.quote.code}</code>}
                                        </p>
                                    )}
                                </>
                            )
                            : hasSearchQuery ? (t('home.gridSearchNoResults'))
                                // Given no tracks because their read failed: not a collection that holds none.
                                : loadError && !hasSearchQuery ? t('playlist.loadFailedPlain') : (t('home.loadingLibrary'))}
                    </div>
                ) : (
                    <motion.div
                        data-grid-canvas
                        drag
                        dragListener={false}
                        dragControls={dragControls}
                        dragConstraints={dragBounds}
                        dragElastic={0.05}
                        dragTransition={{ power: 0.16, timeConstant: 220 }}
                        onDragStart={() => {
                            if (pendingFocusCommitTimeoutRef.current) {
                                clearTimeout(pendingFocusCommitTimeoutRef.current);
                                pendingFocusCommitTimeoutRef.current = null;
                            }
                            isDraggingRef.current = true;
                        }}
                        onDragEnd={() => {
                            setTimeout(() => {
                                isDraggingRef.current = false;
                                flushHeldResourceSnapshot();
                                scheduleFocusedIndexCommit(140);
                            }, 50);
                        }}
                        style={{ x: dragX, y: dragY, background: 'rgba(0,0,0,0)', touchAction: 'none' }}
                        className="absolute inset-0 flex items-center justify-center cursor-grab active:cursor-grabbing bg-transparent"
                    >
                        <AnimatePresence initial={false}>
                            {memoizedCards}
                        </AnimatePresence>
                    </motion.div>
                )}

                {/* The stand-in: where the centred card stands (the middle of this box, at the
                    centred card's scale), in a card's frame. Not on the canvas, so a drag does
                    not move it from under a cover in flight. It goes when its handover to the
                    hero card says so, by then turned edge-on or faded out: nothing here takes it
                    off the screen. `perspective` as the cards' own boxes have it, for its turn. */}
                {standIn && !standIn.gone && (
                    <motion.div
                        aria-hidden="true"
                        className="absolute left-1/2 top-1/2 z-[60] pointer-events-none"
                        style={{ x: '-50%', y: '-50%', scale: HEX_CARD_CENTER_SCALE, perspective: '1200px' }}
                    >
                        <div
                            ref={standInCardRef}
                            {...{ [MORPH_FRAME_ATTR]: '' }}
                            {...(fullBleedCover ? { [MORPH_TARGET_ATTR]: '' } : {})}
                            className={`relative rounded-xl border shadow-lg theme-polaroid-card ${fullBleedCover ? 'overflow-hidden' : 'p-3'}`}
                            style={{ width: layoutConfig.cardWidth, [fullBleedCover ? 'height' : 'minHeight']: layoutConfig.cardHeight }}
                        >
                            <div
                                {...(fullBleedCover ? {} : { [MORPH_TARGET_ATTR]: '' })}
                                className={fullBleedCover
                                    ? 'absolute inset-0 bg-zinc-200/60 dark:bg-zinc-800/60'
                                    : 'relative w-full aspect-square rounded-lg overflow-hidden bg-zinc-200/60 dark:bg-zinc-800/60 shadow-inner'}
                            >
                                {standIn.coverUrl && (
                                    <img src={standIn.coverUrl} alt="" draggable={false} decoding="sync" className="absolute inset-0 h-full w-full object-cover" />
                                )}
                            </div>
                            {fullBleedCover && <div className="absolute inset-0" style={{ backgroundImage: fullBleedScrim(isDaylight) }} />}
                            {/* The title that flies with the cover (the clicked card's; the
                                collection's own where that card has none), where a card's
                                title stands, and under it what the page is doing. */}
                            <div className={fullBleedCover ? 'absolute inset-x-0 bottom-0 flex flex-col gap-1 p-3 text-left' : 'pt-3 text-left'}>
                                <div
                                    {...{ [CARD_TITLE_ATTR]: '' }}
                                    className={fullBleedCover
                                        ? 'text-sm font-bold tracking-tight leading-snug line-clamp-3 whitespace-normal break-words'
                                        : 'text-s font-bold tracking-tight opacity-90 max-w-full line-clamp-4 whitespace-normal break-words'}
                                >
                                    {standIn.title ?? collectionName ?? title}
                                </div>
                                {showLoading && (
                                    <div className="mt-1 flex items-center gap-2 text-xs font-semibold font-sans opacity-60">
                                        <Loader2 className="animate-spin shrink-0" size={14} />
                                        <span className="truncate">{t('playlist.loading')}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </motion.div>
                )}

                {/* Cut-in Info Panel Overlay */}
                <AnimatePresence>
                    {showCutInPanel && mode === 'tracks' && collection && (
                        <motion.div
                            data-glass
                            data-wheel-scroll-region
                            onWheelCapture={event => event.stopPropagation()}
                            initial={{ opacity: 0, x: -60, scale: 0.95 }}
                            animate={{ opacity: 1, x: 0, scale: 1 }}
                            exit={{ opacity: 0, x: -60, scale: 0.95 }}
                            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                            className="absolute left-6 top-24 w-80 rounded-3xl z-[80] overflow-y-auto overscroll-contain hide-scrollbar flex flex-col p-6 shadow-2xl border backdrop-blur-2xl pointer-events-auto theme-glass-panel"
                            style={{
                                bottom: bottomBarPanelBottomPx,
                                boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.2)',
                            }}
                        >
                            {/* Cover Image */}
                            <div className="w-full aspect-square rounded-2xl overflow-hidden shadow-lg mb-4 bg-zinc-800/20 relative shrink-0">
                                {infoPanelCoverUrl ? (
                                    <img src={getSizedCoverUrl(toHttps(infoPanelCoverUrl), 512)} alt={infoCollection?.name || title} decoding="async" className="w-full h-full object-cover select-none pointer-events-none" />
                                ) : (
                                    <Disc size={64} className="opacity-20 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                                )}
                                {showSubscribeButton && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            void handleToggleSubscribe();
                                        }}
                                        className="absolute bottom-3 right-3 w-10 h-10 rounded-full flex items-center justify-center transition-all shadow-lg active:scale-90 z-10 border border-white/10 hover:scale-105 cursor-pointer backdrop-blur-md"
                                        style={{
                                            backgroundColor: isDaylight ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.5)',
                                        }}
                                        title={playlistSubscribed ? (isOnlineAlbum ? t('options.unsubscribeAlbum') : t('options.unsubscribePlaylist')) : (isOnlineAlbum ? t('options.subscribeAlbum') : t('options.subscribePlaylist'))}
                                    >
                                        <Star
                                            key={starPresses}
                                            size={18}
                                            className={`${starPresses > 0 ? 'star-pop ' : ''}${playlistSubscribed ? 'text-yellow-500 fill-yellow-500' : 'opacity-60 hover:opacity-100'}`}
                                            style={{ color: playlistSubscribed ? undefined : 'var(--text-primary)' }}
                                        />
                                    </button>
                                )}
                            </div>

                            {/* Title & Creator */}
                            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain custom-scrollbar pr-1 space-y-4 text-left min-w-0">
                                <div>
                                    {canRename && isEditMode ? (
                                        <input
                                            value={editableTitle}
                                            onChange={(event) => setEditableTitle(event.target.value)}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter') {
                                                    event.preventDefault();
                                                    void handleSourceEditToggle();
                                                }
                                            }}
                                            className="w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xl font-bold outline-none transition-colors focus:border-sky-400"
                                            style={{ color: 'var(--text-primary)' }}
                                            autoFocus
                                        />
                                    ) : (
                                        <button
                                            type="button"
                                            disabled={!mutationCapabilities.editEntity.supported}
                                            onClick={handleEditEntity}
                                            className="text-left text-xl font-bold line-clamp-2 leading-snug disabled:cursor-default"
                                        >
                                            {infoCollection?.name || title}
                                        </button>
                                    )}
                                    {infoCollection?.creator && (
                                        <div className="flex items-center gap-2 mt-2 text-xs opacity-60">
                                            <div className="w-5 h-5 rounded-full overflow-hidden">
                                                <img src={toHttps(infoCollection.creator.avatarUrl)} alt="avatar" className="w-full h-full object-cover" />
                                            </div>
                                            <span className="font-semibold">{infoCollection.creator.nickname}</span>
                                        </div>
                                    )}
                                    <div className="text-[10px] opacity-40 mt-1.5">
                                        {(isDailyRecommendationsCollection || infoCollection?.trackCount !== undefined) && (
                                            <span>{isDailyRecommendationsCollection ? displayTracks.length : infoCollection.trackCount} {t('home.songs')}</span>
                                        )}
                                        {infoCollection?.playCount !== undefined && <span> • {infoCollection.playCount} {t('playlist.plays')}</span>}
                                    </div>
                                    {isDailyRecommendationsCollection && (
                                        <div className="mt-3 space-y-2">
                                            <div className="flex items-center gap-2">
                                                {mutationSnapshot.dailyHistoryAvailable && (
                                                    <div className="min-w-0 flex-1">
                                                        <CustomSelect
                                                            value={mutationSnapshot.dailyDate}
                                                            onChange={date => void handleDailyRecommendationDateChange(date)}
                                                            options={[
                                                                { value: '', label: t('home.todayRecommendations') },
                                                                ...mutationSnapshot.dailyHistoryDates.map(date => ({ value: date, label: date })),
                                                            ]}
                                                            placeholder={t('home.todayRecommendations')}
                                                            ariaLabel={t('home.recommendationDate')}
                                                            disabled={loading}
                                                            isDaylight={isDaylight}
                                                            theme={theme}
                                                        />
                                                    </div>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => void handleDailyRecommendationDateChange('', true)}
                                                    disabled={loading || Boolean(mutationSnapshot.dailyDate)}
                                                    title={t('home.refreshRecommendations')}
                                                    aria-label={t('home.refreshRecommendations')}
                                                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 transition-colors hover:bg-white/10 disabled:opacity-30"
                                                >
                                                    <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                    {isAlbumCollection && (
                                        <div className="mt-3 space-y-1.5 text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
                                            {albumAlias && (
                                                <div className="font-medium opacity-80">{albumAlias}</div>
                                            )}
                                            {albumArtists.length > 0 ? (
                                                <div className="flex flex-wrap gap-x-2 gap-y-1">
                                                    {albumArtists.map((artist: { id: string | number; name: string }, index: number) => (
                                                        <button
                                                            key={`${artist.id}-${index}`}
                                                            type="button"
                                                            onClick={() => onSelectArtist?.(artist.id, artist)}
                                                            className="font-semibold hover:underline"
                                                        >
                                                            {artist.name}
                                                        </button>
                                                    ))}
                                                </div>
                                            ) : null}
                                            {albumArtists.length === 0 && infoCollection?.albumArtist && (
                                                <div className="font-semibold">{infoCollection.albumArtist}</div>
                                            )}
                                            {(formatAlbumDate(albumPublishedAt) || albumPublisher) && (
                                                <div>
                                                    {[formatAlbumDate(albumPublishedAt), albumPublisher]
                                                        .filter(Boolean)
                                                        .join(' • ')}
                                                </div>
                                            )}
                                            {isNavidromeCollection && (
                                                <div>
                                                    {[infoCollection?.albumYear, infoCollection?.albumGenre, formatAlbumDuration(infoCollection?.albumDuration)]
                                                        .filter(Boolean)
                                                        .join(' • ')}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* Description */}
                                {infoCollection?.description && (
                                    <p data-wheel-scroll-region className="text-xs opacity-65 leading-relaxed break-words whitespace-pre-wrap max-h-40 overflow-y-auto overscroll-contain pr-1">
                                        {infoCollection.description}
                                    </p>
                                )}
                            </div>

                            {/* Buttons Area */}
                            <div
                                // 这一排里有重扫、整理 tag 和删除，删除是不可逆的 ——
                                // 思索把整块认成一个目标，指着哪一颗都讲得到。
                                data-ponder={isLocalCollection ? 'local-folder-actions' : 'online-collection-actions'}
                                className="space-y-2 mt-4 pt-4 border-t shrink-0"
                                style={{ borderTopColor: 'color-mix(in srgb, var(--text-primary) 12%, transparent)' }}
                            >
                                <button
                                    onClick={() => {
                                        if (onPlayAll && contextActionTracks.length > 0) {
                                            onPlayAll(contextActionTracks);
                                        }
                                    }}
                                    disabled={contextActionTracks.length === 0}
                                    className="w-full py-3 rounded-full font-bold text-xs transition-transform hover:scale-102 active:scale-98 flex items-center justify-center gap-1.5 shadow-md disabled:opacity-40 disabled:hover:scale-100 cursor-pointer"
                                    style={{ backgroundColor: 'var(--text-primary)', color: 'var(--bg-color)' }}
                                >
                                    <Play size={14} fill="currentColor" />
                                    {hasSearchQuery
                                        ? t('playlist.playFilteredTracks', { count: contextActionTracks.length })
                                        : t('playlist.playAll')}
                                </button>
                                <button
                                    onClick={() => {
                                        if (onAddAllToQueue && contextActionTracks.length > 0) {
                                            onAddAllToQueue(contextActionTracks);
                                        }
                                    }}
                                    disabled={contextActionTracks.length === 0}
                                    className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                                >
                                    <ListPlus size={14} />
                                    {hasSearchQuery
                                        ? t('playlist.addFilteredTracksToQueue', { count: contextActionTracks.length })
                                        : t('navidrome.addToQueue')}
                                </button>
                                {canAddNavidromeToPlaylist && (
                                    <button
                                        onClick={() => setIsPlaylistPickerOpen(true)}
                                        disabled={playableTracks.length === 0 || isSourceActionPending}
                                        className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                                    >
                                        <Plus size={14} />
                                        {t('localMusic.addToPlaylist')}
                                    </button>
                                )}
                                {mutationCapabilities.resyncFolder.supported && (
                                    <button
                                        onClick={handleResyncLocalFolder}
                                        disabled={isSourceActionPending}
                                        className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                                    >
                                        {isSourceActionPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                        {t('localMusic.reimport')}
                                    </button>
                                )}
                                {mutationCapabilities.organizeSongInfo.supported && (
                                    <button
                                        onClick={handleOrganizeSongInfo}
                                        className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                                    >
                                        <Tags size={14} />
                                        {t('localMusic.organizeSongInfo')}
                                    </button>
                                )}
                                {mutationCapabilities.resyncAllFolders.supported && (
                                    <button
                                        onClick={handleResyncAllLocalFolders}
                                        disabled={isSourceActionPending}
                                        className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                                    >
                                        {isSourceActionPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                        {t('localMusic.reimport')}
                                    </button>
                                )}
                                {canReloadOnlineCollection && (
                                    <button
                                        onClick={reloadOnlineCollection}
                                        disabled={loading}
                                        className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                                    >
                                        {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                        {t('playlist.reload')}
                                    </button>
                                )}
                                {canEditPlaylist && (
                                    <button
                                        onClick={handleEditModeToggle}
                                        disabled={isSourceActionPending}
                                        // 思索靠这个属性认出它。类名会改，属性不会。
                                        data-ponder="grid-view-edit-mode"
                                        className={`w-full py-2.5 rounded-full text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${isEditMode ? 'bg-red-500/20 text-red-500 border border-red-500/30' : 'bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900'}`}
                                    >
                                        {isSourceActionPending ? <Loader2 size={14} className="animate-spin" /> : <Pencil size={14} />}
                                        {isDailyRecommendationsCollection
                                            ? (isEditMode ? t('home.finishManagingRecommendations') : t('home.manageRecommendations'))
                                            : (isEditMode ? t('localMusic.finishEditing') : t('localMusic.editPlaylist'))}
                                    </button>
                                )}
                                {mutationCapabilities.exportPlaylist.supported && (
                                    <button
                                        onClick={handleExportLocalPlaylist}
                                        disabled={isSourceActionPending}
                                        className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                                    >
                                        {isSourceActionPending ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                                        {t('localMusic.exportPlaylist')}
                                    </button>
                                )}
                                {mutationCapabilities.editEntity.supported && (
                                    <button
                                        onClick={handleEditEntity}
                                        className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                                    >
                                        <Pencil size={14} />
                                        {t('localMusic.entityInfo', {
                                            kind: collection.type === 'album'
                                                ? t('localMusic.albumLabel')
                                                : t('localMusic.artistLabel'),
                                        })}
                                    </button>
                                )}
                                {mutationCapabilities.setCover.supported && (
                                    <button
                                        onClick={handleSetCover}
                                        className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                                    >
                                        <ImagePlus size={14} />
                                        {t('localCollectionCover.menuLabel')}
                                    </button>
                                )}
                                {mutationCapabilities.deleteCollection.supported && (
                                    <button
                                        onClick={() => isLocalFolderCollection ? setIsDeleteFolderOpen(true) : void handleDeleteSourceCollection()}
                                        disabled={isSourceActionPending}
                                        className="w-full py-2.5 rounded-full text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer bg-red-500/10 text-red-500 border border-red-500/25 hover:bg-red-500/20 disabled:opacity-40"
                                    >
                                        {isSourceActionPending ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                                        {isLocalFolderCollection
                                            ? t('localMusic.delete')
                                            : t('localMusic.deletePlaylist')}
                                    </button>
                                )}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
            <PlaylistSelectionDialog
                isOpen={isPlaylistPickerOpen}
                title={t('localMusic.addToPlaylist')}
                playlists={mutationSnapshot.availablePlaylists}
                onClose={() => setIsPlaylistPickerOpen(false)}
                onSelect={(playlistId) => {
                    void handleAddNavidromeCollectionToPlaylist(playlistId);
                    setIsPlaylistPickerOpen(false);
                }}
                cards={memoizedCards}
            />

                <GridViewStandInCard
                    standIn={standIn}
                    standInCardRef={standInCardRef}
                    fullBleedCover={fullBleedCover}
                    cardWidth={layoutConfig.cardWidth}
                    cardHeight={layoutConfig.cardHeight}
                    isDaylight={isDaylight}
                    showLoading={showLoading}
                    collectionName={collectionName}
                    title={title}
                />

            {/* Cut-in Info Panel Overlay */}
            <GridViewCutInPanel
                isOpen={showCutInPanel && hasCutInPanel}
                title={title}
                infoCollection={infoCollection}
                coverUrl={coverUrl}
                actionsPonderTarget={isLocalCollection ? 'local-folder-actions' : 'online-collection-actions'}
                isDaylight={isDaylight}
                theme={theme}
                isLocalCollection={isLocalCollection}
                isLocalFolderCollection={isLocalFolderCollection}
                isNavidromeCollection={isNavidromeCollection}
                isAlbumCollection={isAlbumCollection}
                isDailyRecommendationsCollection={isDailyRecommendationsCollection}
                isCloudThemeCollection={isCloudThemeCollection}
                collection={collection}
                loading={loading}
                hasSearchQuery={hasSearchQuery}
                displayTrackCount={displayTracks.length}
                contextActionTracks={contextActionTracks}
                playableTracks={playableTracks}
                albumAlias={albumAlias}
                albumArtists={albumArtists}
                albumPublishedAt={albumPublishedAt}
                albumPublisher={albumPublisher}
                mutationSnapshot={mutationSnapshot}
                mutationCapabilities={mutationCapabilities}
                isSourceActionPending={isSourceActionPending}
                canRename={canRename}
                isEditMode={isEditMode}
                editableTitle={editableTitle}
                onEditableTitleChange={setEditableTitle}
                onToggleSourceEdit={handleSourceEditToggle}
                onEditEntity={handleEditEntity}
                onToggleEditMode={handleEditModeToggle}
                canEditPlaylist={canEditPlaylist}
                canReloadThisCollection={canReloadThisCollection}
                onReloadCollection={reloadOnlineCollection}
                canAddNavidromeToPlaylist={canAddNavidromeToPlaylist}
                onOpenPlaylistPicker={() => setIsPlaylistPickerOpen(true)}
                onRequestDeleteFolder={() => setIsDeleteFolderOpen(true)}
                onDeleteCollection={handleDeleteSourceCollection}
                confirmLocalSongRemoval={confirmLocalSongRemoval}
                onExportPlaylist={handleExportLocalPlaylist}
                onResyncFolder={handleResyncLocalFolder}
                onResyncAllFolders={handleResyncAllLocalFolders}
                onOrganizeSongInfo={handleOrganizeSongInfo}
                onSetCover={handleSetCover}
                showSubscribeButton={showSubscribeButton}
                playlistSubscribed={playlistSubscribed}
                isOnlineAlbum={isOnlineAlbum}
                starPresses={starPresses}
                onToggleSubscribe={handleToggleSubscribe}
                onDailyDateChange={handleDailyRecommendationDateChange}
                onPlayAll={onPlayAll}
                onAddAllToQueue={onAddAllToQueue}
                onSelectArtist={onSelectArtist}
            />

            <GridViewDialogs
                isPlaylistPickerOpen={isPlaylistPickerOpen}
                playlists={mutationSnapshot.availablePlaylists}
                isCreatePlaylistOpen={isCreatePlaylistOpen}
                pendingLocalRemoval={pendingLocalRemoval}
                isDeleteFolderOpen={isDeleteFolderOpen}
                collectionName={collection?.name}
                isDaylight={isDaylight}
                onClosePlaylistPicker={() => setIsPlaylistPickerOpen(false)}
                onSelectPlaylist={(playlistId) => {
                    void handleAddNavidromeCollectionToPlaylist(playlistId);
                }}
                onRequestCreatePlaylist={() => setIsCreatePlaylistOpen(true)}
                onCloseCreatePlaylist={() => setIsCreatePlaylistOpen(false)}
                onCreatePlaylist={(name) => {
                    void handleCreateNavidromePlaylist(name);
                }}
                onConfirmLocalRemoval={(pending) => {
                    setPendingLocalRemoval(null);
                    void runRemoveTrack(pending.track, pending.entryKey);
                }}
                onCloseLocalRemoval={() => setPendingLocalRemoval(null)}
                onConfirmDeleteFolder={() => {
                    setIsDeleteFolderOpen(false);
                    void handleDeleteSourceCollection();
                }}
                onCloseDeleteFolder={() => setIsDeleteFolderOpen(false)}
            />

            {mode === 'tracks' && (
                <GridViewTracksPanel
                    isOpen={showSidePanel}
                    onClose={() => setShowSidePanel(false)}
                    title={collectionName || title}
                    tracks={displayTracks}
                    isDaylight={isDaylight}
                    theme={theme}
                    focusedIndex={listFocusedIndex}
                    revealTimes={locatedTimes}
                    hideTitle={isLocalFolderCollection}
                    supportsTrackSorting={supportsTrackSorting}
                    sorting={sorting}
                    showFloatingButton={displayTracks.length > 0}
                    showLocateButton={playingSongKey !== null && Boolean(collection)}
                    isPlayingSongHere={isPlayingSongHere}
                    isLocateAsked={isLocateAsked}
                    onLocate={locateOnThisPage}
                    onOpenList={() => setShowSidePanel(true)}
                    onPlay={(track) => {
                        onSelectTrack?.(track, playableTracks);
                    }}
                    onAddToQueue={onAddTrackToQueue ? (track) => {
                        onAddTrackToQueue(track);
                    } : undefined}
                    getAlbumTrackLabel={getAlbumTrackLabel}
                />
            )}
        </motion.div>
    );
};

export default GridView;
