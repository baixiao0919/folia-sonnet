import React from 'react';
import { AnimatePresence, motion, useTransform, type MotionValue } from 'framer-motion';
import { Cast, Loader2, RefreshCw, Speaker, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui';
import { usePlaybackStore, selectDisplaySong, selectDisplayCoverUrl } from '../../stores/usePlaybackStore';
import { getSongArtistLabel } from '../../services/onlineMusic/songMetadata';
import {
    castTrackToSpeaker,
    discoverLanSpeakers,
    isLanCastAvailable,
    lanCastErrorText,
    stopCastingToSpeaker,
    type LanSpeaker,
} from '../../services/lanCast';

// src/components/lan-cast/LanCastControl.tsx
// 播放页右下角的投送入口：按钮跟右侧 chrome 一起出现 / 一起消失（由 PanelHandle 传入
// hideToggleButton），点开后弹出设备清单，把当前歌曲交给局域网里的 DLNA / UPnP 音响。

type LanCastControlProps = {
    /** 与右下角那颗按钮共用的隐藏条件，保证两者同时出现、同时消失。 */
    hidden: boolean;
    /** PanelHandle 的贴底基线，避免和底部控制条 / 右侧按钮错位。 */
    bottom: MotionValue<number>;
    isDaylight: boolean;
};

const hostOf = (location: string): string => {
    try {
        return new URL(location).host;
    } catch {
        return location;
    }
};

const LanCastControl: React.FC<LanCastControlProps> = ({ hidden, bottom, isDaylight }) => {
    const { t } = useTranslation();
    const [open, setOpen] = React.useState(false);
    const [devices, setDevices] = React.useState<LanSpeaker[]>([]);
    const [scanning, setScanning] = React.useState(false);
    const [castingUrl, setCastingUrl] = React.useState<string | null>(null);
    const [active, setActive] = React.useState<LanSpeaker | null>(null);
    const [error, setError] = React.useState('');
    const [notice, setNotice] = React.useState('');
    const panelBottom = useTransform(bottom, value => value + 64);

    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const song = usePlaybackStore(selectDisplaySong);
    const coverUrl = usePlaybackStore(selectDisplayCoverUrl);
    const available = isLanCastAvailable();

    const scan = React.useCallback(async () => {
        setScanning(true);
        setError('');
        setNotice('');
        try {
            const found = await discoverLanSpeakers();
            setDevices(found);
            if (found.length === 0) setNotice(t('lanCastNoDevice'));
        } catch (scanError) {
            setError(lanCastErrorText(scanError));
        } finally {
            setScanning(false);
        }
    }, [t]);

    // 每次打开面板都重新搜一遍：音响可能刚上电，缓存的旧列表意义不大。
    React.useEffect(() => {
        if (open && available) void scan();
        if (!open) setError('');
    }, [open, available, scan]);

    const castTo = async (device: LanSpeaker) => {
        setCastingUrl(device.controlUrl);
        setError('');
        setNotice('');
        try {
            await castTrackToSpeaker(device, {
                url: audioSrc ?? '',
                title: song?.name ?? '',
                artist: getSongArtistLabel(song),
                album: song?.album?.name ?? '',
                coverUrl: coverUrl ?? '',
                durationMs: song?.durationMs ?? 0,
            });
            setActive(device);
            setNotice(t('lanCastPlaying', { name: device.name }));
        } catch (castError) {
            setError(lanCastErrorText(castError));
        } finally {
            setCastingUrl(null);
        }
    };

    const stop = async () => {
        setError('');
        try {
            await stopCastingToSpeaker(active);
            setActive(null);
            setNotice('');
        } catch (stopError) {
            setError(lanCastErrorText(stopError));
        }
    };

    if (!available) return null;

    const glass = isDaylight
        ? 'border-black/10 bg-white/85 text-zinc-900'
        : 'border-white/10 bg-black/70 text-white';
    const soft = isDaylight ? 'text-zinc-500' : 'text-white/55';
    const row = isDaylight ? 'hover:bg-black/5 border-black/5' : 'hover:bg-white/10 border-white/10';

    return (
        <>
            <AnimatePresence>
                {!hidden && (
                    <motion.div
                        initial={{ opacity: 0, x: 20, y: 12, scale: 0.92 }}
                        animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
                        exit={{ opacity: 0, x: 20, y: 12, scale: 0.92 }}
                        transition={{ duration: 0.24, ease: 'easeOut' }}
                        style={{ bottom }}
                        data-folia-safe-bottom="shift"
                        className="pointer-events-auto fixed right-[72px] z-[60] md:right-[88px]"
                    >
                        <Button
                            tip={t('lanCastTitle')}
                            aria-label={t('lanCastTitle')}
                            onClick={() => setOpen(value => !value)}
                            className={`flex h-12 w-12 items-center justify-center rounded-full border shadow-lg backdrop-blur-md transition-transform hover:scale-105 ${
                                active ? 'border-emerald-400/40 bg-emerald-500/25 text-emerald-300' : glass
                            }`}
                        >
                            <Cast size={20} />
                        </Button>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: 12, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 12, scale: 0.97 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        style={{ bottom: panelBottom }}
                        className={`pointer-events-auto fixed right-4 z-[70] flex max-h-[min(60vh,30rem)] w-[min(22rem,calc(100vw-2rem))] flex-col gap-3 rounded-2xl border p-4 shadow-2xl backdrop-blur-xl md:right-8 ${glass}`}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                                <div className="truncate text-sm font-semibold">{t('lanCastTitle')}</div>
                                <div className={`truncate text-xs ${soft}`}>{t('lanCastHint')}</div>
                            </div>
                            <Button
                                tip={t('lanCastClose')}
                                onClick={() => setOpen(false)}
                                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${row}`}
                            >
                                <X size={16} />
                            </Button>
                        </div>

                        <div className={`truncate text-xs ${soft}`}>
                            {song ? `${song.name} · ${getSongArtistLabel(song)}` : t('lanCastNoTrack')}
                        </div>

                        {error && (
                            <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                                {error}
                            </div>
                        )}
                        {notice && !error && (
                            <div className={`rounded-lg border px-3 py-2 text-xs ${row}`}>{notice}</div>
                        )}

                        <div className="flex items-center justify-between gap-2">
                            <span className={`text-xs ${soft}`}>
                                {scanning ? t('lanCastScanning') : t('lanCastDevices', { count: devices.length })}
                            </span>
                            <Button
                                onClick={() => void scan()}
                                disabled={scanning}
                                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${row} ${scanning ? 'opacity-50' : ''}`}
                            >
                                {scanning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                                {t('lanCastRescan')}
                            </Button>
                        </div>

                        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
                            {devices.map(device => {
                                const busy = castingUrl === device.controlUrl;
                                const isActive = active?.controlUrl === device.controlUrl;
                                return (
                                    <Button
                                        key={device.id || device.controlUrl}
                                        onClick={() => void castTo(device)}
                                        disabled={Boolean(castingUrl)}
                                        className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left ${row} ${isActive ? 'ring-1 ring-emerald-400/60' : ''}`}
                                    >
                                        {busy
                                            ? <Loader2 size={18} className="shrink-0 animate-spin" />
                                            : <Speaker size={18} className="shrink-0" />}
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm">{device.name}</span>
                                            <span className={`block truncate text-[11px] ${soft}`}>
                                                {[device.manufacturer, hostOf(device.location)].filter(Boolean).join(' · ')}
                                            </span>
                                        </span>
                                    </Button>
                                );
                            })}
                        </div>

                        {active && (
                            <div className={`text-[11px] leading-snug ${soft}`}>{t('lanCastLocalHint')}</div>
                        )}

                        {active && (
                            <Button
                                onClick={() => void stop()}
                                className="flex items-center justify-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
                            >
                                <Square size={13} />
                                {t('lanCastStop')}
                            </Button>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
};

export default LanCastControl;
