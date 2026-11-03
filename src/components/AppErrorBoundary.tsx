import React from 'react';
import { reportCrash } from '../utils/crashGuard';

// src/components/AppErrorBoundary.tsx
// 最外层的渲染兜底。没有它的话，App 里任何一个 effect / 渲染期异常都会让 React
// 卸载整棵树：用户看到的是首屏遮罩淡出后的一片黑，且没有任何错误信息。

interface Props {
    children: React.ReactNode;
}

interface State {
    failed: boolean;
}

class AppErrorBoundary extends React.Component<Props, State> {
    state: State = { failed: false };

    static getDerivedStateFromError(): State {
        return { failed: true };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo): void {
        reportCrash(
            '界面渲染失败',
            `${error.message}\n${error.stack ?? ''}\n\n组件栈：\n${info.componentStack ?? ''}`.trim(),
        );
    }

    render(): React.ReactNode {
        // 画面已经交给 crashGuard 的面板，这里不再渲染半截界面。
        return this.state.failed ? null : this.props.children;
    }
}

export default AppErrorBoundary;
