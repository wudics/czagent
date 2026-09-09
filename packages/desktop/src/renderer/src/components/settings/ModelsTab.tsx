/** 模型设置页：对话模型 / 多模态与专用模型 / 能力默认绑定 三区。
 *  Provider 不再单独管理——接口实现（provider/版本粒度）是添加模型时的下拉选项（engines/catalog.ts 元数据），
 *  每个模型自持 API 地址 / Key / 模型名称。 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  CHAT_IMPL_META,
  MM_IMPL_META,
  MULTIMODAL_CAPABILITIES,
  implMetaOf,
  type Capability,
  type ChatModelConfig,
  type MultimodalCapability,
  type MultimodalModelConfig,
} from '@czagent/core';
import { useSettingsStore } from '../../stores/settings';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import { Switch } from '../ui/switch';
import { Badge } from '../ui/badge';
import { Field, NumInput, Section, TextInput } from './fields';

const CAP_LABEL: Record<Capability, string> = {
  chat: 'Chat',
  embedding: 'Embedding',
  rerank: 'Rerank',
  'image-understanding': 'Image Understanding',
  tts: 'TTS',
  asr: 'ASR',
  'image-generation': 'Image Gen',
  'video-generation': 'Video Gen',
};

const IMPL_DUMMY: void[] = [];

/** 某多模态能力可选的接口实现：图片理解 = chat 实现；其余 = 按能力过滤 */
function implOptionsFor(capability: MultimodalCapability) {
  if (capability === 'image-understanding') return CHAT_IMPL_META;
  return MM_IMPL_META.filter((m) => m.category === capability);
}

function implName(id: string): string {
  return implMetaOf(id)?.name ?? id;
}

// ---------- 对话模型 ----------

interface ChatDraft {
  implId: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  displayName: string;
  contextLimit: number;
  maxOutput: number;
  enabled: boolean;
  toolcall: boolean;
  vision: boolean;
}

function draftFromChatModel(m: ChatModelConfig): ChatDraft {
  return { ...m };
}

function newChatDraft(settings: { chatModels: ChatModelConfig[] }, implId: string): ChatDraft {
  const meta = implMetaOf(implId);
  // 预填：地址用目录默认值；同接口已有模型则复制其地址与 Key（免去重复填写）
  const sibling = settings.chatModels.find((m) => m.implId === implId);
  return {
    implId,
    baseUrl: sibling?.baseUrl || meta?.defaultBaseUrl || '',
    apiKey: sibling?.apiKey ?? '',
    modelName: '',
    displayName: '',
    contextLimit: 0,
    maxOutput: 0,
    enabled: true,
    toolcall: true,
    vision: true,
  };
}

