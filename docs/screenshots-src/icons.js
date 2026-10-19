// Minimal codicon-like glyphs: <i data-i="check"></i> becomes an inline SVG.
const ICONS = {
  org: '<circle cx="8" cy="4" r="2" stroke="#ccc" stroke-width="1.3" fill="none"/><circle cx="3.5" cy="12" r="1.8" stroke="#ccc" stroke-width="1.3" fill="none"/><circle cx="12.5" cy="12" r="1.8" stroke="#ccc" stroke-width="1.3" fill="none"/><path d="M8 6v2.5M3.5 10V8.5h9V10" stroke="#ccc" stroke-width="1.3" fill="none"/>',
  reload: '<path d="M12.6 5.2A5 5 0 1 0 13 9" stroke="#cca700" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M13.2 1.8v3.8H9.4" stroke="#cca700" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  checklist: '<path d="M2 4l1.4 1.4L6 2.8M2 10l1.4 1.4L6 8.8" stroke="#ccc" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 4.2h6M8 10.2h6" stroke="#ccc" stroke-width="1.3"/>',
  box: '<rect x="2" y="2" width="12" height="12" rx="2" stroke="#9d9d9d" stroke-width="1.3" fill="none"/>',
  boxon: '<rect x="2" y="2" width="12" height="12" rx="2" fill="#0078d4"/><path d="M4.6 8.2l2.2 2.2 4.6-4.8" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  check: '<circle cx="8" cy="8" r="7" fill="#73c991"/><path d="M4.6 8.2l2.2 2.2 4.6-4.8" stroke="#1e1e1e" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  circle: '<circle cx="8" cy="8" r="6.2" stroke="#9d9d9d" stroke-width="1.4" fill="none"/>',
  slash: '<circle cx="8" cy="8" r="6.2" stroke="#9d9d9d" stroke-width="1.4" fill="none"/><path d="M3.8 12.2l8.4-8.4" stroke="#9d9d9d" stroke-width="1.4"/>',
  warn: '<path d="M8 1.5l7 12.5H1z" fill="#cca700"/><path d="M8 6v4" stroke="#1e1e1e" stroke-width="1.6"/><circle cx="8" cy="12" r=".9" fill="#1e1e1e"/>',
  error: '<circle cx="8" cy="8" r="7" fill="#f14c4c"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#1e1e1e" stroke-width="1.8"/>',
  swap: '<path d="M2 5h10l-2.5-2.5M14 11H4l2.5 2.5" stroke="#3794ff" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
  add: '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  up: '<path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  down: '<path d="M8 3v10M4 9l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  list: '<path d="M6 4h8M6 8h8M6 12h8" stroke="currentColor" stroke-width="1.4"/><text x="0.5" y="6" font-size="5" fill="currentColor">1</text><text x="0.5" y="10" font-size="5" fill="currentColor">2</text><text x="0.5" y="14" font-size="5" fill="currentColor">3</text>',
  sparkle: '<path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z" fill="#d97757"/>',
  code: '<path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4" stroke="#cccccc" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  pool: '<g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><path d="M5.7 3.5a3.3 3.3 0 0 1 5 .3"/><path d="M10.3 5.6a3.3 3.3 0 0 1-4.9-.3"/><circle cx="5" cy="8.8" r="1.2"/><circle cx="8" cy="8.4" r="1.3"/><circle cx="11" cy="8.8" r="1.2"/><path d="M2.3 9.3h11.4a5.7 4 0 0 1-11.4 0z"/></g>',
  history: '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" stroke-width="1.3" fill="none"/>',
  gear: '<circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="8" cy="8" r="5.6" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.2 1.6" fill="none"/>',
  bell: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M6.5 14h3" stroke="currentColor" stroke-width="1.3"/>',
  terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M4 6l2.5 2L4 10M8 10.5h4" stroke="currentColor" stroke-width="1.3" fill="none"/>',
};
document.querySelectorAll("i[data-i]").forEach((el) => {
  el.outerHTML = `<svg class="i" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">${ICONS[el.dataset.i]}</svg>`;
});
// <m data-p="42"></m> becomes a quota meter coloured like the status bar (80% warn, 95% hot).
document.querySelectorAll("m[data-p]").forEach((el) => {
  const p = Number(el.dataset.p);
  const color = p >= 95 ? "#f14c4c" : p >= 80 ? "#cca700" : "#73c991";
  el.outerHTML = `<span class="meter"><span style="width:${Math.max(p, 2)}%;background:${color}"></span></span>`;
});
