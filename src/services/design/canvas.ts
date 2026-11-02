import { browserPane, type DeviceEmulation } from '../browser/pane';
import { tauriBridge, type DesignInfo, type DesignVersion } from '../tauriBridge';

export type DesignDevice = 'desktop' | 'tablet' | 'mobile';

/** ความกว้าง/สูงของหน้าที่จำลอง (CSS px) */
export const DESIGN_DEVICES: Record<DesignDevice, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
};

export interface DesignCanvasState {
  /** pane กำลังแสดง canvas ของดีไซน์ ไม่ใช่เบราว์เซอร์ */
  active: boolean;
  /** โปรเจกต์ที่เปิดอยู่ — null = แกลเลอรี */
  project: DesignInfo | null;
  projects: DesignInfo[];
  versions: DesignVersion[];
  /** เวอร์ชันเก่าที่กำลังดู — null = สภาพล่าสุด */
  viewing: number | null;
  device: DesignDevice;
  /** URL ของหน้าที่เปิด (เปิดในเบราว์เซอร์ของระบบ) */
  url: string | null;
  error: string | null;
  /** ข้อความแจ้งผล เช่น export ไปที่ไหน */
  notice: string | null;
}

const OBSCURE_REASON = 'design-gallery';

/**
 * ตัวกลางของ Dex Design: หน้าดีไซน์เปิดใน webview ของ browser pane
 * agent จึงใช้ tool `browser` ตรวจงานตัวเองได้เลย ส่วน pane แค่สลับ toolbar และจำลองขนาดจอ
 */
class DesignCanvasController {
  private state: DesignCanvasState = {
    active: false,
    project: null,
    projects: [],
    versions: [],
    viewing: null,
    device: 'desktop',
    url: null,
    error: null,
    notice: null,
  };
  private listeners = new Set<() => void>();
  private workspace: string | undefined;
  /** origin + token ของโปรเจกต์ที่เปิด — ใช้ดูว่า pane ยังอยู่ที่หน้าดีไซน์ไหม */
  private base: string | null = null;
  private frame: { width: number; height: number } | null = null;
  private lastPaneUrl = '';

  constructor() {
    browserPane.subscribe(this.syncWithPane);
  }

  getState = (): DesignCanvasState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<DesignCanvasState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** agent พา pane ไปหน้าอื่น (เช่น dev server) — กลับเป็นเบราว์เซอร์ธรรมดา */
  private syncWithPane = () => {
    const url = browserPane.getState().url;
    if (url === this.lastPaneUrl) return;
    this.lastPaneUrl = url;
    if (this.state.active && this.base && url && url !== 'about:blank' && !url.startsWith(this.base)) this.exit();
  };

  /** โปรเจกต์อยู่ใน workspace — เปลี่ยน workspace แล้วของเดิมใช้ต่อไม่ได้ */
  setWorkspace(workspace: string) {
    if (this.workspace === workspace) return;
    const changed = this.workspace !== undefined;
    this.workspace = workspace;
    if (!changed) return;
    this.exit();
    this.base = null;
    this.set({ project: null, projects: [], versions: [], viewing: null, url: null });
  }

  /** ปุ่มดีไซน์บนแถบบน: กลับไปโปรเจกต์ที่เปิดค้างไว้ หรือเปิดแกลเลอรี */
  async show() {
    if (this.state.project) await this.open(this.state.project.id, { version: this.state.viewing ?? undefined });
    else await this.showGallery();
  }

  async showGallery() {
    this.base = null;
    browserPane.setObscured(true, OBSCURE_REASON);
    browserPane.setVisible(true);
    this.set({ active: true, project: null, versions: [], viewing: null, url: null, error: null, notice: null });
    try {
      this.set({ projects: await tauriBridge.designList(this.workspace) });
    } catch (err) {
      this.set({ error: errorText(err) });
    }
  }

  /** กลับเป็นเบราว์เซอร์ธรรมดา */
  exit() {
    browserPane.setObscured(false, OBSCURE_REASON);
    if (!this.state.active) return;
    this.set({ active: false, error: null, notice: null });
    void browserPane.setEmulation(null).catch(() => {});
  }

