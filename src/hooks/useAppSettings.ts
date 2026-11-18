import { useState, useEffect, useRef } from 'react';
import type { AppSettings, AIProvider, PermissionRule, ReasoningEffort } from '../types/agent';
import { PERMISSION_TOOLS, PROVIDERS_CATALOG, REASONING_EFFORTS, defaultModelFor, modelsFor } from '../types/agent';
import { MultiProviderAgentService } from '../services/agent';
import { tauriBridge } from '../services/tauriBridge';
import { parseMcpConfig } from '../services/mcp/config';
import { mcpManager } from '../services/mcp/manager';

const LOCAL_STORAGE_KEY = 'dex_agent_settings_v2';
/** ภาพพื้นหลังเก็บแยก — ไม่ต้องเขียนรูปหลายร้อย KB ซ้ำทุกครั้งที่ settings อื่นเปลี่ยน */
const WALLPAPER_STORAGE_KEY = 'dex_agent_wallpaper_v1';

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function loadWallpaper(): string | undefined {
  try {
    const value = localStorage.getItem(WALLPAPER_STORAGE_KEY);
    // '' = ผู้ใช้ปิดภาพพื้นหลังเอง (ต่างจาก null ที่ยังไม่เคยเลือก → ใช้ภาพที่มากับแอป)
    return value === '' || value?.startsWith('preset:') || value?.startsWith('data:image/') ? value : undefined;
  } catch {
    return undefined;
  }
}

