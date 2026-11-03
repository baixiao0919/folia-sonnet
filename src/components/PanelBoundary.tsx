import React from 'react';

// src/components/PanelBoundary.tsx
// 面板级的渲染兜底：某一条歌词样式（或某个背景、某个模组的）设置面板读到了不认识的字段、
// 或者存档是旧版本留下的半截对象时，只让这一块显示「这一块画不出来」，不再把整棵树连根拔掉。
// 最外层还有 AppErrorBoundary 兜底，但那是最后一道：它一接手就是整屏黑，所以能就地拦住就别往上抛。
//
// 这里的失败不报 crashGuard —— 那会弹整屏的「启动异常」面板，为一个设置区块不值得。

type PanelBoundaryProps = {
    /** 给日志与兜底文案看的：哪一块挂了。 */
    label: string;
    children: React.ReactNode;
};

type PanelBoundaryState = {
    failed: boolean;
    message: string;
};

class PanelBoundary extends React.Component<PanelBoundaryProps, PanelBoundaryState> {
    state: PanelBoundaryState = { failed: false, message: '' };

    static getDerivedStateFromError(error: unknown): PanelBoundaryState {
        const message = error instanceof Error ? error.message : String(error);
        return { failed: true, message };
    }

    componentDidCatch(error: unknown, info: React.ErrorInfo): void {
        console.error(`[PanelBoundary] ${this.props.label} 渲染失败`, error, info.componentStack);
    }

    private retry = () => this.setState({ failed: false, message: '' });

    render(): React.ReactNode {
        if (!this.state.failed) return this.props.children;
        return <PanelFallback label={this.props.label} message={this.state.message} onRetry={this.retry} />;
    }
}

const PanelFallback: React.FC<{ label: string; message: string; onRetry: () => void }> = ({ label, message, onRetry }) => (
    <div className="my-3 rounded-2xl border border-[color:var(--st-line)] bg-[color:var(--st-card)] px-4 py-5 text-center">
        <p className="text-[13px] text-[color:var(--st-t2)]">这一块没能画出来</p>
        <p className="mt-1 break-all text-[11px] leading-relaxed text-[color:var(--st-t3)]">{label}{message ? ` · ${message}` : ''}</p>
        <button
            type="button"
            onClick={onRetry}
            className="mt-3 rounded-full border border-[color:var(--st-line)] px-4 py-1.5 text-[12px] text-[color:var(--st-t2)]"
        >
            重试
        </button>
    </div>
);

export default PanelBoundary;
