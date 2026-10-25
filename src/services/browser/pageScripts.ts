/**
 * สคริปต์ที่รันในหน้าเว็บของ browser pane (ผ่าน Runtime.evaluate) — เขียนเป็นสตริง JS ล้วน
 * ไม่ใช้ fn.toString() เพราะ bundler อาจแทรก helper ที่ไม่มีในหน้าเว็บ
 */

/**
 * ติดตั้งก่อนสคริปต์ของทุกหน้า: เก็บ console, error ที่ไม่ถูกจับ และ request ที่ล้มเหลวไว้ใน window.__dexConsole
 * และให้ลิงก์ target=_blank เปิดใน pane เดิม (pane มีแท็บเดียว — คลิกผ่าน DevTools ไม่ทำให้เกิดหน้าต่างใหม่)
 */
export const PAGE_HOOK = `(() => {
  if (window.__dexConsole) return;
  document.addEventListener('click', (e) => {
    const link = e.target && e.target.closest ? e.target.closest('a[target]') : null;
    if (link && link.href && link.target !== '_self') link.target = '_self';
  }, true);
  const buf = (window.__dexConsole = []);
  const show = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || String(a);
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  const push = (level, args) => {
    try {
      buf.push({ level, text: args.map(show).join(' ').slice(0, 2000) });
      if (buf.length > 300) buf.shift();
    } catch {}
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level];
    console[level] = function (...args) { push(level, args); return original.apply(this, args); };
  }
  addEventListener('error', (e) => push('error', [e.message + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : '')]));
  addEventListener('unhandledrejection', (e) => push('error', ['Unhandled rejection: ' + show(e.reason)]));
  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function (...args) {
      const target = args[0] && args[0].url ? args[0].url : String(args[0]);
      try {
        const res = await originalFetch.apply(this, args);
        if (!res.ok) push('network', [res.status + ' ' + (args[1] && args[1].method || 'GET') + ' ' + target]);
        return res;
      } catch (err) {
        push('network', ['failed ' + target + ': ' + show(err)]);
        throw err;
      }
    };
  }
})()`;

/** อ่านแล้วล้าง log ที่เก็บไว้ — null = หน้านี้โหลดก่อนติดตั้งตัวเก็บ */
export const READ_CONSOLE = `window.__dexConsole ? JSON.stringify(window.__dexConsole.splice(0)) : null`;

/**
 * โครงหน้าแบบข้อความ: หัวข้อ ข้อความ และ element ที่โต้ตอบได้ พร้อม ref (`[e12] button "Save"`)
 * ref ถูกเขียนลง data-dex-ref เพื่อให้ click/type หา element เจอ — snapshot ใหม่ล้าง ref เก่าทิ้ง
 */
