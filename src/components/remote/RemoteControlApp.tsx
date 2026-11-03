import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { PlayerState } from '../../types';
import { idleVideoExportState } from '../../types/videoExport';
import { useReducedMotionFor } from '../../hooks/useReducedMotionFor';
import { isRemoteExportBusy } from './RemoteExportTab';
import RemoteKeyRow from './RemoteKeyRow';
import RemoteLyricBlock from './RemoteLyricBlock';
import RemoteProgressLine from './RemoteProgressLine';
import RemoteQueue from './RemoteQueue';
import RemoteSheet from './RemoteSheet';
import RemoteSongLine, { RemoteCoverFaces, RemoteOutgoingRecede } from './RemoteSongLine';
import RemoteWindowTools, { type RemoteBackgroundMode } from './RemoteWindowTools';
import {
    syncLyricFlatAttribute,
    useLyricFlatSettingsStore,
} from '../../stores/useLyricFlatSettingsStore';
import RemoteCardSurface, { type RemoteBackgroundMode } from './RemoteCardSurface';
import RemoteCoverTile from './RemoteCoverTile';
import RemoteLyricOverlay from './RemoteLyricOverlay';
import RemotePresetSelector from './RemotePresetSelector';
import RemoteProgressSlider from './RemoteProgressSlider';
import RemoteTitlebarTools from './RemoteTitlebarTools';
import RemoteTrackHeading from './RemoteTrackHeading';
import RemoteTransparentControls from './RemoteTransparentControls';
import RemoteTransportBar from './RemoteTransportBar';
import RemoteVideoExportPanel from './RemoteVideoExportPanel';
import { shouldRevealRemoteTitlebar } from './remoteTitlebarReveal';
import {
    REMOTE_NO_DRAG_STYLE,
    sendRemoteCommand,
    useRemoteSnapshot,
    useRemoteWindowPresentation,
} from './remoteWindowBridge';
import { useRemoteCoverArt } from './useRemoteCoverArt';
import { useRemoteExportChoices } from './useRemoteExportChoices';
import { useRemoteLyricLine } from './useRemoteLyricLine';
import { useRemoteQueue } from './useRemoteQueue';
import { useRemoteSheet } from './useRemoteSheet';
import { useRemoteSleeve } from './useRemoteSleeve';
import { useRemoteTrackHandoff } from './useRemoteTrackHandoff';

// src/components/remote/RemoteControlApp.tsx
// Electron-only companion window for controlling the single real player instance.
// A block of type (the song, the line being sung, its translation), one line that is both the
// divider and the progress bar, and a row of keys. With the pointer in, it lights up what already
// has a place; a moment after the pointer leaves, the keys go and the line takes their place, and
// (with the switch "expand cover" on) the card turns into a sleeve: the cover large on the left,
// the song and the line on the right. The queue key grows the window down or up, wherever the
// screen has room, to show the play queue. This file holds the window's state and puts the parts together.

const REMOTE_CONTROL_DOCUMENT_TITLE = 'Folia Remote';
const REMOTE_BACKGROUND_MODE_STORAGE_KEY = 'remote_background_mode';

type RemotePanelMode = 'playback' | 'export' | 'transparent-controls';

const SWITCH_PANEL_TRANSITION = { duration: 0.15 } as const;

const readStoredBackgroundMode = (): RemoteBackgroundMode => {
    if (typeof window !== 'undefined') {
        const stored = window.localStorage.getItem(REMOTE_BACKGROUND_MODE_STORAGE_KEY);
        if (stored === 'cover' || stored === 'transparent' || stored === 'default') {
            return stored;
        }
    }
    return 'default';
};

