import { create } from 'zustand';

// src/stores/useLxWorkspaceStore.ts
// 「洛雪工作台」的开合与当前页签。放在 store 里是因为入口在登录页（Library 那棵树），
// 而页面本身挂在应用级浮层上（那里才拿得到播放 / 加入队列的回调）。

export type LxWorkspaceTab = 'playlist' | 'radio' | 'album' | 'chart' | 'local' | 'search' | 'source';

type LxWorkspaceState = {
    isOpen: boolean;
    tab: LxWorkspaceTab;
    open: (tab?: LxWorkspaceTab) => void;
    close: () => void;
    setTab: (tab: LxWorkspaceTab) => void;
};

export const useLxWorkspaceStore = create<LxWorkspaceState>((set, get) => ({
    isOpen: false,
    tab: 'playlist',
    open: (tab) => set({ isOpen: true, tab: tab ?? get().tab }),
    close: () => set({ isOpen: false }),
    setTab: (tab) => set({ tab }),
}));
