import React from 'react';
import { translations } from '../utils/i18n';

interface Props {
  language: 'th' | 'en';
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/** กันไม่ให้ render error จุดเดียวทำแอปจอขาวทั้งหน้า */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('UI crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const t = translations[this.props.language];
    return (
      <div className="crash-screen" role="alert">
        <h1>{t.crashTitle}</h1>
        <pre>{this.state.error.message}</pre>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          {t.crashReload}
        </button>
      </div>
    );
  }
}