const RemoteControlApp: React.FC = () => {
    const { t } = useTranslation();
    const reduceMotion = useReducedMotionFor('uiMicroMotion');
    const snapshot = useRemoteSnapshot();
    const presentation = useRemoteWindowPresentation();
    const draft = useRemoteExportDraft();

    const [backgroundMode, setBackgroundMode] = useState<RemoteBackgroundMode>(readStoredBackgroundMode);
    const [pendingSeek, setPendingSeek] = useState<number | null>(null);
    const [activePanel, setActivePanel] = useState<RemotePanelMode>('playback');
    const [windowControlsRevealed, setWindowControlsRevealed] = useState(false);
    const [hoverNavSide, setHoverNavSide] = useState<'prev' | 'next' | null>(null);

    const isDraggingRef = useRef(false);
    const lastSeekTimeRef = useRef(0);
    const cardRef = useRef<HTMLDivElement | null>(null);

    const isPlaying = snapshot.playerState === PlayerState.PLAYING;
    const duration = Number.isFinite(snapshot.duration) && snapshot.duration > 0 ? snapshot.duration : 0;
    const primaryDisabled = snapshot.controlsDisabled || !snapshot.hasTrack;
    const exportState = snapshot.exportState ?? idleVideoExportState();
    const exportBusy = isRemoteExportBusy(exportState.status);
    const title = snapshot.title || (snapshot.hasTrack ? 'Folia' : t('remote.noTrack'));
    const artist = snapshot.artist || (snapshot.hasTrack ? t('remote.unknownArtist') : '');

    const clock = useRemoteClock({
        updatedAt: snapshot.updatedAt,
        currentTime: snapshot.currentTime,
        duration,
        playerState: snapshot.playerState,
    });
    const lyricOffsetSec = (snapshot.lyricOffsetMs || 0) / 1000;
    const lyric = useRemoteLyricLine(snapshot.hasTrack ? snapshot.lyrics : null, clock, lyricOffsetSec);
    const handoff = useRemoteTrackHandoff({ snapshot, title, artist, isPlaying });
    // Past the audio crossover the outgoing song's line has receded: the stage turns to the incoming
    // song's title card there, inside the blend, rather than when the blend settles.
    const lyricGivesWay = handoff.isHandoffActive && handoff.isIncomingDominant;
    const shownLine = lyricGivesWay ? null : lyric.line;
    useRemoteCoverArt({
        prevTrackCoverUrl: snapshot.prevTrackCoverUrl,
        nextTrackCoverUrl: snapshot.nextTrackCoverUrl,
    });

    // A click-through window is a display: nothing lights up and nothing opens.
    const isDisplayOnly = presentation.clickThrough;
    const isLit = !isDisplayOnly && (pointerLingers || hasKeyboardFocus);
    const sheet = useRemoteSheet({
        exportStatus: exportState.status,
        isExportBusy: exportBusy,
        pointerInside,
        isDisplayOnly,
    });
    const queue = useRemoteQueue({
        queueLength: snapshot.queue?.length ?? 0,
        pointerInside,
        isDisplayOnly,
        isSheetOpen: sheet.isOpen,
    });
    // An open sheet is the card in use too: it stands where the sleeve's song and line would be.
    // So is an open queue: it hangs off the card in use.
    const isIdle = useRemoteSleeve(!isLit && !sheet.isOpen && !queue.isOpen, reduceMotion, cardRef);
    // Idle puts the line where the keys were; the switch "expand cover" decides whether it also opens the sleeve.
    const isSleeve = isIdle && presentation.expandCover;
    // The switch "text shade", off by default: without it the idle type stands on what is behind the window with only its thin shadow.
    const hasTextShade = backgroundMode === 'transparent' && presentation.textShade;
    useRemoteTextShade(hasTextShade, stageRef, textShadeRef, isSleeve);

    useEffect(() => {
        document.body.style.backgroundColor = 'transparent';
        document.documentElement.style.backgroundColor = 'transparent';
        document.body.style.overflow = 'visible';
        document.title = REMOTE_CONTROL_DOCUMENT_TITLE;
    }, []);

    // 把扁平开关挂到本页的 <html> 上（遥控窗口是独立 document，要自己挂一份）。
    useEffect(() => {
        syncLyricFlatAttribute(flatLyrics);
    }, [flatLyrics]);

    useEffect(() => {
        window.localStorage.setItem(REMOTE_BACKGROUND_MODE_STORAGE_KEY, backgroundMode);
    }, [backgroundMode]);

    // A focused control that leaves with the sheet or the queue sends no blur; without this the window would stay lit.
    useEffect(() => {
        if ((!sheet.isOpen || !queue.isShown) && !document.activeElement?.matches(':focus-visible')) {
            setHasKeyboardFocus(false);
        }
    }, [sheet.isOpen, queue.isShown]);

    const navigateTrack = (direction: 'prev' | 'next') => {
        handoff.recordNavIntent(direction);
        sendRemoteCommand({ type: direction === 'prev' ? 'previous' : 'next' });
    };

    const previewTitle = hoverNavSide === 'prev' && snapshot.canGoPrevious
        ? snapshot.prevTrackTitle
        : hoverNavSide === 'next' && snapshot.canGoNext
            ? snapshot.nextTrackTitle
            : null;

    /*
     * 歌词里「正在唱的那一句」的填充色。
     *
     * 以前直接复用黑白对比色（深色下就是纯白），于是逐字推进看起来就是一条
     * **白色进度条**，而唱完之后那一句归到"已唱"、反而带上颜色 ——
     * 用户报的正是「正在放的那一句渐变进度是纯白的，放完它后面的又变成有颜色的」。
     * 高亮色要的是这首歌的配色，而不是"文字和背景的对比色"：
     * 优先用封面主色（和主窗口背景取的是同一路配色来源），
     * 拿不到封面取色时再退回原来的黑白。
     */
    const activeColor = isDaylight ? '#1c1917' : '#ffffff';
    const lyricAccentColor = activeCoverColors[0] || activeColor;
    /*
     * 歌词里已唱/未唱的底色。封面铺满整卡时歌词压在封面上，
     * 白天那套"黑字"会压在可能很暗的封面上，所以一律走白。
     */
    const lyricBaseColor = isSleeve
        ? 'rgba(255, 255, 255, 0.4)'
        : isDaylight ? 'rgba(0, 0, 0, 0.35)' : 'rgba(255, 255, 255, 0.35)';
    const transitionGlowColor = isDaylight ? 'rgba(28, 25, 23, 0.45)' : 'rgba(255, 255, 255, 0.8)';

    const backToPlayback = () => {
        setActivePanel('playback');
        draft.setPresetSelectorOpen(false);
    };

    const lastStatusRef = useRef(exportState.status);
    useEffect(() => {
        if (exportState.status !== 'idle' && lastStatusRef.current === 'idle') {
            setActivePanel('export');
        }
        lastStatusRef.current = exportState.status;
    }, [exportState.status]);

    return (
        <main
            className="remote-window"
            data-theme={snapshot.isDaylight ? 'light' : 'dark'}
            data-bg={backgroundMode}
            data-lit={isLit && !isIdle}
            data-idle={isIdle}
            data-sleeve={isSleeve}
            data-paused={snapshot.hasTrack && !isPlaying}
            data-sheet={sheet.isOpen}
            data-notitle={presentation.hideTitlebar || isDisplayOnly}
            data-queue={queue.direction ?? undefined}
            data-shifting={queue.isShifting}
            onFocus={event => setHasKeyboardFocus(event.target.matches(':focus-visible'))}
            onBlur={() => setHasKeyboardFocus(false)}
        >
            <div
                ref={cardRef}
                className={`relative flex h-full w-full rounded-[20px] border p-4 items-center justify-center overflow-hidden transition-colors duration-300 ${backgroundMode === 'transparent' ? 'border-transparent' : (isDaylight ? 'border-black/10' : 'border-white/10')
                    }`}
            >
                <RemoteCardSurface
                    backgroundMode={backgroundMode}
                    isDaylight={isDaylight}
                    coverColors={activeCoverColors}
                    titlebarRevealed={windowControlsRevealed}
                    isSleeve={isSleeve}
                    coverUrl={handoff.currentCoverUrl}
                />

                <RemoteTitlebarTools
                    backgroundMode={backgroundMode}
                    isDaylight={isDaylight}
                    revealed={windowControlsRevealed}
                    onKeepRevealed={() => setWindowControlsRevealed(true)}
                    isSleeve={isSleeve}
                    onCycleBackgroundMode={() => setBackgroundMode(previous => (
                        previous === 'default' ? 'cover' : previous === 'cover' ? 'transparent' : 'default'
                    ))}
                />

                <div className="w-full flex items-center" style={REMOTE_NO_DRAG_STYLE}>
                    {/*
                     * 封面铺满整卡时，左边那一格塌到 0：小封面已经淡出让位，
                     * 塌掉之后右栏的字正好落在整张卡的中间偏左，看着才像压在封面上。
                     * grid-template-columns 可以插值，所以这一下是滑过去而不是跳过去。
                     */}
                    <div
                        className="grid w-full items-center transition-[grid-template-columns,gap] duration-[620ms] ease-out"
                        style={{
                            gridTemplateColumns: isSleeve ? '0px 1fr' : '112px 1fr',
                            gap: isSleeve ? '0px' : '16px',
                        }}
                    >
                        {/* Left Column: Cover Art with Hover Back Overlay */}
                        <RemoteCoverTile
                            isDaylight={isDaylight}
                            coverUrl={handoff.currentCoverUrl}
                            coverFaces={handoff.coverFaces}
                            hasIncomingCoverFace={handoff.hasIncomingCoverFace}
                            isHandoffActive={handoff.isHandoffActive}
                            handoffIncomingOpacity={handoff.handoffIncomingOpacity}
                            handoffOutgoingOpacity={handoff.handoffOutgoingOpacity}
                            trackEnterOffset={handoff.trackEnterOffset}
                            showBack={activePanel !== 'playback'}
                            onBack={backToPlayback}
                            countdown={exportState.status === 'countdown' ? exportState.countdown : null}
                            isSleeve={isSleeve}
                        />

                        {/* Right Column: Track details & controls (Playback or Export) */}
                        <div className="flex flex-col justify-between min-h-[112px] min-w-0">
                            <RemoteTrackHeading
                                isDaylight={isDaylight}
                                isSleeve={isSleeve}
                                faces={handoff.faces}
                                isHandoffActive={handoff.isHandoffActive}
                                handoffIncomingOpacity={handoff.handoffIncomingOpacity}
                                handoffOutgoingOpacity={handoff.handoffOutgoingOpacity}
                                trackEnterOffset={handoff.trackEnterOffset}
                                previewTitle={previewTitle}
                            />

                            {/* Dynamic Panel with Framer Motion transitions */}
                            <div className="relative min-h-[70px] w-full">
                                <AnimatePresence mode="wait">
                                    {activePanel === 'playback' ? (
                                        <motion.div
                                            key="playback-panel"
                                            initial={{ opacity: 0, y: 5 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            exit={{ opacity: 0, y: -5 }}
                                            transition={SWITCH_PANEL_TRANSITION}
                                            className="w-full flex flex-col justify-between h-[70px]"
                                        >
                                            {/* Progress Slider (Always Visible) */}
                                            <RemoteProgressSlider
                                                isDaylight={isDaylight}
                                                isSleeve={isSleeve}
                                                progressValue={progressValue}
                                                duration={duration}
                                                progressPercent={progressPercent}
                                                isTransitionGlowActive={handoff.isTransitionGlowActive}
                                                glowColor={transitionGlowColor}
                                                disabled={primaryDisabled}
                                                pendingSeek={pendingSeek}
                                                onPendingSeek={setPendingSeek}
                                                isDraggingRef={isDraggingRef}
                                                lastSeekTimeRef={lastSeekTimeRef}
                                            />

                                            {/* Toggle area for controls+timestamps or lyrics */}
                                            <div className="flex-1 min-h-0 w-full relative">
                                                <AnimatePresence mode="wait">
                                                    {!isIdle ? (
                                                        <motion.div
                                                            key="controls-view"
                                                            initial={{ opacity: 0, y: 5 }}
                                                            animate={{ opacity: 1, y: 0 }}
                                                            exit={{ opacity: 0, y: -5 }}
                                                            transition={SWITCH_PANEL_TRANSITION}
                                                            className="absolute inset-0"
                                                        >
                                                            <RemoteTransportBar
                                                                isDaylight={isDaylight}
                                                                snapshot={snapshot}
                                                                isPlaying={isPlaying}
                                                                primaryDisabled={primaryDisabled}
                                                                likeDisabled={likeDisabled}
                                                                likeUnavailableReason={likeUnavailableReason}
                                                                progressValue={progressValue}
                                                                duration={duration}
                                                                isExporting={exportState.status === 'recording'}
                                                                onHoverNavSideChange={setHoverNavSide}
                                                                onNavigate={navigateTrack}
                                                                onOpenTransparentControls={() => {
                                                                    draft.setPresetSelectorOpen(false);
                                                                    setActivePanel('transparent-controls');
                                                                }}
                                                                onOpenExport={() => setActivePanel('export')}
                                                            />
                                                        </motion.div>
                                                    ) : (
                                                        <RemoteLyricOverlay
                                                            lyrics={snapshot.lyrics}
                                                            currentTime={snapshot.currentTime - (snapshot.lyricOffsetMs || 0) / 1000}
                                                            duration={snapshot.duration}
                                                            playerState={snapshot.playerState}
                                                            hasTrack={snapshot.hasTrack}
                                                            visible
                                                            baseColor={lyricBaseColor}
                                                            activeColor={lyricAccentColor}
                                                        />
                                                    )}
                                                </AnimatePresence>
                                            </div>
                                        </motion.div>
                                    ) : activePanel === 'export' ? (
                                        <motion.div
                                            key="export-panel"
                                            initial={{ opacity: 0, y: 5 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            exit={{ opacity: 0, y: -5 }}
                                            transition={SWITCH_PANEL_TRANSITION}
                                            className="w-full flex flex-col"
                                        >
                                            <RemoteVideoExportPanel
                                                exportState={exportState}
                                                selectedPreset={draft.selectedPreset}
                                                startMode={draft.startMode}
                                                primaryDisabled={primaryDisabled}
                                                isDaylight={isDaylight}
                                                onOpenPresetSelector={() => draft.setPresetSelectorOpen(true)}
                                                onStartModeChange={draft.setStartMode}
                                                sendCommand={sendRemoteCommand}
                                            />
                                        </motion.div>
                                    ) : (
                                        <motion.div
                                            key="transparent-controls-panel"
                                            initial={{ opacity: 0, y: 5 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            exit={{ opacity: 0, y: -5 }}
                                            transition={SWITCH_PANEL_TRANSITION}
                                            className="w-full flex flex-col"
                                        >
                                            <RemoteTransparentControls
                                                isDaylight={isDaylight}
                                                snapshot={snapshot}
                                            />
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="remote-face" style={REMOTE_DRAG_STYLE}>
                    {hasTextShade && <div ref={textShadeRef} className="remote-cloud" data-empty="true" />}
                    {backgroundMode === 'transparent' && <div className="remote-glass" />}

                    <div ref={stageRef} className="remote-stage" aria-hidden={sheet.isOpen}>
                        <RemoteSongLine mode={shownLine ? 'line' : 'card'} handoff={handoff} reduceMotion={reduceMotion} shade={hasTextShade} />
                        <RemoteOutgoingRecede handoff={handoff} reduceMotion={reduceMotion}>
                            <RemoteLyricBlock
                                line={shownLine}
                                nextLine={lyricGivesWay ? null : lyric.nextLine}
                                isSinging={lyric.isSinging}
                                subtitleContentMode={snapshot.subtitleContentMode}
                                clock={clock}
                                lyricOffsetSec={lyricOffsetSec}
                                reduceMotion={reduceMotion}
                                shade={hasTextShade}
                            />
                        </RemoteOutgoingRecede>
                    </div>

                    <AnimatePresence>
                        {sheet.isOpen && sheet.tab && (
                            <RemoteSheet
                                key="sheet"
                                tab={sheet.tab}
                                snapshot={snapshot}
                                alwaysOnTopSupported={presentation.alwaysOnTopSupported}
                                choices={choices}
                                primaryDisabled={primaryDisabled}
                                reduceMotion={reduceMotion}
                                onTabChange={sheet.setTab}
                                onClose={sheet.close}
                            />
                        )}
                    </AnimatePresence>

                    <RemoteWindowTools
                        backgroundMode={backgroundMode}
                        alwaysOnTopSupported={presentation.alwaysOnTopSupported}
                        onCycleBackgroundMode={() => setBackgroundMode(previous => (
                            previous === 'default' ? 'cover' : previous === 'cover' ? 'transparent' : 'default'
                        ))}
                    />

                    <RemoteProgressLine
                        clock={clock}
                        duration={duration}
                        disabled={primaryDisabled || isDisplayOnly}
                        isTransitionGlowActive={handoff.isTransitionGlowActive}
                        seekLabel={t('ui.seek')}
                        onSeek={time => sendRemoteCommand({ type: 'seek', time })}
                    />

                    {!isDisplayOnly && (
                        <RemoteKeyRow
                            snapshot={snapshot}
                            clock={clock}
                            primaryDisabled={primaryDisabled}
                            isSheetOpen={sheet.isOpen}
                            isQueueOpen={queue.isOpen}
                            isExportBusy={exportBusy}
                            onToggleSheet={sheet.toggle}
                            onToggleQueue={queue.toggle}
                            onNavigate={navigateTrack}
                        />
                    )}
                </AnimatePresence>
            </div>

            <AnimatePresence>
                {queue.isShown && queue.direction && (
                    <RemoteQueue
                        key="queue"
                        direction={queue.direction}
                        height={queue.panelHeight}
                        items={snapshot.queue ?? []}
                        currentKey={snapshot.trackKey}
                        playingKey={snapshot.queuePlayingKey ?? null}
                        readOnly={Boolean(snapshot.queueReadOnly)}
                        disabled={snapshot.controlsDisabled}
                        query={queue.query}
                        onQueryChange={queue.setQuery}
                        reduceMotion={reduceMotion}
                    />
                )}
            </AnimatePresence>
        </main>
    );
};

export default RemoteControlApp;
