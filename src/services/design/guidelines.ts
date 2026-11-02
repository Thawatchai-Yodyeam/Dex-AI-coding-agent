/** แนวทางออกแบบที่ส่งให้โมเดลตอนสร้าง/เปิดโปรเจกต์ — ไม่อยู่ใน system prompt จะได้ไม่เสีย token ทุกเทิร์น */
export const DESIGN_GUIDELINES = `Design guidelines for Dex Design:
- Before designing, make sure you know who it is for, what it must achieve and the mood. If the user gave none of these, ask up to three short questions; otherwise state your assumptions in one line and start. If the workspace has a product, look at its styles and logos first and use them.
- Commit to one clear visual direction that suits this product. Avoid the generic AI look: purple gradients on white, an icon in a rounded square above every heading, three identical cards, centred text everywhere, emoji as icons.
- Build a type scale with real contrast in size and weight, and use a characterful typeface from Google Fonts. For Thai text pick a font with Thai glyphs (IBM Plex Sans Thai, Noto Sans Thai, Sarabun, Prompt, Kanit) and give it a line height of at least 1.5.
- Define colors, spacing and radii as CSS variables in :root. Use one dominant color and one accent, and keep body text at a contrast of at least 4.5:1.
- Use a consistent spacing scale and give the layout hierarchy: one thing should clearly lead each screen. Vary composition rather than stacking equal sections.
- Write realistic copy in the user's language. Never use lorem ipsum, "Feature 1" or invented statistics presented as fact.
- Make it responsive at 1440, 820 and 390 pixels wide, use semantic HTML, give images alt text, show focus states and respect prefers-reduced-motion.
- Interactive prototypes should really respond: tabs switch, forms validate, menus open. Use a little inline JavaScript rather than a framework.
- Files: index.html is the entry point. Plain HTML, CSS and JS only, with no build step. Pages can load Google Fonts and libraries from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com. fetch only works for files in the project, and forms cannot submit. Draw images as inline SVG or CSS, or use a clearly labelled placeholder.
- After each write, check your work with the browser tool on the page already open: read console for errors, take a snapshot, and take a screenshot if this model can see images. Fix what you find, then tell the user in a few lines what you made and which decisions they may want to change.`;