  /** เปิดหน้าดีไซน์ — ทำซ้ำได้ (เช่น หลัง agent แก้ไฟล์) คืนข้อความ error หรือ null */
  async open(id: string, options: { version?: number; page?: string } = {}): Promise<string | null> {
    browserPane.setVisible(true);
    try {
      const [projects, versions, url] = await Promise.all([
        tauriBridge.designList(this.workspace),
        tauriBridge.designVersions(this.workspace, id),
        tauriBridge.designPreviewUrl(this.workspace, id, options.version, options.page),
      ]);
      const parsed = new URL(url);
      this.base = `${parsed.origin}/${parsed.pathname.split('/')[1]}/`;
      browserPane.setObscured(false, OBSCURE_REASON);
      this.set({
        active: true,
        project: projects.find((p) => p.id === id) ?? null,
        projects,
        versions,
        viewing: options.version ?? null,
        url,
        error: null,
        notice: null,
      });
      const loadError = await browserPane.navigate(url);
      await this.applyDevice();
      if (loadError) this.set({ error: loadError });
      return loadError;
    } catch (err) {
      // ไม่มีหน้าให้แสดง (เช่น โปรเจกต์ใหม่ที่ยังไม่มีไฟล์) — อย่าให้หน้าเก่าของ pane โผล่มาแทน
      const message = errorText(err);
      browserPane.setObscured(true, OBSCURE_REASON);
      const projects = await tauriBridge.designList(this.workspace).catch(() => this.state.projects);
      const versions = await tauriBridge.designVersions(this.workspace, id).catch(() => []);
      this.set({
        active: true,
        project: projects.find((p) => p.id === id) ?? null,
        projects,
        versions,
        viewing: null,
        url: null,
        error: message,
        notice: null,
      });
      return message;
    }
  }

  async viewVersion(version: number | null) {
    const { project, versions } = this.state;
    if (!project) return;
    // เวอร์ชันล่าสุดตรงกับไฟล์ปัจจุบัน จึงเปิดจากไฟล์จริงแทนสำเนา
    const latest = versions[versions.length - 1]?.version;
    await this.open(project.id, { version: version === null || version === latest ? undefined : version });
  }

  async restoreViewing() {
    const { project, viewing } = this.state;
    if (!project || viewing === null) return;
    try {
      await tauriBridge.designRestore(this.workspace, project.id, viewing);
      await this.open(project.id);
    } catch (err) {
      this.set({ error: errorText(err) });
    }
  }

  async exportProject() {
    const { project } = this.state;
    if (!project) return;
    const folder = await tauriBridge.selectFolder();
    if (!folder) return;
    try {
      this.set({ notice: await tauriBridge.designExport(this.workspace, project.id, folder), error: null });
    } catch (err) {
      this.set({ error: errorText(err) });
    }
  }

  setDevice(device: DesignDevice) {
    this.set({ device });
    void this.applyDevice();
  }

  /** กรอบของจอจำลองใน pane (CSS px) เปลี่ยน */
  reportFrame(frame: { width: number; height: number }) {
    this.frame = frame;
    void this.applyDevice();
  }

  /** ให้หน้าเว็บคิดว่าจอกว้างเท่าอุปกรณ์ แล้วย่อภาพลงให้พอดีกรอบ */
  private async applyDevice() {
    if (!this.state.active || !this.state.url || !this.frame || !browserPane.getState().created) return;
    await browserPane.setEmulation(deviceMetrics(this.state.device, this.frame)).catch((err) => {
      console.warn('Could not emulate the device size:', err);
    });
  }
}

export function deviceMetrics(device: DesignDevice, frame: { width: number; height: number }): DeviceEmulation {
  const { width } = DESIGN_DEVICES[device];
  const scale = Math.min(1, frame.width / width);
  return {
    width,
    height: Math.max(1, Math.round(frame.height / scale)),
    deviceScaleFactor: 0,
    mobile: device !== 'desktop',
    scale,
  };
}

/** ขนาดกรอบของจอจำลองในพื้นที่ที่มี: กว้างเท่าอุปกรณ์เมื่อพอ ไม่งั้นเต็มพื้นที่ */
export function deviceFrame(device: DesignDevice, available: { width: number; height: number }) {
  return { width: Math.min(DESIGN_DEVICES[device].width, available.width), height: available.height };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const designCanvas = new DesignCanvasController();
