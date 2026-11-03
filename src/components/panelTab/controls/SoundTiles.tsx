import React from 'react';
import { Blend, Route, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { noteLoopButtonPress } from '../../../services/ponder/loopShuffleHint';
import { useAutomixSettingsStore } from '../../../stores/useAutomixSettingsStore';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';
import { openHifiSignalPath } from '../../hifi/hifiPanelStore';
import { signalPathTone, verdictLabel } from '../../hifi/hifiSignalText';
import { useHifiSignalPath } from '../../hifi/useHifiSignalPath';
import { loopModeIcon, loopModeLabelName } from '../../shared/loopModeDisplay';
import { QuickTile } from './QuickTile';

// src/components/panelTab/controls/SoundTiles.tsx
// 音量下面的三块：循环（名字就是当前状态）、智能过渡、音频效果器。
// 第三块上游按 issue #107 删过，窗口只剩命令面板能开 —— 装着 App 的人翻遍控制页也找不到，
// 现在挂回「音频过渡」这一排，跟它并排。
//
// 只在安卓原生运行时出现：那扇窗口的四页（均衡 / 压缩 / 混响 / 后置）每一档都跑在
// ExoPlayer 的 AudioProcessor 里，浏览器和桌面端没有那条链，点开只会是一扇不起作用的窗口。

const isAndroidNativeRuntime = (): boolean => (
    typeof window !== 'undefined'
    && (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android'
);

interface SoundTilesProps {
    loopMode: 'off' | 'all' | 'one' | 'shuffle';
    /** Receives the click so the handler can stop it from reaching the panel container. */
    onToggleLoop: (event?: React.MouseEvent) => void;
    loopToggleDisabled: boolean;
}

const SoundTiles: React.FC<SoundTilesProps> = ({ loopMode, onToggleLoop, loopToggleDisabled }) => {
    const { t } = useTranslation();
    const automixEnabled = useAutomixSettingsStore(state => state.automixEnabled);
    const toggleAutomix = useAutomixSettingsStore(state => state.handleToggleAutomix);
    // 不在 HiFi 路线上时为 null。HiFi 上智能过渡和效果器都被绕过，两块换成一块打开信号链路面板的格子。
    const hifiSignalPath = useHifiSignalPath();
    const LoopIcon = loopModeIcon(loopMode);
    const showConsole = isAndroidNativeRuntime();

    return (
        <div className={`mt-2 grid gap-2 ${showConsole ? 'grid-cols-3' : 'grid-cols-2'}`}>
            <QuickTile
                kind="toggle"
                icon={<LoopIcon size={18} />}
                iconKey={loopMode}
                label={t(`player.${loopModeLabelName(loopMode)}`)}
                lit={loopMode !== 'off'}
                disabled={loopToggleDisabled}
                onClick={(event) => {
                    onToggleLoop(event);
                    noteLoopButtonPress();
                }}
            />
            {hifiSignalPath ? (
                // QuickTile 不收 className：外面包一层占两列，grid 让里面那层撑满。
                <div className="col-span-2 grid min-w-0">
                    <QuickTile
                        kind="open"
                        icon={<Route size={18} />}
                        label={t('hifi.player.signalPathTile', { verdict: verdictLabel(hifiSignalPath.verdict, t) })}
                        lit={signalPathTone(hifiSignalPath) === 'accent'}
                        aria-haspopup="dialog"
                        onClick={openHifiSignalPath}
                    />
                </div>
            ) : (
                <>
                    <QuickTile
                        kind="toggle"
                        icon={<Blend size={18} />}
                        label={t('ui.automix')}
                        lit={automixEnabled}
                        onClick={() => toggleAutomix(!automixEnabled)}
                    />
                    <QuickTile
                        kind="open"
                        icon={<SlidersHorizontal size={18} />}
                        label={t('ui.equalizerTitle')}
                        lit={isEqualizerOn}
                        data-ponder="audio-equalizer"
                        onClick={openAudioEqualizer}
                    />
                </>
            )}
        </div>
    );
};

export default SoundTiles;
