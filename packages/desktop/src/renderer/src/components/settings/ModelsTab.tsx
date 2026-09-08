import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { CAPABILITIES, resolveProfileMeta, type Capability, type MMFeature, type ModelConfig, type ProviderConfig } from '@czagent/core';
import { useSettingsStore } from '../../stores/settings';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import { Switch } from '../ui/switch';
import { Badge } from '../ui/badge';
import { Field, NumInput, ProviderBadge, Section, TextInput } from './fields';

const CAP_LABEL: Record<Capability, string> = {
  chat: 'Chat',
  embedding: 'Embedding',
  rerank: 'Rerank',
  'image-understanding': 'Image Understanding',
  'video-understanding': 'Video Understanding',
  tts: 'TTS',
  asr: 'ASR',
  'image-generation': 'Image Gen',
  'video-generation': 'Video Gen',
  fim: 'FIM',
};

/** 能力绑定 → 多模态特性键（仅多模态能力有接口实现概念；chat/理解类不显示徽标） */
const BINDING_FEATURE: Partial<Record<Capability, MMFeature>> = {
  embedding: 'embed',
  rerank: 'rerank',
  'image-generation': 'image-generate',
  'video-generation': 'video-generate',
  tts: 'tts',
  asr: 'asr',
};

/** 绑定行接口实现徽标：显示该模型将使用的 profile（特定实现 / 兼容兜底 / 不支持） */
function ImplBadge({ capability, modelId }: { capability: Capability; modelId: string }) {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const feature = BINDING_FEATURE[capability];
  if (!feature || !modelId) return null;
  const model = settings.models.find((m) => m.id === modelId);
  const provider = settings.providers.find((p) => p.id === model?.provider);
  if (!model || !provider) return null;
  try {
    const meta = resolveProfileMeta(
      { providerId: provider.id, model: model.id, ...(provider.apiStyle ? { apiStyle: provider.apiStyle } : {}) },
      feature,
    );
    const kindLabel = meta.kind === 'specific' ? t('settings.models.implSpecific') : t('settings.models.implDefault');
    return (
      <Badge variant="outline" className="mt-1 max-w-full" title={`${t('settings.models.implTitle')}: ${meta.profile.describe}（${kindLabel}）`}>
        <span className="truncate">
          {meta.profile.describe} · {kindLabel}
        </span>
      </Badge>
    );
  } catch {
    return (
      <Badge variant="destructive" className="mt-1">
        {t('settings.models.implUnsupported')}
      </Badge>
    );
  }
}

function ProviderRow({ provider }: { provider: ProviderConfig }) {
  const { t } = useTranslation();
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const removeProvider = useSettingsStore((s) => s.removeProvider);
  const [showKey, setShowKey] = useState(false);

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{provider.name}</span>
        <ProviderBadge kind={provider.kind} />
        <span className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('settings.models.enabled')}</span>
          <Switch checked={provider.enabled} onCheckedChange={(v) => void updateProvider(provider.id, { enabled: v })} />
          {provider.kind === 'compatible' && (
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => void removeProvider(provider.id)}>
              <Trash2 size={13} />
            </Button>
          )}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('settings.models.providerName')}>
          <TextInput value={provider.name} onChange={(e) => void updateProvider(provider.id, { name: e.target.value })} />
        </Field>
        <Field label={t('settings.models.baseUrl')}>
          <TextInput value={provider.baseUrl} onChange={(e) => void updateProvider(provider.id, { baseUrl: e.target.value })} />
        </Field>
      </div>
      <Field label={t('settings.models.apiKey')}>
        <div className="flex gap-1.5">
          <TextInput
            type={showKey ? 'text' : 'password'}
            value={provider.apiKey}
            placeholder="sk-..."
            onChange={(e) => void updateProvider(provider.id, { apiKey: e.target.value })}
          />
          <Button variant="outline" size="icon" onClick={() => setShowKey((v) => !v)}>
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </Button>
        </div>
      </Field>
      <Field label={t('settings.models.apiStyle')} hint={t('settings.models.apiStyleHint')}>
        <Select
          value={provider.apiStyle ?? ''}
          onChange={(e) => void updateProvider(provider.id, { apiStyle: (e.target.value || undefined) as 'openai' | 'agnes' | undefined })}
        >
          <option value="">{t('settings.models.apiStyleAuto')}</option>
          <option value="openai">{t('settings.models.apiStyleOpenai')}</option>
          <option value="agnes">Agnes</option>
        </Select>
      </Field>
    </div>
  );
}

