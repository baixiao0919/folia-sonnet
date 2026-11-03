// src/components/lxmusic/LxSourceManagerDialog.tsx
// 洛雪音源管理 / 导入对话框。
// 两个入口：①「在线导入」粘贴音源网址；②「本地导入」选 .js / .json 文件（支持拖拽）。
// 下方列出已导入的音源，可启用 / 停用 / 删除。

import React, { useEffect, useRef, useState } from 'react';
import { lxSourceStore } from '../../services/onlineMusic/lxmusic/lxSourceStore';
import { importLxSourceFromFile, importLxSourceFromUrl, type ImportResult } from '../../services/onlineMusic/lxmusic/lxImportService';
import type { LxSource } from '../../services/onlineMusic/lxmusic/lxTypes';

const PLATFORM_LABELS: Record<string, string> = {
    wy: '网易云', kg: '酷狗', tx: 'QQ', kw: '酷我', mg: '咪咕', local: '本地',
};

type Tab = 'url' | 'file';

type LxSourceManagerDialogProps = {
    open: boolean;
    onClose: () => void;
};

export const LxSourceManagerDialog: React.FC<LxSourceManagerDialogProps> = ({ open, onClose }) => {
    const [tab, setTab] = useState<Tab>('url');
    const [url, setUrl] = useState('');
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    const [dragging, setDragging] = useState(false);
    const [sources, setSources] = useState<LxSource[]>(() => lxSourceStore.getSources());
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return undefined;
        const unsub = lxSourceStore.subscribe(() => setSources([...lxSourceStore.getSources()]));
        setSources([...lxSourceStore.getSources()]);
        void lxSourceStore.init();
        return unsub;
    }, [open]);

    if (!open) return null;

    const report = (result: ImportResult) => {
        if (result.ok) setFeedback({ kind: 'ok', text: `已导入音源「${result.source.meta.name}」${result.source.error ? '（但加载出错，见下方）' : ''}。` });
        else setFeedback({ kind: 'err', text: result.error });
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
        const list = Array.from(files);
        for (const file of list) {
            const result = await importLxSourceFromFile(file);
            report(result);
        }
        setBusy(false);
    };

    const toggleEnabled = (id: string, enabled: boolean) => { void lxSourceStore.setEnabled(id, !enabled); };
    const removeSource = (id: string) => { void lxSourceStore.removeSource(id); };

    return (
        <div
            className="fixed inset-0 z-[400] grid place-items-center bg-black/55 p-4"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
            role="dialog"
            aria-modal
        >
            <div className="flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl bg-[var(--st-win)] text-[color:var(--st-t1)] shadow-2xl">
                <div className="flex items-center justify-between border-b border-[var(--st-line)] px-5 py-4">
                    <h2 className="text-base font-semibold">洛雪音源</h2>
                    <button
                        onClick={onClose}
                        aria-label="关闭"
                        className="grid h-8 w-8 place-items-center rounded-full text-[color:var(--st-t3)] transition-colors hover:bg-[var(--st-fill)]"
                    >
                        ✕
                    </button>
                </div>

                <div className="flex gap-2 px-5 pt-4">
                    <button
                        onClick={() => setTab('url')}
                        className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${tab === 'url' ? 'bg-[var(--st-fill2)] font-medium' : 'text-[color:var(--st-t3)] hover:bg-[var(--st-fill)]'}`}
                    >
                        在线导入
                    </button>
                    <button
                        onClick={() => setTab('file')}
                        className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${tab === 'file' ? 'bg-[var(--st-fill2)] font-medium' : 'text-[color:var(--st-t3)] hover:bg-[var(--st-fill)]'}`}
                    >
                        本地导入
                    </button>
                </div>

                <div className="px-5 py-4">
                    {tab === 'url' ? (
                        <div className="flex flex-col gap-3">
                            <p className="text-xs text-[color:var(--st-t3)]">粘贴洛雪音源脚本的网址（以 http(s):// 开头），导入 .js 音源。</p>
                            <div className="flex gap-2">
                                <input
                                    value={url}
                                    onChange={(e) => setUrl(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') void doImportUrl(); }}
                                    placeholder="https://example.com/xxx.js"
                                    className="min-w-0 flex-1 rounded-lg border border-[var(--st-line2)] bg-[var(--st-fill)] px-3 py-2 text-sm outline-none focus:border-[var(--st-t2)]"
                                />
                                <button
                                    onClick={() => void doImportUrl()}
                                    disabled={busy || !url.trim()}
                                    className="shrink-0 rounded-lg bg-[#e11d48] px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-40"
                                >
                                    {busy ? '导入中…' : '导入'}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div
                            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void doImportFiles(e.dataTransfer.files); }}
                            className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${dragging ? 'border-[#e11d48] bg-[#e11d48]/5' : 'border-[var(--st-line2)]'}`}
                        >
                            <p className="text-sm text-[color:var(--st-t2)]">把音源文件拖到这里，或</p>
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="rounded-lg bg-[#e11d48] px-4 py-2 text-sm font-medium text-white"
                            >
                                选择 .js / .json 文件
                            </button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".js,.json,application/javascript,application/json"
                                multiple
                                className="hidden"
                                onChange={(e) => { if (e.target.files?.length) void doImportFiles(e.target.files); e.target.value = ''; }}
                            />
                            <p className="text-xs text-[color:var(--st-t3)]">支持一次选多个文件</p>
                        </div>
                    )}

                    {feedback && (
                        <div className={`mt-3 rounded-lg px-3 py-2 text-xs ${feedback.kind === 'ok' ? 'bg-[#16a34a]/10 text-[#16a34a]' : 'bg-[#e11d48]/10 text-[#e11d48]'}`}>
                            {feedback.text}
                        </div>
                    )}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--st-line)] px-5 py-3">
                    <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-medium text-[color:var(--st-t3)]">已导入音源（{sources.length}）</span>
                    </div>
                    {sources.length === 0 ? (
                        <p className="py-6 text-center text-xs text-[color:var(--st-t3)]">还没有导入任何音源。</p>
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {sources.map((src) => (
                                <li key={src.id} className="flex items-start gap-3 rounded-lg bg-[var(--st-fill)] p-3">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className="truncate text-sm font-medium">{src.meta.name}</span>
                                            {src.meta.version && <span className="rounded bg-[var(--st-fill2)] px-1.5 text-[10px] text-[color:var(--st-t3)]">v{src.meta.version}</span>}
                                        </div>
                                        {src.meta.author && <p className="truncate text-xs text-[color:var(--st-t3)]">作者：{src.meta.author}</p>}
                                        <div className="mt-1 flex flex-wrap gap-1">
                                            {Object.entries(src.sources).map(([key, info]) => (
                                                <span key={key} className="rounded bg-[var(--st-fill2)] px-1.5 py-0.5 text-[10px] text-[color:var(--st-t2)]">
                                                    {PLATFORM_LABELS[key] ?? key}{info?.actions.includes('musicUrl') ? '· 播放' : ''}
                                                </span>
                                            ))}
                                            {src.error && <span className="rounded bg-[#e11d48]/15 px-1.5 py-0.5 text-[10px] text-[#e11d48]">加载失败</span>}
                                        </div>
                                        {src.error && <p className="mt-1 text-[10px] text-[#e11d48]">{src.error}</p>}
                                    </div>
                                    <div className="flex shrink-0 flex-col items-end gap-2">
                                        <label className="flex items-center gap-1.5 text-xs text-[color:var(--st-t3)]">
                                            <input type="checkbox" checked={src.enabled} onChange={() => toggleEnabled(src.id, src.enabled)} />
                                            启用
                                        </label>
                                        <button
                                            onClick={() => removeSource(src.id)}
                                            className="rounded px-2 py-1 text-xs text-[#e11d48] transition-colors hover:bg-[#e11d48]/10"
                                        >
                                            删除
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="border-t border-[var(--st-line)] px-5 py-3">
                    <p className="text-[11px] leading-4 text-[color:var(--st-t3)]">
                        洛雪自定义音源只负责取播放地址与歌词；搜索与歌单复用本机自带的网易云 / 酷狗 / QQ。导入的音源脚本会在本应用内运行。
                    </p>
                </div>
            </div>
        </div>
    );
};

export default LxSourceManagerDialog;
