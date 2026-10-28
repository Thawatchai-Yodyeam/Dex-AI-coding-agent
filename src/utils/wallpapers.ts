/**
 * ภาพพื้นหลังที่มากับแอป — วางไฟล์ไว้ใน src/assets/wallpapers แล้วจะโผล่ในหน้าตั้งค่าเอง
 * ตัวแรกตามชื่อไฟล์เป็นค่าเริ่มต้นของคนที่ยังไม่เคยเลือกภาพ
 */
const files = import.meta.glob('../assets/wallpapers/*.{jpg,jpeg,png,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export interface WallpaperPreset {
  /** ชื่อไฟล์ — เก็บใน settings แทน URL เพราะ URL ตอน build มี hash เปลี่ยนได้ */
  id: string;
  url: string;
}

export const WALLPAPER_PRESETS: WallpaperPreset[] = Object.entries(files)
  .map(([path, url]) => ({ id: path.slice(path.lastIndexOf('/') + 1), url }))
  .sort((a, b) => a.id.localeCompare(b.id));

const PRESET_PREFIX = 'preset:';

export function presetValue(id: string): string {
  return PRESET_PREFIX + id;
}

/**
 * ค่า settings.wallpaper → URL ที่ใช้วาด
 * undefined = ยังไม่เคยเลือก (ใช้ภาพแรกที่มากับแอป), '' = ปิดภาพพื้นหลัง,
 * 'preset:<ไฟล์>' = ภาพที่มากับแอป, 'data:…' = ภาพของผู้ใช้
 */
export function resolveWallpaper(value: string | undefined): string | undefined {
  if (value === undefined) return WALLPAPER_PRESETS[0]?.url;
  if (value.startsWith(PRESET_PREFIX)) {
    const id = value.slice(PRESET_PREFIX.length);
    return WALLPAPER_PRESETS.find((p) => p.id === id)?.url;
  }
  return value.startsWith('data:image/') ? value : undefined;
}
