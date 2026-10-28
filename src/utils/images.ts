import type { ImageAttachment } from '../types/agent';

/** ชนิดที่ทุกค่าย (Claude, GPT, Gemini) รับ */
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_IMAGES_PER_MESSAGE = 5;
/** ขอบยาวสุด — ใหญ่กว่านี้โมเดลย่อเองอยู่แล้ว ส่งไปก็เปลือง token */
const MAX_EDGE_PX = 1568;
/** เพดานของ API (Claude 5 MB ต่อรูปหลัง base64) เผื่อไว้ */
const MAX_BASE64_BYTES = 4.5 * 1024 * 1024;
/** ไฟล์ต้นฉบับใหญ่เกินนี้ไม่เปิดเลย */
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

export class ImageAttachError extends Error {
  constructor(public code: 'unsupported' | 'too_large' | 'decode') {
    super(code);
    this.name = 'ImageAttachError';
  }
}

function readAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new ImageAttachError('decode'))), type, quality)
  );
}

/** ย่อรูปให้ขอบยาวไม่เกิน MAX_EDGE_PX — PNG คงเป็น PNG (ภาพหน้าจอคมกว่า) ที่เหลือเป็น JPEG */
async function downscale(file: Blob, forceJpeg: boolean): Promise<{ blob: Blob; mediaType: string }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageAttachError('decode');
  }
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageAttachError('decode');
  const mediaType = !forceJpeg && file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  if (mediaType === 'image/jpeg') {
    // JPEG ไม่มี alpha — พื้นขาวแทนพื้นดำ
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { blob: await canvasToBlob(canvas, mediaType, 0.88), mediaType };
}

async function needsResize(file: Blob): Promise<boolean> {
  try {
    const bitmap = await createImageBitmap(file);
    const big = Math.max(bitmap.width, bitmap.height) > MAX_EDGE_PX;
    bitmap.close();
    return big;
  } catch {
    throw new ImageAttachError('decode');
  }
}

/** แปลงไฟล์รูป (จากการวาง/ลาก/เลือกไฟล์) เป็น attachment พร้อมส่ง */
export async function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) throw new ImageAttachError('unsupported');
  if (file.size > MAX_SOURCE_BYTES) throw new ImageAttachError('too_large');

  let blob: Blob = file;
  let mediaType = file.type;
  // GIF ย่อแล้วจะเหลือเฟรมเดียว — ส่งตามเดิมถ้าขนาดไหว
  if (file.type !== 'image/gif' && (await needsResize(file))) {
    ({ blob, mediaType } = await downscale(file, false));
  }
  let data = await readAsBase64(blob);
  if (data.length > MAX_BASE64_BYTES) {
    if (file.type === 'image/gif') throw new ImageAttachError('too_large');
    ({ blob, mediaType } = await downscale(blob, true));
    data = await readAsBase64(blob);
    if (data.length > MAX_BASE64_BYTES) throw new ImageAttachError('too_large');
  }

  return {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: file.name || (mediaType === 'image/png' ? 'pasted-image.png' : 'image.jpg'),
    mediaType,
    data,
  };
}

/** ขอบยาวสุดของภาพพื้นหลัง — พอสำหรับจอ 1440p โดยไม่หนัก localStorage */
const WALLPAPER_MAX_EDGE_PX = 2560;

/** แปลงไฟล์รูปเป็น data URL แบบ JPEG ที่ย่อแล้ว สำหรับใช้เป็นภาพพื้นหลัง */
export async function fileToWallpaper(file: File): Promise<string> {
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) throw new ImageAttachError('unsupported');
  if (file.size > MAX_SOURCE_BYTES) throw new ImageAttachError('too_large');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageAttachError('decode');
  }
  const scale = Math.min(1, WALLPAPER_MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageAttachError('decode');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.85);
  return `data:image/jpeg;base64,${await readAsBase64(blob)}`;
}

export function imageSrc(img: ImageAttachment): string | undefined {
  return img.data ? `data:${img.mediaType};base64,${img.data}` : undefined;
}
