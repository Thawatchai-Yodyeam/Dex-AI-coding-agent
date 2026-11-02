import { browserPane, type DeviceEmulation } from '../browser/pane';
import { tauriBridge, type DesignInfo, type DesignVersion } from '../tauriBridge';
import { COMMENT_MODE_OFF, COMMENT_MODE_ON, READ_COMMENT_PICKS, setCommentPins } from './commentScripts';
import { commentsPrompt, loadComments, sanitizePick, saveComments, type DesignComment, type DesignPick } from './comments';

export type DesignDevice = 'desktop' | 'tablet' | 'mobile';

/** ความกว้าง/สูงของหน้าที่จำลอง (CSS px) */
export const DESIGN_DEVICES: Record<DesignDevice, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
};

const DEFAULT_PAGE = 'index.html';

export interface DesignCanvasState {
  /** pane กำลังแสดง canvas ของดีไซน์ ไม่ใช่เบราว์เซอร์ */
  active: boolean;
  /** โปรเจกต์ที่เปิดอยู่ — null = แกลเลอรี */
  project: DesignInfo | null;
  projects: DesignInfo[];
  versions: DesignVersion[];
  /** เวอร์ชันเก่าที่กำลังดู — null = สภาพล่าสุด */
  viewing: number | null;
  /** หน้าที่เปิดอยู่ และไฟล์ HTML ที่รากโปรเจกต์ (หลายหน้าเว็บ หรือหลายแบบให้เลือก) */
  page: string;
  pages: string[];
  /** กำลังเทียบทุกหน้าเคียงกัน */
  compare: boolean;
  device: DesignDevice;
  /** URL ของหน้าที่เปิด (เปิดในเบราว์เซอร์ของระบบ) */
  url: string | null;
  /** โหมดคอมเมนต์: คลิกบนหน้าเพื่อเลือกชิ้นส่วน ไม่ใช่กดปุ่มจริง */
  commenting: boolean;
  /** ชิ้นส่วนที่เพิ่งคลิก รอผู้ใช้พิมพ์คอมเมนต์ */
  draft: DesignPick | null;
  comments: DesignComment[];
  error: string | null;
  /** ข้อความแจ้งผล เช่น export ไปที่ไหน */
  notice: string | null;
}

