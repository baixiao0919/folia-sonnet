// src/components/app/playback/pauseGuard.ts
// 「按了暂停，声音还在响」的兜底。
//
// 播放器里同时可能有不止一个发声的 <audio>：主元素、交叉淡入的尾元素、切换过程中另一副牌组的
// 元素。暂停走的是「淡出后 pause(audioRef)」，一旦那时的 audioRef 指向的不是正在响的那一个
// （淡入淡出中途、切歌瞬间、音源换地址重建元素），UI 已经显示暂停，声音却还在继续。
//
// 这里在暂停后补一枪：450ms 后如果界面仍然是「已暂停」，就把页面上所有还在出声的元素都按住。
// 只在暂停意图成立时动手，不会干扰正常播放。

import { PlayerState } from '../../../types';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';

/** 把所有还在出声的 <audio> 静音。返回按住了几个。 */
export const silenceUnpausedMediaElements = (except?: HTMLAudioElement | null): number => {
    if (typeof document === 'undefined') return 0;
    let silenced = 0;
    document.querySelectorAll('audio').forEach((element) => {
        if (element === except) return;
        if (element.paused || element.ended) return;
        try {
            element.pause();
            silenced += 1;
        } catch {
            // 元素已失效，忽略。
        }
    });
    return silenced;
};

/**
 * 暂停后布一枚「确认真的停了」的定时器。
 * 期间用户又点了播放（状态变回 PLAYING），这一枪就自动作废。
 */
export const armPauseGuard = (delayMs = 450): void => {
    if (typeof window === 'undefined') return;
    window.setTimeout(() => {
        if (usePlaybackStore.getState().playerState !== PlayerState.PAUSED) return;
        const silenced = silenceUnpausedMediaElements();
        if (silenced > 0) {
            console.warn(`[Playback] 暂停后仍有 ${silenced} 个媒体元素在响，已强制按住`);
        }
    }, delayMs);
};
