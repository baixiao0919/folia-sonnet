import React, { useEffect, useRef, useState } from 'react';
import { lxSourceStore } from '../../services/onlineMusic/lxmusic/lxSourceStore';
import { importLxSourceFromFile, importLxSourceFromUrl, type ImportResult } from '../../services/onlineMusic/lxmusic/lxImportService';
import type { LxSource } from '../../services/onlineMusic/lxmusic/lxTypes';
import { LX_PUBLIC_PLATFORMS } from '../../services/onlineMusic/lxmusic/lxPublicApi';

// src/components/lxmusic/LxSourcePanel.tsx
// 洛雪「音源」页：粘贴网址导入 / 选 .js·.json 文件导入，列出已导入的音源并启用、停用、删除。

const PLATFORM_LABELS: Record<string, string> = {
    wy: '网易云', kg: '酷狗', tx: 'QQ', kw: '酷我', mg: '咪咕', local: '本地',
};

type ImportTab = 'url' | 'file';

type LxSourcePanelProps = {
    /** 音源变动后回调（工作台用它刷新「能不能放」的提示）。 */
    onChanged?: () => void;
};

export const LxSourcePanel: React.FC<LxSourcePanelProps> = ({ onChanged }) => {
    const [tab, setTab] = useState<ImportTab>('url');
    const [url, setUrl] = useState('');
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    const [dragging, setDragging] = useState(false);
    const [sources, setSources] = useState<LxSource[]>(() => lxSourceStore.getSources());
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const unsubscribe = lxSourceStore.subscribe(() => {
            setSources([...lxSourceStore.getSources()]);
            onChanged?.();
        });
        setSources([...lxSourceStore.getSources()]);
        void lxSourceStore.init();
        return unsubscribe;
    }, [onChanged]);

    const report = (result: ImportResult) => {
        if (result.ok) {
            setFeedback({
                kind: 'ok',
                text: `已导入音源「${result.source.meta.name}」${result.source.error ? '（但脚本加载出错，见下方）' : ''}。`,
            });
        } else {
            setFeedback({ kind: 'err', text: result.error });
        }
    };

    const doImportUrl = async () => {
        if (!url.trim() || busy) return;
        setBusy(true);
        setFeedback(null);
        const result = await importLxSourceFromUrl(url.trim());
        report(result);
        setBusy(false);
    };

    const doImportFiles = async (files: FileList | File[]) => {
        setBusy(true);
        setFeedback(null);
        for (const file of Array.from(files)) {
            const result = await importLxSourceFromFile(file);
            report(result);
        }
        setBusy(false);
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="lx-notice">
                音源只负责「取播放地址与歌词」。搜索、歌单广场、榜单由洛雪内置的公开接口提供，不用导入也能看、能搜；
                网易云与酷狗的歌要有对应平台的音源才能出声，酷我有免费直链。
            </div>

            <div className="lx-chips">
                <button type="button" className="lx-chip" data-active={tab === 'url'} onClick={() => setTab('url')}>在线导入</button>
                <button type="button" className="lx-chip" data-active={tab === 'file'} onClick={() => setTab('file')}>本地文件</button>
            </div>

            {tab === 'url' ? (
                <div className="flex flex-col gap-2">
                    <div className="lx-search-row">
                        <input
                            className="lx-input"
                            value={url}
                            onChange={(event) => setUrl(event.target.value)}
                            onKeyDown={(event) => { if (event.key === 'Enter') void doImportUrl(); }}
                            placeholder="音源脚本地址，https://…/xxx.js"
                            inputMode="url"
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                        />
                        <button type="button" className="lx-btn" onClick={() => void doImportUrl()} disabled={busy || !url.trim()}>
                            {busy ? '导入中…' : '导入'}
                        </button>
                    </div>
                </div>
            ) : (
                <div
                    onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                        event.preventDefault();
                        setDragging(false);
                        if (event.dataTransfer.files.length) void doImportFiles(event.dataTransfer.files);
                    }}
                    className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-7 text-center ${dragging ? 'border-[var(--lx-accent)]' : 'border-[var(--lx-line)]'}`}
                >
                    <p className="text-xs text-[color:var(--lx-soft)]">把音源文件拖到这里，或</p>
                    <button type="button" className="lx-btn" onClick={() => fileInputRef.current?.click()}>选择 .js / .json 文件</button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".js,.json,application/javascript,application/json"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                            if (event.target.files?.length) void doImportFiles(event.target.files);
                            event.target.value = '';
                        }}
                    />
                    <p className="text-[11px] text-[color:var(--lx-faint)]">支持一次选多个文件</p>
                </div>
            )}

            {feedback && (
                <div
                    className="rounded-lg px-3 py-2 text-[11.5px] leading-5"
                    style={{
                        color: feedback.kind === 'ok' ? '#16a34a' : '#e11d48',
                        background: feedback.kind === 'ok' ? 'rgba(22,163,74,.1)' : 'rgba(225,29,72,.1)',
                    }}
                >
                    {feedback.text}
                </div>
            )}

            <div className="flex items-center gap-3 text-[11px] text-[color:var(--lx-faint)]">
                <span>播放覆盖：</span>
                {LX_PUBLIC_PLATFORMS.map((platform) => {
                    const ok = lxSourceStore.canResolve(platform.key, 'musicUrl') || platform.key === 'kw';
                    return (
                        <span key={platform.key} style={{ color: ok ? platform.color : undefined }}>
                            {platform.label}{ok ? ' ✓' : ' —'}
                        </span>
                    );
                })}
            </div>

            <div>
                <div className="mb-2 text-[11px] font-medium text-[color:var(--lx-faint)]">已导入音源（{sources.length}）</div>
                {sources.length === 0 ? (
                    <p className="lx-empty">还没有导入任何音源。</p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {sources.map((source) => (
                            <li key={source.id} className="rounded-xl border border-[var(--lx-line)] p-3">
                                <div className="flex items-start gap-3">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className="truncate text-[13px] font-semibold">{source.meta.name}</span>
                                            {source.meta.version && (
                                                <span className="rounded bg-[var(--lx-fill2)] px-1.5 text-[10px] text-[color:var(--lx-soft)]">
                                                    v{source.meta.version}
                                                </span>
                                            )}
                                        </div>
                                        {source.meta.author && (
                                            <p className="mt-0.5 truncate text-[11px] text-[color:var(--lx-faint)]">作者：{source.meta.author}</p>
                                        )}
                                        <div className="mt-1.5 flex flex-wrap gap-1">
                                            {Object.entries(source.sources).map(([key, info]) => (
                                                <span key={key} className="rounded bg-[var(--lx-fill2)] px-1.5 py-0.5 text-[10px] text-[color:var(--lx-soft)]">
                                                    {PLATFORM_LABELS[key] ?? key}
                                                    {info?.actions?.includes('musicUrl') ? ' · 播放' : ''}
                                                    {info?.actions?.includes('lyric') ? ' · 歌词' : ''}
                                                </span>
                                            ))}
                                            {source.error && (
                                                <span className="rounded bg-[#e11d48]/15 px-1.5 py-0.5 text-[10px] text-[#e11d48]">加载失败</span>
                                            )}
                                        </div>
                                        {source.error && (
                                            <p className="mt-1 break-all text-[10px] leading-4 text-[#e11d48]">{source.error}</p>
                                        )}
                                    </div>
                                    <div className="flex shrink-0 flex-col items-end gap-2">
                                        <label className="flex items-center gap-1.5 text-[11px] text-[color:var(--lx-soft)]">
                                            <input
                                                type="checkbox"
                                                checked={source.enabled}
                                                onChange={() => { void lxSourceStore.setEnabled(source.id, !source.enabled); }}
                                            />
                                            启用
                                        </label>
                                        <button
                                            type="button"
                                            onClick={() => { void lxSourceStore.removeSource(source.id); }}
                                            className="rounded px-2 py-1 text-[11px] text-[#e11d48] transition-colors hover:bg-[#e11d48]/10"
                                        >
                                            删除
                                        </button>
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <p className="text-[10.5px] leading-4 text-[color:var(--lx-faint)]">
                音源脚本在本应用内直接执行，与洛雪桌面端同一个信任模型：只导入你信得过的脚本。
            </p>

            <p className="text-[10px] leading-4 text-[color:var(--lx-faint)]">
                当前安装包 v{typeof __APP_VERSION__ === 'undefined' ? '?' : __APP_VERSION__}
                {typeof __COMMIT_HASH__ === 'undefined' ? '' : ` · 构建 ${__COMMIT_HASH__.slice(0, 7)}`}
            </p>
        </div>
    );
};

export default LxSourcePanel;
