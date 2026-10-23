import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

let permission: Promise<boolean> | null = null;

/** ขอสิทธิ์ครั้งเดียวต่อการเปิดแอป (Windows ให้สิทธิ์แอปที่ติดตั้งอยู่แล้วโดยปกติ) */
function notificationsAllowed(): Promise<boolean> {
  permission ??= (async () => {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === 'granted';
  })().catch(() => false);
  return permission;
}

/** ตัด markdown คร่าว ๆ ให้เหลือข้อความสั้นพอสำหรับ notification */
export function notificationBody(markdown: string, max = 140): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>|]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** แจ้งเตือนเฉพาะตอนที่ผู้ใช้ไม่ได้ดูหน้าต่าง Dex อยู่ — ถ้าดูอยู่ก็เห็นเองแล้ว */
export function notifyIfAway(title: string, body?: string) {
  if (typeof document !== 'undefined' && document.hasFocus()) return;
  void notificationsAllowed().then((ok) => {
    if (ok) sendNotification({ title, ...(body ? { body } : {}) });
  });
}
