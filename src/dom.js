// Tiny DOM helpers. Everything user-supplied goes through textContent / properties (never innerHTML).

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Static, app-authored SVG paths only (24x24 viewBox, stroke icons).
const PATHS = {
  lock: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M17.9 17.9A10.9 10.9 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M1 1l22 22M14.1 14.1a3 3 0 1 1-4.2-4.2',
  back: 'M15 5l-7 7 7 7',
  plus: 'M12 5v14M5 12h14',
  trash: 'M3 6h18M8 6V4h8v2m-9 0l1 14h8l1-14',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9A9 9 0 0 1 18 5.6L23 10M1 14l5 4.4A9 9 0 0 0 20.5 15',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
};

export function icon(name, size = 24) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', PATHS[name]);
  svg.append(p);
  return svg;
}

export function iconBtn(name, label, onclick, cls = '') {
  return h('button', { class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, title: label, onclick }, icon(name));
}

let toastEl, toastTimer;
export function toast(msg, ms = 2600) {
  toastEl?.remove();
  toastEl = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(toastEl);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl?.remove(), ms);
}

/** Bottom sheet. `build(close)` returns the content node. Returns close(). */
export function sheet(build) {
  const scrim = h('div', { class: 'scrim' });
  const close = () => scrim.remove();
  const box = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, build(close));
  scrim.append(box);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(); });
  document.body.append(scrim);
  return close;
}

export function confirmDialog(title, message, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v, close) => { if (!done) { done = true; close(); resolve(v); } };
    sheet((close) => [
      h('h2', {}, title),
      h('p', { class: 'muted' }, message),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => finish(false, close) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : ''}`, type: 'button', onclick: () => finish(true, close) }, okLabel)),
    ]);
  });
}

/** Ask for a secret. Resolves to the string, or null if cancelled. */
export function passwordDialog(title, message, okLabel = 'OK') {
  return new Promise((resolve) => {
    sheet((close) => {
      const input = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
      const go = () => { close(); resolve(input.value); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      setTimeout(() => input.focus(), 50);
      return h('div', { class: 'stack' },
        h('h2', {}, title),
        message && h('p', { class: 'muted' }, message),
        input,
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost', type: 'button', onclick: () => { close(); resolve(null); } }, 'Cancel'),
          h('button', { class: 'btn', type: 'button', onclick: go }, okLabel)));
    });
  });
}
