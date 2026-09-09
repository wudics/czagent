import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe, Paperclip, Play, Send, Square } from 'lucide-react';
import { getProvider, implMetaOf, type ThinkingMode } from '@czagent/core';
import { useSessionsStore } from '../../stores/sessions';
import { useChatStore } from '../../stores/chat';
import { useSettingsStore } from '../../stores/settings';
import { MOCK_THINKING_MODES } from '../../mock/scenarios';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import { Switch } from '../ui/switch';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

interface PendingAttachment {
  id: string;
  name: string;
}

export function InputBar() {
  const { t } = useTranslation();
  const activeId = useSessionsStore((s) => s.activeId);
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const patch = useSessionsStore((s) => s.patch);
  const replying = session?.status === 'running' || session?.status === 'queued';
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  // selector 只选稳定引用（settings），派生数组在组件内 useMemo —— selector 内 filter 每次产生新引用会导致 useSyncExternalStore 无限重渲染
  const chatSettings = useSettingsStore((s) => s.settings);
  const chatModels = useMemo(() => chatSettings.chatModels.filter((m) => m.enabled), [chatSettings.chatModels]);
  // 会话模型解析回退链：会话自身 id → chat 绑定 → 第一个启用模型；'' = 未配置
  const resolveChatModelId = useSettingsStore((s) => s.resolveChatModelId);
  const resolvedModelId = resolveChatModelId(session?.modelId);

  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const isScript = session?.mode === 'script';
  const [entryPath, setEntryPath] = useState<string | null>(null);
  const webAccessOn = session?.webAccess ?? true;

  const cwd = session?.cwd;
  useEffect(() => {
    let alive = true;
    setEntryPath(null);
    if (!cwd) return;
    void window.czagent?.findEntryFile?.(cwd).then((p) => {
      if (alive) setEntryPath(p ?? null);
    });
    return () => {
      alive = false;
    };
  }, [cwd]);

  const entryName = entryPath ? entryPath.split(/[\\/]/).pop() : null;

  const submit = (): void => {
    if (!activeId || replying) return;
    if (isScript) {
      // 脚本会话（I14.1）：无输入框，点击即运行工作目录入口
      if (!entryPath) return;
      void send('', [], { allowEmpty: true });
      return;
    }
    if (!text.trim()) return;
    void send(text, attachments.map((a) => a.id));
    setText('');
    setAttachments([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length || !activeId) return;
    for (const f of files) {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        console.warn(`附件过大（${(f.size / 1024 / 1024).toFixed(1)}MB，上限 20MB）: ${f.name}`);
        continue;
      }
      try {
        const dataBase64 = await fileToBase64(f);
        const att = await getProvider().uploadAttachment(activeId, {
          name: f.name,
          mime: f.type,
          size: f.size,
          dataBase64,
        });
        setAttachments((a) => [...a, { id: att.id, name: att.name }]);
      } catch (err) {
        console.error('上传附件失败:', err);
      }
    }
  };

  return (
    <div className="border-t border-border p-3">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <span key={a.id} className="chip">
              <span>📎 {a.name}</span>
              <button
                className="ml-1 text-muted-foreground hover:text-foreground"
                onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                aria-label={t('common.close')}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 工具行：模型 + 思考模式（输入框上方；运行中切换下一轮生效） */}
      <div className="mb-2 flex items-center gap-2">
        <Select
          className="h-7 w-48"
          value={resolvedModelId}
          disabled={!session}
          aria-label={t('newSession.model')}
          title={t('newSession.model')}
          onChange={(e) => {
            if (activeId) void patch(activeId, { modelId: e.target.value });
          }}
        >
          {!resolvedModelId && <option value="">{t('settings.models.unbound')}</option>}
          {chatModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}（{implMetaOf(m.implId)?.name ?? m.implId}）
            </option>
          ))}
        </Select>
        <Select
          className="h-7 w-28"
          value={session?.thinkingMode ?? 'on'}
          disabled={!session}
          aria-label={t('newSession.thinking')}
          title={t('newSession.thinking')}
          onChange={(e) => {
            const v = e.target.value as ThinkingMode;
            if (activeId) void patch(activeId, { thinkingMode: v });
          }}
        >
          {MOCK_THINKING_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {t(`thinkingModes.${m.id}`)}
            </option>
          ))}
        </Select>

        {/* 联网开关（I16）：一键开/关 webfetch + websearch，运行中切换下一轮生效 */}
        <div className="ml-auto flex items-center gap-1.5" title={t('chat.webAccessTip')}>
          <Globe size={13} className={webAccessOn ? 'text-muted-foreground' : 'text-muted-foreground/40'} />
          <span className="text-xs text-muted-foreground">{t('chat.webAccess')}</span>
          <Switch
            checked={webAccessOn}
            disabled={!session}
            aria-label={t('chat.webAccess')}
            onCheckedChange={(v) => {
              if (activeId) void patch(activeId, { webAccess: v });
            }}
          />
        </div>
      </div>

      {isScript ? (
        /* 脚本会话（I14.1）：无输入框/附件，单行"运行入口"操作条 */
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {entryPath ? t('chat.scriptRunHint', { file: entryName ?? '' }) : t('chat.noEntryFile')}
          </span>
          {replying ? (
            <Button variant="destructive" size="icon" onClick={() => void stop()} aria-label={t('chat.stop')}>
              <Square size={14} />
            </Button>
          ) : (
            <Button size="sm" onClick={submit} disabled={!entryPath} title={t('chat.run')}>
              <Play size={13} className="mr-1" />
              {t('chat.run')}
            </Button>
          )}
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <textarea
            className="min-h-9 w-full flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring [field-sizing:content] max-h-[160px] overflow-y-auto"
            placeholder={t('chat.inputPlaceholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
          />

          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => void onPickFiles(e)} />
          <Button variant="ghost" size="icon" onClick={() => fileRef.current?.click()} aria-label={t('chat.attachments')}>
            <Paperclip size={16} />
          </Button>

          {replying ? (
            <Button variant="destructive" size="icon" onClick={() => void stop()} aria-label={t('chat.stop')}>
              <Square size={14} />
            </Button>
          ) : (
            <Button size="icon" onClick={submit} disabled={!text.trim()} aria-label={t('chat.send')}>
              <Send size={15} />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
