import * as React from 'react';
import { Button } from './components/ui/button';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[czagent] render error:', error, info);
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
          <h1 className="text-lg font-semibold">界面渲染出错</h1>
          <pre className="max-w-xl overflow-auto rounded-md bg-muted p-3 text-left text-xs text-destructive">
            {this.state.error.message}
            {this.state.error.stack ? `\n\n${this.state.error.stack}` : ''}
          </pre>
          <Button onClick={() => window.location.reload()}>重新加载</Button>
        </div>
      );
    }
    return this.props.children;
  }
}