export const SNAPSHOT = `((maxChars) => {
  const clean = (s, n) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'HEAD', 'META', 'LINK']);
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=option],[role=combobox],[role=textbox],[role=slider],[contenteditable=""],[contenteditable="true"],[onclick]';
  const LEAF_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
  const LEAF_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'option', 'menuitem', 'tab', 'slider', 'textbox']);
  const roleOf = (el) => {
    const role = el.getAttribute('role');
    if (role) return role;
    switch (el.tagName) {
      case 'A': return 'link';
      case 'BUTTON': case 'SUMMARY': return 'button';
      case 'SELECT': return 'select';
      case 'TEXTAREA': return 'textbox';
      case 'INPUT': {
        const t = (el.type || 'text').toLowerCase();
        if (t === 'checkbox' || t === 'radio') return t;
        if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
        return t === 'range' ? 'slider' : 'textbox';
      }
    }
    return el.isContentEditable ? 'textbox' : 'clickable';
  };
  const nameOf = (el) => clean(
    el.getAttribute('aria-label') ||
      (el.labels && el.labels[0] && el.labels[0].innerText) ||
      el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
      (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type) ? el.value : '') ||
      el.innerText || el.getAttribute('name') || '',
    80
  );
  const isHidden = (el) => {
    const s = getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse';
  };
  for (const el of document.querySelectorAll('[data-dex-ref]')) el.removeAttribute('data-dex-ref');
  const lines = [];
  let count = 0;
  const describe = (el, ref) => {
    let line = '[' + ref + '] ' + roleOf(el) + ' "' + nameOf(el) + '"';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.type === 'checkbox' || el.type === 'radio') line += el.checked ? ' checked' : ' unchecked';
      else if (el.type === 'password') line += el.value ? ' value="••••"' : ' value=""';
      else line += ' value="' + clean(el.value, 60) + '"';
    } else if (el.tagName === 'SELECT') {
      const options = [...el.options].slice(0, 12).map((o) => clean(o.text, 30)).join(' | ');
      line += ' value="' + clean(el.selectedOptions[0] && el.selectedOptions[0].text, 40) + '" options=[' + options + ']';
    } else if (el.tagName === 'A') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) line += ' -> ' + href.slice(0, 100);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' disabled';
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) line += ' expanded=' + expanded;
    return line;
  };
  const walk = (parent) => {
    for (const el of parent.children) {
      if (SKIP.has(el.tagName.toUpperCase()) || el.getAttribute('aria-hidden') === 'true' || isHidden(el)) continue;
      if (el.matches(INTERACTIVE)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const ref = 'e' + ++count;
        el.setAttribute('data-dex-ref', ref);
        lines.push(describe(el, ref));
        if (LEAF_TAGS.has(el.tagName) || LEAF_ROLES.has(el.getAttribute('role'))) continue;
      } else if (/^H[1-6]$/.test(el.tagName)) {
        const text = clean(el.innerText, 150);
        if (text) lines.push('#'.repeat(Number(el.tagName[1])) + ' ' + text);
        continue;
      } else {
        let own = '';
        for (const node of el.childNodes) if (node.nodeType === 3) own += node.textContent;
        own = clean(own, 300);
        if (own) lines.push(own);
      }
      if (el.shadowRoot) walk(el.shadowRoot);
      walk(el);
    }
  };
  if (document.body) walk(document.body);
  let text = lines.join('\\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\\n… [' + (text.length - maxChars) + ' more characters — scroll, or read them with evaluate]';
  return JSON.stringify({
    url: location.href,
    title: document.title,
    refs: count,
    scroll: Math.round(scrollY) + ' of ' + Math.max(0, document.documentElement.scrollHeight - innerHeight) + 'px',
    text,
  });
})`;

/** เลื่อน element ให้อยู่กลางจอ แล้วคืนจุดกึ่งกลาง (CSS px) และบอกถ้ามีอย่างอื่นบังอยู่ */
export const LOCATE_REF = `((ref) => {
  const el = document.querySelector('[data-dex-ref="' + CSS.escape(ref) + '"]');
  if (!el) return JSON.stringify({ error: 'No element ' + ref + ' on this page. Take a new snapshot — refs change after the page updates.' });
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  const covered = top && top !== el && !el.contains(top) && !top.contains(el)
    ? (top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + ' "' + (top.innerText || '').trim().slice(0, 40) + '"')
    : null;
  return JSON.stringify({ x, y, covered });
})`;

/** focus ช่องที่จะพิมพ์ และเลือกข้อความเดิมไว้ทั้งหมดถ้าจะพิมพ์ทับ */
export const FOCUS_REF = `(([ref, clear]) => {
  const el = document.querySelector('[data-dex-ref="' + CSS.escape(ref) + '"]');
  if (!el) return JSON.stringify({ error: 'No element ' + ref + ' on this page. Take a new snapshot — refs change after the page updates.' });
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  if (el.tagName === 'SELECT') return JSON.stringify({ select: true });
  el.focus();
  if (clear) {
    if (typeof el.select === 'function') {
      try { el.select(); } catch {}
    } else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  const active = document.activeElement;
  return JSON.stringify({ focused: active === el || el.contains(active) });
})`;

/** เลือก option ของ <select> ตาม value หรือข้อความ แล้วยิง event ให้ framework รู้ */
export const SELECT_OPTION = `(([ref, wanted]) => {
  const el = document.querySelector('[data-dex-ref="' + CSS.escape(ref) + '"]');
  if (!el) return JSON.stringify({ error: 'No element ' + ref });
  const want = String(wanted).trim().toLowerCase();
  const option = [...el.options].find((o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want);
  if (!option) return JSON.stringify({ error: 'No option "' + wanted + '". Options: ' + [...el.options].map((o) => o.text.trim()).join(' | ') });
  el.value = option.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ selected: option.text.trim() });
})`;

export const PAGE_INFO = `JSON.stringify({ url: location.href, title: document.title, ready: document.readyState })`;

export const VIEWPORT = `JSON.stringify({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY })`;

/** เรียกสคริปต์ที่เป็นฟังก์ชันพร้อม argument (ส่งเป็น JSON) */
export function callScript(script: string, arg: unknown): string {
  return `${script}(${JSON.stringify(arg)})`;
}
