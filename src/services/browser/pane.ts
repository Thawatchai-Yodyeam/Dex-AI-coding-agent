import { tauriBridge, type BrowserStateEvent, type PaneBounds } from '../tauriBridge';
import { PAGE_HOOK } from './pageScripts';

export interface BrowserPaneState {
  /** pane แสดงอยู่ใน layout */
  visible: boolean;
  /** สร้าง webview แล้ว (เคยเปิดหน้าเว็บ) */
  created: boolean;
  url: string;
  title: string;
  loading: boolean;
  /** เปิดหน้าไม่สำเร็จ (เช่น dev server ไม่ได้รัน) */
  error: string | null;
}

/** ค่าที่ส่งให้ Emulation.setDeviceMetricsOverride */
export interface DeviceEmulation {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  scale: number;
}

const VIEWPORT_TIMEOUT_MS = 5000;

/**
 * ตัวกลางของ browser pane: UI วาด pane และรายงานตำแหน่ง ส่วน agent/แถบ URL สั่งเปิดหน้าเว็บผ่านที่นี่
 * webview ของ pane เป็น native ที่ลอยทับหน้าแอป จึงต้องตามตำแหน่งของกรอบใน layout และซ่อนเมื่อมี modal ทับ
 */
class BrowserPaneController {
  private state: BrowserPaneState = { visible: false, created: false, url: '', title: '', loading: false, error: null };
  private listeners = new Set<() => void>();
  private viewport: PaneBounds | null = null;
  private waiters: ((bounds: PaneBounds) => void)[] = [];
  private obscuredBy = new Set<string>();
  /** ขนาดจอจำลองของ canvas ดีไซน์ — null = หน้าเว็บเต็ม webview ตามปกติ */
  private emulation: DeviceEmulation | null = null;

  getState = (): BrowserPaneState => this.state;

  /** ใช้กับ useSyncExternalStore */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<BrowserPaneState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** ปุ่มเปิด/ปิด pane — ปิดแล้วหน้าเว็บยังอยู่ (แค่ซ่อน) */
  setVisible(visible: boolean) {
    if (visible === this.state.visible) return;
    this.set({ visible });
    if (!visible) {
      this.viewport = null;
      if (this.state.created) void tauriBridge.browserSetVisible(false).catch(() => {});
    } else if (this.state.created) {
      void this.ensureOpen().catch(() => {});
    }
  }

  /** ให้หน้าเว็บคิดว่าจอกว้างเท่าอุปกรณ์ แล้วย่อภาพลงตาม scale (null = เลิกจำลอง) */
  async setEmulation(emulation: DeviceEmulation | null) {
    this.emulation = emulation;
    if (!this.state.created) return;
    if (emulation) await tauriBridge.browserCdp('Emulation.setDeviceMetricsOverride', { ...emulation });
    else await tauriBridge.browserCdp('Emulation.clearDeviceMetricsOverride');
  }

  /** input ของ DevTools ใช้พิกัดบนจอหลังย่อ ส่วนตำแหน่งในหน้าเว็บเป็นพิกัดก่อนย่อ */
  inputScale(): number {
    return this.emulation?.scale ?? 1;
  }

  /** ระหว่างถูกย่อ screenshot จะได้ภาพแค่มุมเดียวของหน้า จึงเลิกย่อชั่วคราว (ขนาดหน้าเท่าเดิม ไม่จัดวางใหม่) */
  async withoutPageScale<T>(run: () => Promise<T>): Promise<T> {
    const emulation = this.emulation;
    if (!emulation || emulation.scale === 1) return run();
    await tauriBridge.browserCdp('Emulation.setDeviceMetricsOverride', { ...emulation, scale: 1 });
    try {
      return await run();
    } finally {
      if (this.emulation) await tauriBridge.browserCdp('Emulation.setDeviceMetricsOverride', { ...this.emulation });
    }
  }

  /** กรอบของ pane ใน layout ย้าย/เปลี่ยนขนาด (null = กรอบหายไป) */
  reportViewport(bounds: PaneBounds | null) {
    this.viewport = bounds;
    if (!bounds) return;
    for (const resolve of this.waiters.splice(0)) resolve(bounds);
    if (this.state.created) void tauriBridge.browserSetBounds(bounds).catch(() => {});
  }

  /** มีของของแอปทับ pane (หน้าตั้งค่า, การลากขอบ, แกลเลอรีดีไซน์) — webview อยู่บนสุดเสมอ จึงต้องซ่อนชั่วคราว */
  setObscured(obscured: boolean, reason = 'modal') {
    if (obscured) this.obscuredBy.add(reason);
    else this.obscuredBy.delete(reason);
    if (this.state.created && this.state.visible) void tauriBridge.browserSetVisible(this.obscuredBy.size === 0).catch(() => {});
  }

  private waitForViewport(): Promise<PaneBounds> {
    if (this.viewport) return Promise.resolve(this.viewport);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The browser pane did not appear')), VIEWPORT_TIMEOUT_MS);
      this.waiters.push((bounds) => {
        clearTimeout(timer);
        resolve(bounds);
      });
    });
  }

  /** ให้ pane โผล่และมี webview พร้อมรับคำสั่ง */
  async ensureOpen(): Promise<void> {
    this.setVisible(true);
    const bounds = await this.waitForViewport();
    // ตัวเก็บ console/error ติดตั้งตอนสร้าง webview ให้ทำงานก่อนสคริปต์ของทุกหน้า
    await tauriBridge.browserOpen(bounds, PAGE_HOOK);
    if (!this.state.created) this.set({ created: true });
    if (this.obscuredBy.size > 0) await tauriBridge.browserSetVisible(false);
  }

  /** เปิด URL — คืนข้อความ error ของการโหลด (เช่น net::ERR_CONNECTION_REFUSED) หรือ null */
  async navigate(url: string): Promise<string | null> {
    this.set({ loading: true, error: null });
    try {
      await this.ensureOpen();
      const res = await tauriBridge.browserNavigate(url);
      const error = res.errorText || null;
      this.set({ error, ...(error ? { loading: false, url } : {}) });
      return error;
    } catch (err: any) {
      this.set({ loading: false, error: err?.message || String(err) });
      throw err;
    }
  }

  async goBack() {
    await this.stepHistory(-1);
  }

  async goForward() {
    await this.stepHistory(1);
  }

  async reload() {
    if (!this.state.created) return;
    this.set({ error: null });
    await tauriBridge.browserCdp('Page.reload', {});
  }

  private async stepHistory(delta: number) {
    if (!this.state.created) return;
    const history = await tauriBridge.browserCdp('Page.getNavigationHistory', {});
    const entry = history?.entries?.[history.currentIndex + delta];
    if (entry) await tauriBridge.browserCdp('Page.navigateToHistoryEntry', { entryId: entry.id });
  }

  /** event จากฝั่ง Rust: เริ่ม/จบการโหลด และชื่อหน้าเปลี่ยน */
  handleEvent = (event: BrowserStateEvent) => {
    this.set({
      ...(event.url !== undefined ? { url: event.url } : {}),
      ...(event.title !== undefined ? { title: event.title } : {}),
      ...(event.loading !== undefined ? { loading: event.loading } : {}),
      // หน้าใหม่เริ่มโหลด = error ของหน้าก่อนไม่เกี่ยวแล้ว
      ...(event.loading === true ? { error: null } : {}),
    });
  };
}

export const browserPane = new BrowserPaneController();
