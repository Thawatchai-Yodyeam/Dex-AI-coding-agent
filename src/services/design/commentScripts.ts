/**
 * สคริปต์โหมดคอมเมนต์ที่รันในหน้าดีไซน์ (ผ่าน Runtime.evaluate) — เขียนเป็นสตริง JS ล้วน เหมือน browser/pageScripts.ts
 * หน้าเว็บเรียกคำสั่งของแอปไม่ได้ แอปจึงเป็นฝ่ายมาอ่านคลิกจาก window.__dexComment.picks
 * ผู้ใช้พิมพ์คอมเมนต์ในหน้าแอป ไม่ใช่ในหน้าเว็บ หน้าเว็บจึงปลอมคำขอของผู้ใช้ไม่ได้ ทำได้แค่ปลอมว่าคลิกตรงไหน
 */

/** เปิดโหมดคอมเมนต์: ไฮไลต์ชิ้นส่วนใต้เมาส์ คลิกแล้วจดไว้ และไม่ให้คลิกไปโดนปุ่มหรือลิงก์จริงในหน้า */
export const COMMENT_MODE_ON = `(() => {
  if (window.__dexComment) return true;
  const host = document.createElement('dex-comment-overlay');
  host.style.cssText = 'position:fixed;inset:0;display:block;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'closed' });
  const layer = (css) => {
    const el = document.createElement('div');
    el.style.cssText = css;
    root.appendChild(el);
    return el;
  };
  const box = layer('position:fixed;display:none;box-sizing:border-box;border:2px solid #d9622b;background:rgba(217,98,43,.14);border-radius:3px');
  const pinLayer = layer('position:fixed;inset:0');
  document.documentElement.appendChild(host);
  const cursor = document.createElement('style');
  cursor.textContent = '*{cursor:crosshair !important}';
  document.documentElement.appendChild(cursor);

  const clean = (s, n) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const uniqueId = (el) => el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1;
  const selectorOf = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (uniqueId(node)) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ') || 'html';
  };

  let hovered = null;
  let pins = [];
  const place = (el, rect) => {
    el.style.left = rect.left + 'px';
    el.style.top = rect.top + 'px';
  };
  let frame = 0;
  const draw = () => {
    if (hovered && hovered.isConnected) {
      const r = hovered.getBoundingClientRect();
      place(box, r);
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
      box.style.display = 'block';
    } else {
      box.style.display = 'none';
    }
    for (const pin of pins) {
      const target = pin.target && pin.target.isConnected ? pin.target : null;
      pin.el.style.display = target ? 'flex' : 'none';
      if (target) place(pin.el, target.getBoundingClientRect());
    }
    frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);

  const targetOf = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
  const onMove = (e) => {
    const el = targetOf(e);
    if (el && el.nodeType === 1) hovered = el;
  };
  const onLeave = () => { hovered = null; };
  const block = (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const api = (window.__dexComment = { picks: [] });
  const onClick = (e) => {
    if (!e.isTrusted) return;
    block(e);
    const el = targetOf(e);
    if (!el || el.nodeType !== 1) return;
    api.picks.push({
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      text: clean(el.innerText || el.value || el.getAttribute('alt') || el.getAttribute('aria-label'), 200),
      html: (el.outerHTML || '').slice(0, 400),
      width: innerWidth,
    });
    if (api.picks.length > 20) api.picks.shift();
  };
  const blocked = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu', 'submit', 'dragstart', 'touchstart', 'touchend'];
  addEventListener('mousemove', onMove, true);
  document.documentElement.addEventListener('mouseleave', onLeave);
  addEventListener('click', onClick, true);
  for (const type of blocked) addEventListener(type, block, { capture: true, passive: false });

  /** หมุดเลขกำกับชิ้นส่วนที่มีคอมเมนต์แล้ว */
  api.setPins = (list) => {
    pinLayer.textContent = '';
    pins = list.map((item) => {
      const el = document.createElement('div');
      el.textContent = String(item.n);
      el.style.cssText = 'position:fixed;display:none;align-items:center;justify-content:center;min-width:22px;height:22px;margin:-9px 0 0 -9px;padding:0 5px;box-sizing:border-box;border-radius:11px;background:#d9622b;color:#fff;font:600 12px/1 system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.35)';
      pinLayer.appendChild(el);
      let target = null;
      try { target = document.querySelector(item.selector); } catch {}
      return { el, target };
    });
  };
  api.off = () => {
    cancelAnimationFrame(frame);
    removeEventListener('mousemove', onMove, true);
    document.documentElement.removeEventListener('mouseleave', onLeave);
    removeEventListener('click', onClick, true);
    for (const type of blocked) removeEventListener(type, block, { capture: true });
    host.remove();
    cursor.remove();
    delete window.__dexComment;
  };
  return true;
})()`;

export const COMMENT_MODE_OFF = `window.__dexComment ? (window.__dexComment.off(), true) : false`;

/** อ่านแล้วล้างคลิกที่จดไว้ — null = หน้าโหลดใหม่ ต้องเปิดโหมดคอมเมนต์อีกรอบ */
export const READ_COMMENT_PICKS = `window.__dexComment ? JSON.stringify(window.__dexComment.picks.splice(0)) : null`;

export function setCommentPins(pins: { n: number; selector: string }[]): string {
  return `window.__dexComment && window.__dexComment.setPins(${JSON.stringify(pins)})`;
}
