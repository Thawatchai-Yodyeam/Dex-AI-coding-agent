import { useState, useEffect, useRef } from 'react';
import type { AppSettings, AIProvider, PermissionRule, ReasoningEffort } from '../types/agent';
import { PERMISSION_TOOLS, PROVIDERS_CATALOG, REASONING_EFFORTS, defaultModelFor } from '../types/agent';
import { MultiProviderAgentService } from '../services/agent';
import { tauriBridge } from '../services/tauriBridge';

const LOCAL_STORAGE_KEY = 'dex_agent_settings_v2';

const EMPTY_KEYS: Record<AIProvider, string> = {
  google: '',
  anthropic: '',
  openai: '',
  deepseek: '',
  qwen: '',
};

const DEFAULT_SETTINGS: AppSettings = {
  provider: 'google',
  model: defaultModelFor('google'),
  reasoningEffort: 'medium',
  language: 'th',
  autoPilot: true,
  // ว่างไว้ แล้วให้ get_initial_env เติม cwd จริงของเครื่อง
  cwd: '',
  apiKeys: { ...EMPTY_KEYS },
  permissionRules: [],
};

/** กรองกฎที่เสียหาย/รูปแบบเก่าทิ้ง */
function sanitizeRules(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is PermissionRule =>
      !!r &&
      typeof r.id === 'string' &&
      (r.action === 'allow' || r.action === 'deny') &&
      PERMISSION_TOOLS.includes(r.tool) &&
      typeof r.pattern === 'string' &&
      r.pattern.trim() !== ''
  );
}

function loadSettings(): AppSettings {
  try {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!saved) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(saved) as Partial<AppSettings>;
    const provider: AIProvider = PROVIDERS_CATALOG.some((p) => p.id === parsed.provider)
      ? (parsed.provider as AIProvider)
      : 'google';
    const info = PROVIDERS_CATALOG.find((p) => p.id === provider)!;
    // โมเดลที่ไม่อยู่ใน catalog แล้ว (เช่น ID รุ่นเก่าที่ปลดระวาง) → กลับไปใช้ตัว default ของค่าย
    const model =
      parsed.model && info.models.some((m) => m.id === parsed.model) ? parsed.model : defaultModelFor(provider);

    const reasoningEffort = REASONING_EFFORTS.includes(parsed.reasoningEffort as ReasoningEffort)
      ? (parsed.reasoningEffort as ReasoningEffort)
      : DEFAULT_SETTINGS.reasoningEffort;
    // ตัดคีย์ของค่ายที่เลิกรองรับ และฟิลด์ custom provider เดิมทิ้ง
    const { customBaseUrl: _u, customModelName: _m, ...rest } = parsed as Partial<AppSettings> & {
      customBaseUrl?: string;
      customModelName?: string;
    };
    const apiKeys = { ...EMPTY_KEYS };
    for (const id of Object.keys(EMPTY_KEYS) as AIProvider[]) {
      const key = parsed.apiKeys?.[id];
      if (typeof key === 'string') apiKeys[id] = key;
    }

    return {
      ...DEFAULT_SETTINGS,
      ...rest,
      provider,
      model,
      reasoningEffort,
      language: parsed.language === 'en' ? 'en' : 'th',
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      apiKeys,
      permissionRules: sanitizeRules(parsed.permissionRules),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useAppSettings(): {
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  agentServiceRef: React.MutableRefObject<MultiProviderAgentService | null>;
  handleSelectWorkspace: () => Promise<void>;
} {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const agentServiceRef = useRef<MultiProviderAgentService | null>(null);
  if (agentServiceRef.current === null) {
    agentServiceRef.current = new MultiProviderAgentService(settings);
  }

  // คีย์ที่มาจาก .env — ใช้งานได้แต่จะไม่ถูกเขียนลง localStorage
  const envKeysRef = useRef<Partial<Record<AIProvider, string>>>({});

  // 1. โหลด CWD และ API Keys จาก .env
  useEffect(() => {
    tauriBridge.getInitialEnv().then((env) => {
      const envKeys: Partial<Record<AIProvider, string>> = { ...(env.keys as Record<AIProvider, string>) };
      if (env.apiKey && !envKeys.google) envKeys.google = env.apiKey;
      envKeysRef.current = envKeys;

      setSettings((prev) => {
        const apiKeys = { ...prev.apiKeys };
        for (const [provider, key] of Object.entries(envKeys) as [AIProvider, string][]) {
          // .env อาจมีคีย์ของค่ายที่ไม่รองรับแล้ว (XAI_API_KEY ฯลฯ) — ข้าม
          if (key && provider in EMPTY_KEYS && !apiKeys[provider]) apiKeys[provider] = key;
        }
        return { ...prev, cwd: prev.cwd || env.cwd, apiKeys };
      });
    });
  }, []);

  // 2. ซิงก์ settings เข้า agent และบันทึก (ไม่บันทึกคีย์ที่มาจาก .env)
  useEffect(() => {
    agentServiceRef.current?.updateSettings(settings);
    const apiKeys = { ...settings.apiKeys };
    for (const [provider, key] of Object.entries(envKeysRef.current) as [AIProvider, string][]) {
      if (apiKeys[provider] === key) apiKeys[provider] = '';
    }
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ ...settings, apiKeys }));
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  }, [settings]);

  const handleSelectWorkspace = async () => {
    const selected = await tauriBridge.selectFolder();
    if (selected) {
      setSettings((prev) => ({ ...prev, cwd: selected }));
    }
  };

  return { settings, setSettings, agentServiceRef, handleSelectWorkspace };
}