function ChatModelDialog({
  editing,
  onClose,
}: {
  editing: ChatModelConfig | 'new' | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const addChatModel = useSettingsStore((s) => s.addChatModel);
  const updateChatModel = useSettingsStore((s) => s.updateChatModel);
  const updateBinding = useSettingsStore((s) => s.updateBinding);
  const isNew = editing === 'new';
  const [draft, setDraft] = useState<ChatDraft>(() =>
    editing && editing !== 'new' ? draftFromChatModel(editing) : newChatDraft(settings, 'deepseek'),
  );
  const [copiedHint, setCopiedHint] = useState(false);
  const patch = (p: Partial<ChatDraft>): void => setDraft((d) => ({ ...d, ...p }));

  const pickImpl = (implId: string): void => {
    const meta = implMetaOf(implId);
    const sibling = settings.chatModels.find((m) => m.implId === implId);
    patch({
      implId,
      baseUrl: sibling?.baseUrl || meta?.defaultBaseUrl || '',
      apiKey: sibling?.apiKey ?? '',
    });
    if (sibling && (sibling.apiKey || sibling.baseUrl)) setCopiedHint(true);
  };

  const save = async (): Promise<void> => {
    const value: Omit<ChatModelConfig, 'id'> = {
      displayName: draft.displayName.trim() || draft.modelName.trim() || implName(draft.implId),
      implId: draft.implId as ChatModelConfig['implId'],
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      modelName: draft.modelName.trim(),
      contextLimit: Number(draft.contextLimit) || 0,
      maxOutput: Number(draft.maxOutput) || 0,
      enabled: draft.enabled,
      toolcall: draft.toolcall,
      vision: draft.vision,
    };
    if (!value.modelName) return;
    if (isNew) {
      // 仅保存；默认绑定由用户在能力绑定区手动设置
      await addChatModel(value);
    } else if (editing) {
      await updateChatModel(editing.id, value);
    }
    onClose();
  };

  return (
    <div className="space-y-3">
      <Field label={t('settings.models.impl')} hint={t('settings.models.implHint')}>
        <Select value={draft.implId} onChange={(e) => pickImpl(e.target.value)}>
          {CHAT_IMPL_META.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </Field>
      {copiedHint && <p className="text-[11px] text-muted-foreground">{t('settings.models.copiedFromExisting')}</p>}
      <Field label={t('settings.models.baseUrl')}>
        <TextInput value={draft.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => patch({ baseUrl: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('settings.models.modelName')} hint={t('settings.models.modelNameHint')}>
          <TextInput value={draft.modelName} placeholder="deepseek-v4-pro" onChange={(e) => patch({ modelName: e.target.value })} />
        </Field>
        <Field label={t('settings.models.displayName')}>
          <TextInput value={draft.displayName} placeholder="DeepSeek V4 Pro" onChange={(e) => patch({ displayName: e.target.value })} />
        </Field>
      </div>
      <Field label={t('settings.models.apiKey')}>
        <TextInput type="password" value={draft.apiKey} placeholder="sk-..." onChange={(e) => patch({ apiKey: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('settings.models.contextLimit')}>
          <NumInput value={draft.contextLimit} placeholder="0=未知" onChange={(e) => patch({ contextLimit: Number(e.target.value) || 0 })} />
        </Field>
        <Field label={t('settings.models.maxOutput')}>
          <NumInput value={draft.maxOutput} placeholder="0=不限" onChange={(e) => patch({ maxOutput: Number(e.target.value) || 0 })} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-4 pt-1 text-sm">
        <label className="flex items-center gap-1.5">
          <Switch checked={draft.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
          {t('settings.models.enabled')}
        </label>
        <label className="flex items-center gap-1.5" title="支持 function-call">
          <Switch checked={draft.toolcall} onCheckedChange={(v) => patch({ toolcall: v })} />
          {t('settings.models.toolcall')}
        </label>
        <label className="flex items-center gap-1.5" title="支持图片内联">
          <Switch checked={draft.vision} onCheckedChange={(v) => patch({ vision: v })} />
          {t('settings.models.vision')}
        </label>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button disabled={!draft.modelName.trim()} onClick={() => void save()}>
          {t('settings.models.save')}
        </Button>
      </div>
    </div>
  );
}

// ---------- 多模态模型 ----------

interface MMDraft {
  capability: MultimodalCapability;
  implId: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  displayName: string;
  enabled: boolean;
}

function MmModelDialog({
  editing,
  onClose,
}: {
  editing: MultimodalModelConfig | 'new' | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const addMultimodalModel = useSettingsStore((s) => s.addMultimodalModel);
  const updateMultimodalModel = useSettingsStore((s) => s.updateMultimodalModel);
  const isNew = editing === 'new';
  const [draft, setDraft] = useState<MMDraft>(() =>
    editing && editing !== 'new'
      ? { ...editing }
      : { capability: 'image-generation', implId: 'agnes-image', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: '', modelName: '', displayName: '', enabled: true },
  );
  const patch = (p: Partial<MMDraft>): void => setDraft((d) => ({ ...d, ...p }));

  const pickCapability = (capability: MultimodalCapability): void => {
    const first = implOptionsFor(capability)[0];
    const meta = first ? implMetaOf(first.id) : undefined;
    const sibling = settings.multimodalModels.find((m) => m.capability === capability);
    patch({
      capability,
      implId: first?.id ?? '',
      baseUrl: sibling?.baseUrl || meta?.defaultBaseUrl || '',
      apiKey: sibling?.apiKey ?? '',
    });
  };

  const pickImpl = (implId: string): void => {
    const meta = implMetaOf(implId);
    const sibling = settings.multimodalModels.find((m) => m.implId === implId);
    patch({ implId, baseUrl: sibling?.baseUrl || meta?.defaultBaseUrl || '', apiKey: sibling?.apiKey ?? '' });
  };

  const save = async (): Promise<void> => {
    const value: Omit<MultimodalModelConfig, 'id'> = {
      displayName: draft.displayName.trim() || draft.modelName.trim() || implName(draft.implId),
      capability: draft.capability,
      implId: draft.implId as MultimodalModelConfig['implId'],
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      modelName: draft.modelName.trim(),
      enabled: draft.enabled,
    };
    if (!value.modelName || !value.implId) return;
    if (isNew) {
      await addMultimodalModel(value);
    } else if (editing) {
      await updateMultimodalModel(editing.id, value);
    }
    onClose();
  };

  return (
    <div className="space-y-3">
      <Field label={t('settings.models.capability')}>
        <Select value={draft.capability} onChange={(e) => pickCapability(e.target.value as MultimodalCapability)}>
          {MULTIMODAL_CAPABILITIES.map((c) => (
            <option key={c} value={c}>
              {CAP_LABEL[c]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('settings.models.impl')} hint={t('settings.models.implHint')}>
        <Select value={draft.implId} onChange={(e) => pickImpl(e.target.value)}>
          {implOptionsFor(draft.capability).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('settings.models.modelName')} hint={t('settings.models.modelNameHint')}>
          <TextInput value={draft.modelName} onChange={(e) => patch({ modelName: e.target.value })} />
        </Field>
        <Field label={t('settings.models.displayName')}>
          <TextInput value={draft.displayName} onChange={(e) => patch({ displayName: e.target.value })} />
        </Field>
      </div>
      <Field label={t('settings.models.baseUrl')}>
        <TextInput value={draft.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => patch({ baseUrl: e.target.value })} />
      </Field>
      <Field label={t('settings.models.apiKey')}>
        <TextInput type="password" value={draft.apiKey} placeholder="sk-..." onChange={(e) => patch({ apiKey: e.target.value })} />
      </Field>
      <label className="flex items-center gap-1.5 pt-1 text-sm">
        <Switch checked={draft.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
        {t('settings.models.enabled')}
      </label>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button disabled={!draft.modelName.trim() || !draft.implId} onClick={() => void save()}>
          {t('settings.models.save')}
        </Button>
      </div>
    </div>
  );
}

// ---------- 页面 ----------

type DialogState =
  | { kind: 'chat'; editing: ChatModelConfig | 'new' }
  | { kind: 'mm'; editing: MultimodalModelConfig | 'new' }
  | null;

export function ModelsTab() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const removeChatModel = useSettingsStore((s) => s.removeChatModel);
  const removeMultimodalModel = useSettingsStore((s) => s.removeMultimodalModel);
  const updateChatModel = useSettingsStore((s) => s.updateChatModel);
  const updateMultimodalModel = useSettingsStore((s) => s.updateMultimodalModel);
  const updateBinding = useSettingsStore((s) => s.updateBinding);
  const bindingOptionsFn = useSettingsStore((s) => s.bindingOptions);
  const modelByIdFn = useSettingsStore((s) => s.modelById);
  const [dialog, setDialog] = useState<DialogState>(null);

  const optionsFor = useMemo(
    () => (cap: Capability): (ChatModelConfig | MultimodalModelConfig)[] => bindingOptionsFn(cap),
    [bindingOptionsFn],
  );

  return (
    <div className="space-y-6">
      <Section
        title={t('settings.models.chatModels')}
        action={
          <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'chat', editing: 'new' })}>
            <Plus size={14} />
            {t('settings.models.addModel')}
          </Button>
        }
      >
        {settings.chatModels.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('settings.models.chatModelsEmpty')}</p>
        ) : (
          <div className="space-y-1.5">
            {settings.chatModels.map((m) => (
              <div key={m.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.displayName}</span>
                <Badge variant="outline" className="shrink-0">
                  {implName(m.implId)}
                </Badge>
                <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground md:block">{m.modelName}</span>
                <Switch checked={m.enabled} onCheckedChange={(v) => void updateChatModel(m.id, { enabled: v })} />
                <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" title={t('settings.models.editModel')} onClick={() => setDialog({ kind: 'chat', editing: m })}>
                  <Pencil size={13} />
                </Button>
                <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" title={t('settings.models.delete')} onClick={() => void removeChatModel(m.id)}>
                  <Trash2 size={13} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title={t('settings.models.multimodalModels')}
        action={
          <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'mm', editing: 'new' })}>
            <Plus size={14} />
            {t('settings.models.addModel')}
          </Button>
        }
      >
        {settings.multimodalModels.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('settings.models.multimodalEmpty')}</p>
        ) : (
          <div className="space-y-1.5">
            {settings.multimodalModels.map((m) => (
              <div key={m.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.displayName}</span>
                <Badge variant="outline" className="shrink-0">
                  {CAP_LABEL[m.capability]}
                </Badge>
                <Badge variant="secondary" className="hidden shrink-0 md:inline-flex">
                  {implName(m.implId)}
                </Badge>
                <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground md:block">{m.modelName}</span>
                <Switch checked={m.enabled} onCheckedChange={(v) => void updateMultimodalModel(m.id, { enabled: v })} />
                <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" title={t('settings.models.editModel')} onClick={() => setDialog({ kind: 'mm', editing: m })}>
                  <Pencil size={13} />
                </Button>
                <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" title={t('settings.models.delete')} onClick={() => void removeMultimodalModel(m.id)}>
                  <Trash2 size={13} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('settings.models.bindings')}>
        <p className="mb-3 text-xs text-muted-foreground">{t('settings.models.bindingHint')}</p>
        <div className="grid grid-cols-2 gap-3">
          {settings.bindings.map((b) => (
            <Field key={b.capability} label={CAP_LABEL[b.capability]}>
              <Select value={modelByIdFn(b.modelId) ? b.modelId : ''} onChange={(e) => void updateBinding(b.capability, e.target.value)}>
                <option value="">{t('settings.models.unbound')}</option>
                {optionsFor(b.capability).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
      </Section>

      {dialog?.kind === 'chat' && (
        <DialogShell title={dialog.editing === 'new' ? t('settings.models.addModel') : t('settings.models.editModel')} onClose={() => setDialog(null)}>
          <ChatModelDialog editing={dialog.editing} onClose={() => setDialog(null)} />
        </DialogShell>
      )}
      {dialog?.kind === 'mm' && (
        <DialogShell title={dialog.editing === 'new' ? t('settings.models.addModel') : t('settings.models.editModel')} onClose={() => setDialog(null)}>
          <MmModelDialog editing={dialog.editing} onClose={() => setDialog(null)} />
        </DialogShell>
      )}
    </div>
  );
}

/** 轻量弹窗壳（居中卡片 + 遮罩；点击遮罩关闭） */
function DialogShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-background p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-sm font-semibold">{title}</h3>
        {children}
      </div>
    </div>
  );
}