function ModelRow({ model }: { model: ModelConfig }) {
  const { t } = useTranslation();
  const updateModel = useSettingsStore((s) => s.updateModel);
  const removeModel = useSettingsStore((s) => s.removeModel);

  return (
    <div className="grid grid-cols-12 items-center gap-2 rounded-md border border-border p-2">
      <div className="col-span-2">
        <TextInput className="text-xs" value={model.id} onChange={(e) => void updateModel(model.id, { id: e.target.value })} />
      </div>
      <div className="col-span-2">
        <TextInput className="text-xs" value={model.name} onChange={(e) => void updateModel(model.id, { name: e.target.value })} />
      </div>
      <div className="col-span-2">
        <Select className="text-xs" value={model.capability} onChange={(e) => {
          const cap = e.target.value as Capability;
          // 工具/视觉仅 chat 模型有意义：切换能力时自动修正（切回 chat 默认开启，可再手动关闭）
          const patch: Partial<ModelConfig> = { capability: cap };
          if (cap === 'chat') {
            if (model.toolcall === false) patch.toolcall = true;
            if (model.vision === false) patch.vision = true;
          } else {
            patch.toolcall = false;
            patch.vision = false;
          }
          void updateModel(model.id, patch);
        }}>
          {CAPABILITIES.map((c) => (
            <option key={c} value={c}>
              {CAP_LABEL[c]}
            </option>
          ))}
        </Select>
      </div>
      <div className="col-span-1">
        <NumInput className="text-xs" value={model.contextLimit} placeholder="0=未知" title="上下文窗口（0 = 未知/不限制）" onChange={(e) => void updateModel(model.id, { contextLimit: Number(e.target.value) || 0 })} />
      </div>
      <div className="col-span-1">
        <NumInput className="text-xs" value={model.maxOutput} placeholder="0=未知" title="最大输出（0 = 未知/不限制）" onChange={(e) => void updateModel(model.id, { maxOutput: Number(e.target.value) || 0 })} />
      </div>
      <div className="col-span-1 flex justify-center">
        <Switch checked={model.enabled} onCheckedChange={(v) => void updateModel(model.id, { enabled: v })} />
      </div>
      <div className="col-span-1 flex justify-center" title="支持工具调用（function-call）">
        {model.capability === 'chat' ? (
          <Switch checked={model.toolcall !== false} onCheckedChange={(v) => void updateModel(model.id, { toolcall: v })} />
        ) : (
          <span className="text-xs text-muted-foreground/50">—</span>
        )}
      </div>
      <div className="col-span-1 flex justify-center" title="支持视觉输入（图片内联）">
        {model.capability === 'chat' ? (
          <Switch checked={model.vision !== false} onCheckedChange={(v) => void updateModel(model.id, { vision: v })} />
        ) : (
          <span className="text-xs text-muted-foreground/50">—</span>
        )}
      </div>
      <div className="col-span-1 flex justify-center">
        {!model.builtin && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => void removeModel(model.id)}>
            <Trash2 size={13} />
          </Button>
        )}
      </div>
    </div>
  );
}

export function ModelsTab() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const addProvider = useSettingsStore((s) => s.addProvider);
  const addModel = useSettingsStore((s) => s.addModel);
  const updateBinding = useSettingsStore((s) => s.updateBinding);

  const modelsFor = (pid: string): ModelConfig[] => settings.models.filter((m) => m.provider === pid);
  const enabledFor = (cap: Capability): ModelConfig[] => settings.models.filter((m) => m.capability === cap && m.enabled);
  /** 能力绑定可选模型：image-understanding 从“启用且支持视觉”的模型中选，其余按能力过滤 */
  const bindingOptions = (cap: Capability): ModelConfig[] =>
    cap === 'image-understanding'
      ? settings.models.filter((m) => m.enabled && m.vision !== false)
      : enabledFor(cap);
  const providerName = (pid: string): string => settings.providers.find((p) => p.id === pid)?.name ?? pid;

  return (
    <div className="space-y-6">
      <Section
        title={t('settings.models.providers')}
        action={
          <Button size="sm" variant="outline" onClick={() => void addProvider({ name: '自定义 Provider', baseUrl: 'https://api.example.com/v1', apiKey: '', enabled: true, kind: 'compatible' })}>
            <Plus size={14} />
            {t('settings.models.addProvider')}
          </Button>
        }
      >
        {settings.providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('settings.models.empty')}</p>
        ) : (
          <div className="space-y-3">
            {settings.providers.map((p) => (
              <ProviderRow key={p.id} provider={p} />
            ))}
          </div>
        )}
      </Section>

      <Section title={t('settings.models.models')}>
        {settings.models.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('settings.models.empty')}</p>
        ) : (
          <div className="space-y-4">
            {settings.providers.map((p) => {
              const list = modelsFor(p.id);
              return (
                <div key={p.id} className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <span>{providerName(p.id)}</span>
                    <span className="text-[10px]">({list.length})</span>
                    <span className="ml-auto">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px]"
                        onClick={() =>
                          void addModel({ provider: p.id, name: '新模型', capability: 'chat', contextLimit: 0, maxOutput: 0, enabled: true })
                        }
                      >
                        <Plus size={12} />
                        {t('settings.models.addModel')}
                      </Button>
                    </span>
                  </div>
                  {list.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                      {t('settings.models.empty')} — 点击上方「添加模型」为该 Provider 添加模型
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-12 gap-2 px-0.5 text-[11px] text-muted-foreground">
                        <span className="col-span-2">ID</span>
                        <span className="col-span-2">名称</span>
                        <span className="col-span-2">能力</span>
                        <span className="col-span-1">ctx</span>
                        <span className="col-span-1">out</span>
                        <span className="col-span-1 text-center">启用</span>
                        <span className="col-span-1 text-center">工具</span>
                        <span className="col-span-1 text-center">视觉</span>
                        <span className="col-span-1" />
                      </div>
                      <div className="space-y-1.5">
                        {list.map((m, mi) => (
                          // key 不用 m.id：ID 输入逐键变更 id，key 随之变化会整行卸载导致输入失焦
                          <ModelRow key={`${p.id}-${mi}`} model={m} />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title={t('settings.models.bindings')}>
        <p className="mb-3 text-xs text-muted-foreground">{t('settings.models.bindingHint')}</p>
        <div className="grid grid-cols-2 gap-3">
          {settings.bindings.map((b) => (
            <Field key={b.capability} label={CAP_LABEL[b.capability]}>
              <Select value={b.modelId} onChange={(e) => void updateBinding(b.capability, e.target.value)}>
                <option value="">—</option>
                {bindingOptions(b.capability).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}（{m.id}）
                    {b.capability === 'image-understanding' && '·视觉'}
                  </option>
                ))}
              </Select>
              <ImplBadge capability={b.capability} modelId={b.modelId} />
            </Field>
          ))}
        </div>
      </Section>
    </div>
  );
}
