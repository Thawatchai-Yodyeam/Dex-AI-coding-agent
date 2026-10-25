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
  private obscured = false;

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
    }
  }

  /** กรอบของ pane ใน layout ย้าย/เปลี่ยนขนาด (null = กรอบหายไป) */
  reportViewport(bounds: PaneBounds | null) {
    this.viewport = bounds;
    if (!bounds) return;
    for (const resolve of this.waiters.splice(0)) resolve(bounds);
    if (this.state.created) void tauriBridge.browserSetBounds(bounds).catch(() => {});
  }

  /** modal ของแอป (เช่นหน้าตั้งค่า) ทับ pane — webview อยู่บนสุดเสมอ จึงต้องซ่อนชั่วคราว */
  setObscured(obscured: boolean) {
    this.obscured = obscured;
    if (this.state.created && this.state.visible) void tauriBridge.browserSetVisible(!obscured).catch(() => {});
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
    if (this.obscured) await tauriBridge.browserSetVisible(false);
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
