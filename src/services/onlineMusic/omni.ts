import type {
    OmniCollection,
    OmniPage,
    OmniProviderId,
    OmniSearchKind,
    UnifiedSong,
} from '../../types/onlineMusic';
import {
    getOnlineMusicProvider,
    providerSupports,
    requireOnlineMusicProvider,
} from './providerRegistry';

import { bindOmniService } from './omni/serviceAccess';
import { accountMethods } from './omni/accountMethods';
import { catalogMethods } from './omni/catalogMethods';
import { libraryMethods } from './omni/libraryMethods';
import { lyricsMethods } from './omni/lyricsMethods';
import { mutationMethods } from './omni/mutationMethods';
import { playbackMethods } from './omni/playbackMethods';
import { providerMethods } from './omni/providerMethods';
import { rawMethods } from './omni/rawMethods';

// src/services/onlineMusic/omni.ts
// Online Music Network Interface (Omni) - a unified interface for interacting with multiple online music providers.
// The implementation lives in ./omni/, one module per capability group; this file only assembles the
// object every caller imports.

type PageInput = { limit: number; offset: number };

const emptyPage = <T>(offset: number): OmniPage<T> => ({ items: [], hasMore: false, nextOffset: offset });

// —— PR#975（液态玻璃版）新增的四个接口 ——
// 这几个方法在 PR 分支里直接写在单体 omni.ts 里，而 dev 早已把 omni 拆成 ./omni/ 下的模块。
// 合并时以 dev 的模块化实现为主体，这里把 PR 的增量单独并回来，避免整份回退。
const glassMethods = {
    // What the provider's search finds: songs wherever it searches, albums and playlists where it has
    // a search for them and also opens them. Empty for a provider that is not there or has no search.
    getProviderSearchKinds(providerId: OmniProviderId): OmniSearchKind[] {
        const provider = getOnlineMusicProvider(providerId);
        if (!provider || !providerSupports(provider, 'search') || !provider.search) return [];
        const search = provider.search;
        return [
            'song' as const,
            ...(search.searchAlbums && providerSupports(provider, 'albums') ? ['album' as const] : []),
            ...(search.searchPlaylists && providerSupports(provider, 'playlists') ? ['playlist' as const] : []),
        ];
    },

    // Albums or playlists found at one provider (`getProviderSearchKinds` says which it finds); an
    // empty page where it finds none of the kind.
    async searchProviderCollections(
        providerId: OmniProviderId,
        kind: Exclude<OmniSearchKind, 'song'>,
        query: string,
        page: PageInput,
    ): Promise<OmniPage<OmniCollection>> {
        if (!omni.getProviderSearchKinds(providerId).includes(kind)) return emptyPage(page.offset);
        const search = requireOnlineMusicProvider(providerId).search!;
        const found = kind === 'album'
            ? await search.searchAlbums!(query, page.limit, page.offset)
            : await search.searchPlaylists!(query, page.limit, page.offset);
        // A provider names its own collections: one that answers with another's would open nowhere.
        return { ...found, items: found.items.filter(collection => collection.providerId === providerId) };
    },

    // The provider's `explore.songsShownAs`, or null where it has none (see `OnlineExploreProvider`).
    exploreSongsShownAs(providerId: OmniProviderId): ((songs: UnifiedSong[]) => Promise<Map<string, UnifiedSong | null>>) | null {
        const explore = getOnlineMusicProvider(providerId)?.explore;
        return explore?.songsShownAs ? songs => explore.songsShownAs!(songs) : null;
    },

    // The i18n key of the notice for a preview clip of a provider's song (`OnlinePlaybackProvider.previewNoticeKey`).
    previewNoticeKey(providerId: OmniProviderId): string {
        return getOnlineMusicProvider(providerId)?.playback?.previewNoticeKey ?? 'status.songPreviewOnly';
    },
};

const omni = {
    ...providerMethods,
    ...libraryMethods,
    ...playbackMethods,
    ...lyricsMethods,
    ...catalogMethods,
    ...accountMethods,
    ...mutationMethods,
    ...rawMethods,
    ...glassMethods,
};

bindOmniService(omni);

export { omni };
export type OmniService = typeof omni;
export type { LikedListRead } from './omni/accountLikes';
// 原生补写的红心认领（useCapacitorPlaybackBridge）：值从拆出来的 accountLikes 带出来。
export { applyNativeLikeOverrides } from './omni/accountLikes';
export type { NativeLikeOverrideInput } from './omni/accountLikes';