const OBSCURE_REASON = 'design-gallery';
const COMMENT_POLL_MS = 250;

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
    page: DEFAULT_PAGE,
    pages: [],
    compare: false,
    device: 'desktop',
    url: null,
    commenting: false,
    draft: null,
    comments: [],
    error: null,
    notice: null,
  };
  private listeners = new Set<() => void>();
  private workspace: string | undefined;
  /** origin + token ของโปรเจกต์ที่เปิด — ใช้ดูว่า pane ยังอยู่ที่หน้าดีไซน์ไหม */
  private base: string | null = null;
  private frame: { width: number; height: number } | null = null;
  private lastPaneUrl = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

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
    this.set({ project: null, projects: [], versions: [], viewing: null, url: null, pages: [], page: DEFAULT_PAGE, compare: false, comments: [] });
  }

  /** ปุ่มดีไซน์บนแถบบน: กลับไปโปรเจกต์ที่เปิดค้างไว้ หรือเปิดแกลเลอรี */
  async show() {
    const { project, viewing, compare } = this.state;
    if (!project) return this.showGallery();
    await this.open(project.id, { version: viewing ?? undefined });
    if (compare) await this.setCompare(true);
  }

  async showGallery() {
    this.base = null;
    this.stopCommenting();
    browserPane.setObscured(true, OBSCURE_REASON);
    browserPane.setVisible(true);
    this.set({ active: true, project: null, versions: [], viewing: null, url: null, pages: [], compare: false, comments: [], error: null, notice: null });
    try {
      this.set({ projects: await tauriBridge.designList(this.workspace) });
    } catch (err) {
      this.set({ error: errorText(err) });
    }
  }

  /** กลับเป็นเบราว์เซอร์ธรรมดา */
  exit() {
    browserPane.setObscured(false, OBSCURE_REASON);
    this.stopCommenting();
    if (!this.state.active) return;
    this.set({ active: false, error: null, notice: null });
    void browserPane.setEmulation(null).catch(() => {});
  }

  /** ไฟล์ HTML ที่รากโปรเจกต์ โดย index.html ขึ้นก่อน */
  private async listPages(id: string): Promise<string[]> {
    const entries = await tauriBridge.listDir(`.dex/designs/${id}`, this.workspace);
    return entries
      .filter((e) => !e.is_dir && /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.html?$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => Number(b === DEFAULT_PAGE) - Number(a === DEFAULT_PAGE) || a.localeCompare(b));
  }

  /**
   * เปิดหน้าดีไซน์ — ทำซ้ำได้ (เช่น หลัง agent แก้ไฟล์) คืนข้อความ error หรือ null
   * ไม่ระบุหน้า = คงหน้าเดิมของโปรเจกต์นี้ไว้ ถ้ายังมีอยู่
   */
  async open(id: string, options: { version?: number; page?: string } = {}): Promise<string | null> {
    browserPane.setVisible(true);
    const sameProject = this.state.project?.id === id;
    try {
      const [projects, versions, pages, comments] = await Promise.all([
        tauriBridge.designList(this.workspace),
        tauriBridge.designVersions(this.workspace, id),
        this.listPages(id),
        loadComments(this.workspace, id),
      ]);
      const kept = sameProject && pages.includes(this.state.page) ? this.state.page : DEFAULT_PAGE;
      const page = options.page ?? kept;
      const url = await tauriBridge.designPreviewUrl(this.workspace, id, options.version, page).catch((err) => {
        // เวอร์ชันนี้ยังไม่มีไฟล์ของหน้าเดิม ก็ยังเปิดหน้าแรกของมันได้
        if (options.page || page === DEFAULT_PAGE) throw err;
        return tauriBridge.designPreviewUrl(this.workspace, id, options.version, DEFAULT_PAGE);
      });
      const parsed = new URL(url);
      this.base = `${parsed.origin}/${parsed.pathname.split('/')[1]}/`;
      browserPane.setObscured(false, OBSCURE_REASON);
      // คอมเมนต์ได้เฉพาะสภาพล่าสุดของโปรเจกต์เดิม
      if (!sameProject || options.version !== undefined) this.stopCommenting();
      this.set({
        active: true,
        project: projects.find((p) => p.id === id) ?? null,
        projects,
        versions,
        viewing: options.version ?? null,
        page: decodeURIComponent(parsed.pathname.split('/').pop() ?? page),
        pages,
        compare: false,
        comments,
        draft: null,
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
      this.stopCommenting();
      const projects = await tauriBridge.designList(this.workspace).catch(() => this.state.projects);
      const versions = await tauriBridge.designVersions(this.workspace, id).catch(() => []);
      this.set({
        active: true,
        project: projects.find((p) => p.id === id) ?? null,
        projects,
        versions,
        viewing: null,
        pages: [],
        compare: false,
        comments: [],
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

  async viewPage(page: string) {
    const { project, viewing } = this.state;
    if (project) await this.open(project.id, { page, version: viewing ?? undefined });
  }

  /** เทียบทุกหน้าเคียงกันในหน้าเดียว (เซิร์ฟเวอร์สร้างหน้า iframe ให้) */
  async setCompare(compare: boolean) {
    const { project, viewing, page, device } = this.state;
    if (!project) return;
    if (!compare || !this.base) {
      await this.open(project.id, { page, version: viewing ?? undefined });
      return;
    }
    this.stopCommenting();
    this.set({ compare: true, draft: null });
    const url = `${this.base}__compare?width=${DESIGN_DEVICES[device].width}`;
    const loadError = await browserPane.navigate(url);
    this.set({ url });
    await this.applyDevice();
    if (loadError) this.set({ error: loadError });
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
    if (this.state.compare) void this.setCompare(true);
    else void this.applyDevice();
  }

  /** กรอบของจอจำลองใน pane (CSS px) เปลี่ยน */
  reportFrame(frame: { width: number; height: number }) {
    this.frame = frame;
    void this.applyDevice();
  }

  /** ให้หน้าเว็บคิดว่าจอกว้างเท่าอุปกรณ์ แล้วย่อภาพลงให้พอดีกรอบ */
  private async applyDevice() {
    if (!this.state.active || !this.state.url || !this.frame || !browserPane.getState().created) return;
    await browserPane.setEmulation(deviceMetrics(stageDevice(this.state), this.frame)).catch((err) => {
      console.warn('Could not emulate the device size:', err);
    });
  }

  // ---------- โหมดคอมเมนต์ ----------

  setCommenting(commenting: boolean) {
    if (!commenting) return this.stopCommenting();
    const { project, viewing, compare, url } = this.state;
    if (!project || !url || viewing !== null || compare || this.state.commenting) return;
    this.set({ commenting: true, draft: null });
    this.pollTimer = setInterval(() => void this.pollPicks(), COMMENT_POLL_MS);
    void this.pollPicks();
  }

  private stopCommenting() {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (!this.state.commenting) return;
    this.set({ commenting: false, draft: null });
    void this.evaluate(COMMENT_MODE_OFF).catch(() => {});
  }

  private async evaluate(expression: string): Promise<unknown> {
    const res = await tauriBridge.browserCdp('Runtime.evaluate', { expression, returnByValue: true });
    return res?.result?.value;
  }

  /** อ่านคลิกจากหน้าเว็บ — ถ้าหน้าโหลดใหม่ (ไม่มีตัวรับคลิกแล้ว) ก็ติดตั้งให้ใหม่พร้อมหมุด */
  private async pollPicks() {
    if (this.polling) return;
    this.polling = true;
    try {
      const raw = await this.evaluate(READ_COMMENT_PICKS);
      if (!this.state.commenting) return;
      if (raw === null || raw === undefined) {
        await this.evaluate(COMMENT_MODE_ON);
        await this.syncPins();
        return;
      }
      const picks = JSON.parse(String(raw));
      const pick = Array.isArray(picks) && picks.length > 0 ? sanitizePick(picks[picks.length - 1]) : null;
      if (pick) {
        this.set({ draft: pick });
        // คลิกในหน้าเว็บ keyboard จะอยู่ที่ webview นั้น ต้องดึงกลับมาให้พิมพ์คอมเมนต์ได้เลย
        void tauriBridge.browserFocusApp().catch(() => {});
      }
    } catch {
      // หน้ากำลังเปลี่ยน — รอบหน้าค่อยลองใหม่
    } finally {
      this.polling = false;
    }
  }

  private async syncPins() {
    const { commenting, comments, page } = this.state;
    if (!commenting) return;
    const pins = comments.map((c, i) => ({ n: i + 1, selector: c.selector, page: c.page })).filter((c) => c.page === page);
    await this.evaluate(setCommentPins(pins.map(({ n, selector }) => ({ n, selector })))).catch(() => {});
  }

  cancelDraft() {
    this.set({ draft: null });
  }

  private async updateComments(comments: DesignComment[]) {
    const { project } = this.state;
    if (!project) return;
    this.set({ comments });
    try {
      await saveComments(this.workspace, project.id, comments);
    } catch (err) {
      this.set({ error: errorText(err) });
    }
    await this.syncPins();
  }

  async addComment(note: string) {
    const { draft, comments, page, device } = this.state;
    const text = note.trim();
    if (!draft || !text) return;
    const comment: DesignComment = {
      ...draft,
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      note: text,
      page,
      device,
      at: Date.now(),
      sent: false,
    };
    this.set({ draft: null });
    await this.updateComments([...comments, comment]);
  }

  async removeComment(id: string) {
    await this.updateComments(this.state.comments.filter((c) => c.id !== id));
  }

  /** ข้อความส่งเข้าแชทของคอมเมนต์ที่ยังไม่ได้ส่ง (null = ไม่มีอะไรต้องส่ง) */
  pendingPrompt(intro: (title: string) => string): string | null {
    const { project, comments } = this.state;
    const pending = comments.filter((c) => !c.sent);
    if (!project || pending.length === 0) return null;
    return commentsPrompt(intro(project.title), project.id, pending);
  }

  /** เรียกเมื่อแชทรับข้อความแล้วเท่านั้น — ส่งไม่ได้ (เช่น ยังไม่มี API key) คอมเมนต์ต้องยังรอส่งอยู่ */
  async markCommentsSent() {
    await this.updateComments(this.state.comments.map((c) => ({ ...c, sent: true })));
  }

  /** agent ปิดคอมเมนต์ผ่าน tool — อัปเดตหมุดถ้าเปิดโปรเจกต์นั้นอยู่ */
  async reloadComments(id: string) {
    if (this.state.project?.id !== id) return;
    this.set({ comments: await loadComments(this.workspace, id) });
    await this.syncPins();
  }
}

/** จอที่ใช้จัดวาง: ตอนเทียบหลายแบบ หน้าเทียบกินเต็มพื้นที่เสมอ ขนาดจอไปมีผลกับแต่ละแบบข้างใน */
export function stageDevice(state: Pick<DesignCanvasState, 'compare' | 'device'>): DesignDevice {
  return state.compare ? 'desktop' : state.device;
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