const EMPTY_KEYS: Record<AIProvider, string> = {
  google: '',
  anthropic: '',
  openai: '',
  deepseek: '',
  qwen: '',
  custom: '',
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
  wallpaperDim: 55,
  wallpaperBlur: 0,
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
    // ฟิลด์ customModelName ของเวอร์ชันเก่าย้ายมาเป็นรายการ customModels
    const { customModelName, ...rest } = parsed as Partial<AppSettings> & { customModelName?: string };
    const customModels =
      typeof parsed.customModels === 'string' ? parsed.customModels : typeof customModelName === 'string' ? customModelName : '';
    const custom = { customModels, customBaseUrl: typeof parsed.customBaseUrl === 'string' ? parsed.customBaseUrl : '' };
    // โมเดลที่ไม่อยู่ใน catalog แล้ว (เช่น ID รุ่นเก่าที่ปลดระวาง) → กลับไปใช้ตัว default ของค่าย
    const models = modelsFor(provider, custom);
    const model =
      parsed.model && models.some((m) => m.id === parsed.model)
        ? parsed.model
        : provider === 'custom'
          ? (models[0]?.id ?? '')
          : defaultModelFor(provider);

    const reasoningEffort = REASONING_EFFORTS.includes(parsed.reasoningEffort as ReasoningEffort)
      ? (parsed.reasoningEffort as ReasoningEffort)
      : DEFAULT_SETTINGS.reasoningEffort;
    const apiKeys = { ...EMPTY_KEYS };
    for (const id of Object.keys(EMPTY_KEYS) as AIProvider[]) {
      const key = parsed.apiKeys?.[id];
      if (typeof key === 'string') apiKeys[id] = key;
    }

    return {
      ...DEFAULT_SETTINGS,
      ...rest,
      ...custom,
      provider,
      model,
      reasoningEffort,
      language: parsed.language === 'en' ? 'en' : 'th',
      planMode: parsed.planMode === true,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      apiKeys,
      permissionRules: sanitizeRules(parsed.permissionRules),
      wallpaper: loadWallpaper(),
      wallpaperDim: clampNumber(parsed.wallpaperDim, 0, 90, DEFAULT_SETTINGS.wallpaperDim!),
      wallpaperBlur: clampNumber(parsed.wallpaperBlur, 0, 20, DEFAULT_SETTINGS.wallpaperBlur!),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, wallpaper: loadWallpaper() };
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
    agentServiceRef.current.setMcpProvider(mcpManager);
  }
  // โหลด cwd/คีย์จากเครื่องเสร็จแล้ว — ก่อนหน้านั้นยังไม่เปิด MCP server (cwd อาจยังไม่ใช่ค่าจริง)
  const [envReady, setEnvReady] = useState(false);

  // คีย์ที่มาจาก .env — ใช้งานได้แต่จะไม่ถูกบันทึกที่ไหนเลย
  const envKeysRef = useRef<Partial<Record<AIProvider, string>>>({});
  // ที่เก็บคีย์: Credential Manager ของ Windows — ใช้ localStorage แบบเดิมเฉพาะเมื่อ keyring ใช้ไม่ได้
  // 'pending' = ยังโหลดไม่เสร็จ (ห้ามเขียนทับ keyring ด้วยค่าว่างตอนเปิดแอป)
  const keyStoreRef = useRef<'pending' | 'keyring' | 'local'>('pending');
  // ค่าที่อยู่ใน keyring ตอนนี้ — เขียนเฉพาะคีย์ที่เปลี่ยน
  const storedKeysRef = useRef<Partial<Record<AIProvider, string>>>({});

  // 1. โหลด CWD, คีย์จาก Credential Manager และคีย์จาก .env
  useEffect(() => {
    const providers = Object.keys(EMPTY_KEYS);
    Promise.all([
      tauriBridge.getInitialEnv(),
      tauriBridge.loadApiKeys(providers).catch((e) => {
        console.warn('Credential Manager unavailable, keeping API keys in localStorage:', e);
        return null;
      }),
    ]).then(([env, stored]) => {
      const envKeys: Partial<Record<AIProvider, string>> = { ...(env.keys as Record<AIProvider, string>) };
      if (env.apiKey && !envKeys.google) envKeys.google = env.apiKey;
      // ค่ายที่มีคีย์ใน keyring แล้วใช้คีย์นั้น — ไม่นับเป็นคีย์จาก .env (ไม่งั้นคีย์ที่ซ้ำกับ .env จะถูกลบจาก keyring)
      for (const provider of Object.keys(stored ?? {}) as AIProvider[]) delete envKeys[provider];
      envKeysRef.current = envKeys;
      keyStoreRef.current = stored ? 'keyring' : 'local';
      storedKeysRef.current = { ...(stored ?? {}) };

      setSettings((prev) => {
        // prev.apiKeys = คีย์เดิมใน localStorage (ก่อนย้ายไป keyring) — keyring ชนะถ้ามีทั้งคู่
        const apiKeys = { ...prev.apiKeys };
        for (const provider of providers as AIProvider[]) {
          if (stored?.[provider]) apiKeys[provider] = stored[provider];
        }
        for (const [provider, key] of Object.entries(envKeys) as [AIProvider, string][]) {
          // .env อาจมีคีย์ของค่ายที่ไม่รองรับแล้ว (XAI_API_KEY ฯลฯ) — ข้าม
          if (key && provider in EMPTY_KEYS && !apiKeys[provider]) apiKeys[provider] = key;
        }
        return { ...prev, cwd: prev.cwd || env.cwd, apiKeys };
      });
      setEnvReady(true);
    });
  }, []);

  // MCP server ตาม settings — server ที่ config ไม่เปลี่ยนจะไม่ถูกเปิดใหม่
  useEffect(() => {
    if (!envReady) return;
    mcpManager.sync(parseMcpConfig(settings.mcpConfig).servers, settings.cwd);
  }, [envReady, settings.mcpConfig, settings.cwd]);

  // 2. ซิงก์ settings เข้า agent และบันทึก (ไม่บันทึกคีย์ที่มาจาก .env)
  useEffect(() => {
    agentServiceRef.current?.updateSettings(settings);
    const apiKeys = { ...settings.apiKeys };
    for (const [provider, key] of Object.entries(envKeysRef.current) as [AIProvider, string][]) {
      if (apiKeys[provider] === key) apiKeys[provider] = '';
    }
    const store = keyStoreRef.current;
    if (store === 'keyring') {
      for (const [provider, key] of Object.entries(apiKeys) as [AIProvider, string][]) {
        if ((storedKeysRef.current[provider] ?? '') === key) continue;
        storedKeysRef.current[provider] = key;
        tauriBridge.saveApiKey(provider, key).catch((e) => console.error('Failed to save API key:', e));
      }
    }
    try {
      // keyring พร้อมแล้ว → ไม่มีคีย์ใน localStorage อีก (ครั้งแรกคือการย้ายคีย์เดิมออก)
      // ระหว่าง pending ยังเก็บคีย์เดิมไว้ เผื่อ keyring ใช้ไม่ได้
      const persisted = store === 'keyring' ? { ...EMPTY_KEYS } : apiKeys;
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ ...settings, wallpaper: undefined, apiKeys: persisted }));
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  }, [settings]);

  useEffect(() => {
    try {
      if (settings.wallpaper !== undefined) localStorage.setItem(WALLPAPER_STORAGE_KEY, settings.wallpaper);
      else localStorage.removeItem(WALLPAPER_STORAGE_KEY);
    } catch (e) {
      console.error('Failed to save wallpaper:', e);
    }
  }, [settings.wallpaper]);

  const handleSelectWorkspace = async () => {
    const selected = await tauriBridge.selectFolder();
    if (selected) {
      setSettings((prev) => ({ ...prev, cwd: selected }));
    }
  };

  return { settings, setSettings, agentServiceRef, handleSelectWorkspace };
}
