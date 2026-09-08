import { Sidebar } from './components/layout/Sidebar';
import { ChatArea } from './components/layout/ChatArea';
import { SessionHeader } from './components/layout/SessionHeader';
import { InputBar } from './components/layout/InputBar';
import { RightPanel } from './components/layout/RightPanel';
import { SettingsPage } from './components/settings/SettingsPage';
import { useUIStore } from './stores/ui';

export default function App() {
  const view = useUIStore((s) => s.view);

  if (view === 'settings') {
    return <SettingsPage />;
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <SessionHeader />
        <ChatArea />
        <InputBar />
      </main>
      <RightPanel />
    </div>
  );
}
