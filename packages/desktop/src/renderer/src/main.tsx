import React from 'react';
import ReactDOM from 'react-dom/client';
import './lib/i18n';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { ensureProvider } from './provider';
import { useSessionsStore } from './stores/sessions';
import { useChatStore } from './stores/chat';
import { usePermissionsStore } from './stores/permissions';
import { useQuestionsStore } from './stores/questions';
import { useTodosStore } from './stores/todos';
import { useSettingsStore } from './stores/settings';
import './styles/globals.css';

ensureProvider();
useSessionsStore.getState().attachEvents();
useChatStore.getState().attachEvents();
usePermissionsStore.getState().attachEvents();
useQuestionsStore.getState().attachEvents();
useTodosStore.getState().attachEvents();
void useSessionsStore.getState().init();
void useSettingsStore.getState().load();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
