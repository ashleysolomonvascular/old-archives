import './styles.css';
import { version } from '../package.json';
import { h, icon, iconBtn, toast, sheet, confirmDialog, passwordDialog } from './dom.js';
import * as vault from './vault.js';
import * as bio from './bio.js';
import { generatePassword, generatePassphrase, estimateBits, strengthLabel } from './generator.js';

const app = document.getElementById('app');
const CLIP_CLEAR_MS = 30_000;

// ---------------------------------------------------------------------------------------------
// state + routing
// ---------------------------------------------------------------------------------------------
let view = { screen: 'boot' };
let stack = [];
let ui = { search: '', tag: null }; // list filters; cleared on lock

function go(next, { replace = false } = {}) {
  if (!replace) {
    stack.push(view);
    history.pushState({ oa: 1 }, '');
  }
  view = next;
  render();
}
const back = () => history.back();

window.addEventListener('popstate', () => {
  if (!vault.isUnlocked()) return;
  if (stack.length) {
    view = stack.pop();
    render();
  }
});

function resetToList() {
  stack = [];
  view = { screen: 'list' };
  render();
}

// ---------------------------------------------------------------------------------------------
// auto-lock (idle + background) and clipboard hygiene
// ---------------------------------------------------------------------------------------------
let idleTimer = null;
let idleMs = 2 * 60_000;
let clipTimer = null;

function armIdle() {
  clearTimeout(idleTimer);
  if (vault.isUnlocked()) idleTimer = setTimeout(doLock, idleMs);
}
['pointerdown', 'keydown', 'touchstart', 'scroll', 'input'].forEach((ev) =>
  window.addEventListener(ev, armIdle, { capture: true, passive: true }),
);
let suppressLock = false; // true while a WebAuthn/biometric sheet is open (it may blur the page)
let lockAuto = null;      // lock screen registers its fingerprint prompt here
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (!suppressLock) doLock(); } else if (!vault.isUnlocked()) lockAuto?.();
});
window.addEventListener('pagehide', () => { if (!suppressLock) doLock(); });

function doLock() {
  clearTimeout(idleTimer);
  if (!vault.isUnlocked()) return;
  vault.lock();
  ui = { search: '', tag: null };
  document.querySelectorAll('.scrim').forEach((n) => n.remove());
  stack = [];
  view = { screen: 'lock' };
  render();
}
vault.onChange(() => {
  /* hook point for backup (stage 3) */
});

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast('Could not copy');
    return;
  }
  clearTimeout(clipTimer);
  clipTimer = setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), CLIP_CLEAR_MS);
  toast(`${label} copied · clears in 30 s`);
}

// ---------------------------------------------------------------------------------------------
// shared pieces
// ---------------------------------------------------------------------------------------------
function header(title, { backBtn = false, right = [] } = {}) {
  return h('header', { class: 'top' },
    backBtn && iconBtn('back', 'Back', back),
    h('h1', {}, title),
    ...right);
}

function strengthMeter() {
  const bar = h('i');
  const label = h('div', { class: 'small muted' });
  const wrap = h('div', {}, h('div', { class: 'meter' }, bar), label);
  wrap.update = (pw) => {
    const bits = estimateBits(pw);
    const s = strengthLabel(bits);
    bar.className = `l${s.level}`;
    bar.style.width = pw ? `${Math.min(100, (bits / 90) * 100)}%` : '0';
    label.textContent = pw ? `${s.label} · ~${Math.round(bits)} bits` : '';
    return s;
  };
  return wrap;
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept });
    input.addEventListener('change', () => resolve(input.files[0] || null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

async function restoreFlow() {
  const file = await pickFile('.json,application/json');
  if (!file) return false;
  let obj;
  try {
    obj = JSON.parse(await file.text());
  } catch {
    toast('That file is not a valid backup');
    return false;
  }
  const pw = await passwordDialog('Backup password', 'Enter the master password this backup was made with.', 'Restore');
  if (pw == null) return false;
  try {
    await vault.restoreBackup(obj, pw);
    return true;
  } catch (e) {
    toast(e.name === 'DecryptError' ? 'Wrong password, or the backup is damaged' : e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// screens
// ---------------------------------------------------------------------------------------------
function setupScreen() {
  const pw = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
  const pw2 = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
  const meter = strengthMeter();
  const ack = h('input', { type: 'checkbox', id: 'ack' });
  const err = h('div', { class: 'error' });
  const btn = h('button', { class: 'btn', type: 'button', disabled: true }, 'Create vault');

  const check = () => {
    const s = meter.update(pw.value);
    const ok = pw.value.length >= 12 && s.level >= 1 && pw.value === pw2.value && ack.checked;
    btn.disabled = !ok;
    err.textContent = pw2.value && pw.value !== pw2.value ? 'Passwords do not match' : '';
  };
  [pw, pw2, ack].forEach((el) => el.addEventListener('input', check));

  const suggest = () => {
    const p = generatePassphrase({ words: 6, separator: '-' });
    pw.type = pw2.type = 'text';
    pw.value = pw2.value = p;
    check();
    toast('Write this down somewhere safe before continuing', 4000);
  };

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Creating… (this takes a moment)';
    try {
      await vault.createVault(pw.value);
      idleMs = (await vault.getSettings()).autoLockMin * 60_000;
      resetToList();
      armIdle();
    } catch (e) {
      err.textContent = e.message;
      btn.textContent = 'Create vault';
      check();
    }
  });

  return [
    h('main', { class: 'center' },
      h('div', { class: 'lockhead' },
        h('img', { src: './icons/icon-192.png', alt: '' }),
        h('h1', {}, 'Old archives'),
        h('div', { class: 'muted' }, 'Create your master password')),
      h('div', { class: 'stack' },
        h('div', { class: 'warn' },
          h('strong', {}, 'There is no way to recover this password. '),
          'Everything is encrypted on this phone with it. If you forget it, your data is gone for good — nobody, including the developer, can reset it.'),
        h('label', { class: 'field' }, h('span', {}, 'Master password (12+ characters)'), pw),
        meter,
        h('label', { class: 'field' }, h('span', {}, 'Repeat it'), pw2),
        h('button', { class: 'btn ghost', type: 'button', onclick: suggest }, 'Suggest a passphrase'),
        h('label', { class: 'opt' }, h('span', {}, 'I understand it cannot be recovered'), ack),
        err,
        btn,
        h('button', {
          class: 'btn ghost', type: 'button',
          onclick: async () => { if (await restoreFlow()) { resetToList(); armIdle(); } },
        }, 'Restore from a backup file'))),
  ];
}

function lockScreen() {
  const pw = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, placeholder: 'Master password' });
  const err = h('div', { class: 'error' });
  const note = h('div', { class: 'small muted' });
  const bioBox = h('div', { class: 'stack' });
  const btn = h('button', { class: 'btn', type: 'button' }, 'Unlock');
  let busy = false;

  const finish = async () => {
    idleMs = (await vault.getSettings()).autoLockMin * 60_000;
    lockAuto = null;
    resetToList();
    armIdle();
  };

  const submit = async () => {
    if (!pw.value || busy) return;
    busy = true;
    btn.disabled = true;
    btn.textContent = 'Unlocking…';
    err.textContent = '';
    try {
      await vault.unlock(pw.value);
      pw.value = '';
      await finish();
    } catch (e) {
      err.textContent = e.name === 'DecryptError' ? 'Wrong password' : e.message;
      btn.disabled = false;
      btn.textContent = 'Unlock';
      pw.select();
    }
    busy = false;
  };
  btn.addEventListener('click', submit);
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  const tryBio = async () => {
    if (busy || vault.isUnlocked()) return;
    busy = true;
    err.textContent = '';
    suppressLock = true;
    try {
      await vault.unlockWithVaultKey(await bio.unlockKey());
      await finish();
    } catch (e) {
      if (e.code !== 'cancelled') err.textContent = e.message || 'Fingerprint failed. Use your master password.';
    } finally {
      suppressLock = false;
      busy = false;
    }
  };

  (async () => {
    if (!bio.bioSupported() || !(await bio.isEnrolled())) { setTimeout(() => pw.focus(), 80); return; }
    if (bio.masterRequired(await vault.getLastMasterUnlock())) {
      note.textContent = 'Master password needed now (it is required every 3 days).';
      setTimeout(() => pw.focus(), 80);
      return;
    }
    bioBox.append(h('button', { class: 'btn', type: 'button', onclick: tryBio }, 'Unlock with fingerprint'));
    note.textContent = 'Or use your master password:';
    lockAuto = tryBio;
    if (!document.hidden) setTimeout(tryBio, 200);
  })();

  return h('main', { class: 'center' },
    h('div', { class: 'lockhead' }, h('img', { src: './icons/icon-192.png', alt: '' }), h('h1', {}, 'Old archives')),
    h('div', { class: 'stack' }, bioBox, note, pw, err, btn));
}

function listScreen() {
  const entries = vault.listEntries().sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  const allTags = [...new Set(entries.flatMap((e) => e.tags))].sort();
  if (ui.tag && !allTags.includes(ui.tag)) ui.tag = null;

  const listEl = h('div');
  const q = h('input', { type: 'search', class: 'search', placeholder: 'Search', value: ui.search, autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
  const chipsEl = h('div', { class: 'chips' });

  const draw = () => {
    const needle = ui.search.trim().toLowerCase();
    const shown = entries.filter((e) =>
      (!ui.tag || e.tags.includes(ui.tag)) &&
      (!needle || [e.title, e.username, e.url, e.notes, ...e.tags].some((f) => f.toLowerCase().includes(needle))));
    listEl.replaceChildren(
      ...(shown.length
        ? shown.map((e) => h('div', { class: 'item' },
          h('button', { class: 'main', type: 'button', onclick: () => go({ screen: 'view', id: e.id }) },
            h('div', { class: 't' }, e.title), h('div', { class: 's' }, e.username || e.url || ' ')),
          e.password && iconBtn('copy', `Copy password for ${e.title}`, () => copy(e.password, 'Password'), 'sm')))
        : [h('div', { class: 'empty' }, entries.length ? 'No matches' : 'Nothing here yet. Tap + to add your first entry.')]));
    chipsEl.replaceChildren(...allTags.map((t) =>
      h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(ui.tag === t),
        onclick: () => { ui.tag = ui.tag === t ? null : t; draw(); },
      }, t)));
    chipsEl.hidden = !allTags.length;
  };
  q.addEventListener('input', () => { ui.search = q.value; draw(); });
  draw();

  return [
    header('Old archives', {
      right: [
        iconBtn('key', 'Generator', () => go({ screen: 'generator' })),
        iconBtn('gear', 'Settings', () => go({ screen: 'settings' })),
        iconBtn('lock', 'Lock now', doLock),
      ],
    }),
    h('main', {}, q, chipsEl, listEl),
    h('button', { class: 'fab', type: 'button', 'aria-label': 'Add entry', onclick: () => go({ screen: 'edit', id: null }) }, icon('plus', 30)),
  ];
}

function kv(label, valueNode, actions = []) {
  return h('div', { class: 'kv' }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, valueNode, ...actions));
}

function viewScreen() {
  const e = vault.getEntry(view.id);
  if (!e) { queueMicrotask(back); return h('main'); }
  const rows = [];
  if (e.username) rows.push(kv('Username', h('div', { class: 'txt' }, e.username), [iconBtn('copy', 'Copy username', () => copy(e.username, 'Username'), 'sm')]));
  if (e.password) {
    const txt = h('div', { class: 'txt mono' }, '••••••••••');
    let shown = false;
    const eye = iconBtn('eye', 'Reveal password', () => {
      shown = !shown;
      txt.textContent = shown ? e.password : '••••••••••';
      eye.replaceChildren(icon(shown ? 'eyeOff' : 'eye'));
      eye.setAttribute('aria-label', shown ? 'Hide password' : 'Reveal password');
    }, 'sm');
    rows.push(kv('Password', txt, [eye, iconBtn('copy', 'Copy password', () => copy(e.password, 'Password'), 'sm')]));
  }
  if (e.url) {
    const safe = /^https?:\/\//i.test(e.url);
    rows.push(kv('Website',
      safe ? h('a', { class: 'txt', href: e.url, target: '_blank', rel: 'noopener noreferrer' }, e.url) : h('div', { class: 'txt' }, e.url),
      [iconBtn('copy', 'Copy URL', () => copy(e.url, 'URL'), 'sm')]));
  }
  if (e.notes) rows.push(kv('Notes', h('div', { class: 'txt' }, e.notes)));
  if (e.tags.length) rows.push(kv('Tags', h('div', { class: 'tags' }, e.tags.map((t) => h('span', { class: 'tag' }, t)))));
  rows.push(h('div', { class: 'small muted' }, `Updated ${new Date(e.updated).toLocaleString()}`));
  return [
    header(e.title, { backBtn: true, right: [iconBtn('edit', 'Edit', () => go({ screen: 'edit', id: e.id }))] }),
    h('main', {}, h('div', { class: 'card' }, rows)),
  ];
}

function editScreen() {
  const existing = view.id ? vault.getEntry(view.id) : null;
  const d = existing || { title: '', username: '', password: '', url: '', notes: '', tags: [] };
  const attrs = { autocomplete: 'off', autocapitalize: 'off', spellcheck: false };
  const title = h('input', { type: 'text', value: d.title, autocapitalize: 'words', autocomplete: 'off' });
  const user = h('input', { type: 'text', value: d.username, ...attrs });
  const pass = h('input', { type: 'password', value: d.password, ...attrs });
  const url = h('input', { type: 'url', value: d.url, inputMode: 'url', ...attrs });
  const notes = h('textarea', { value: d.notes });
  const tags = h('input', { type: 'text', value: d.tags.join(', '), placeholder: 'comma, separated', ...attrs });
  const meter = strengthMeter();
  const upd = () => meter.update(pass.value);
  pass.addEventListener('input', upd);
  upd();

  const toggle = iconBtn('eye', 'Show password', () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    toggle.replaceChildren(icon(show ? 'eyeOff' : 'eye'));
  }, 'sm');
  const gen = iconBtn('refresh', 'Generate password', () => {
    sheet((close) => h('div', { class: 'stack' },
      h('h2', {}, 'Generate'),
      generatorPanel((pw) => { pass.value = pw; upd(); close(); })));
  }, 'sm');

  const save = async () => {
    const saved = await vault.saveEntry({
      id: existing?.id, title: title.value, username: user.value, password: pass.value,
      url: url.value, notes: notes.value, tags: tags.value.split(','),
    });
    toast('Saved');
    go({ screen: 'view', id: saved.id }, { replace: true });
  };

  const remove = async () => {
    if (!(await confirmDialog('Delete entry?', `“${existing.title}” will be permanently deleted from this device.`, 'Delete', true))) return;
    await vault.deleteEntry(existing.id);
    toast('Deleted');
    stack = [];
    resetToList();
  };

  return [
    header(existing ? 'Edit entry' : 'New entry', { backBtn: true }),
    h('main', {},
      h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', {}, 'Title'), title),
        h('label', { class: 'field' }, h('span', {}, 'Username / email'), user),
        h('div', {}, h('span', { class: 'small muted' }, 'Password'), h('div', { class: 'with-btn' }, pass, toggle, gen), meter),
        h('label', { class: 'field' }, h('span', {}, 'Website'), url),
        h('label', { class: 'field' }, h('span', {}, 'Notes'), notes),
        h('label', { class: 'field' }, h('span', {}, 'Tags'), tags),
        h('button', { class: 'btn', type: 'button', onclick: save }, 'Save'),
        existing && h('button', { class: 'btn ghost danger-text', type: 'button', onclick: remove }, 'Delete entry'))),
  ];
}

// ---- generator -------------------------------------------------------------------------------
const GEN_KEY = 'oa.gen';
function loadGenPrefs() {
  const def = { mode: 'password', length: 20, lower: true, upper: true, digits: true, symbols: true, words: 5, capitalize: false, number: false, separator: '-' };
  try { return { ...def, ...JSON.parse(localStorage.getItem(GEN_KEY) || '{}') }; } catch { return def; }
}

function generatorPanel(onUse) {
  const p = loadGenPrefs();
  const out = h('div', { class: 'gen-out mono' });
  const opts = h('div');
  let current = '';
  const regen = () => {
    current = p.mode === 'password'
      ? generatePassword(p)
      : generatePassphrase({ words: p.words, separator: p.separator, capitalize: p.capitalize, number: p.number });
    out.textContent = current;
    try { localStorage.setItem(GEN_KEY, JSON.stringify(p)); } catch { /* ignore */ }
  };
  const check = (key, label) => {
    const c = h('input', { type: 'checkbox', checked: p[key] });
    c.addEventListener('change', () => { p[key] = c.checked; regen(); });
    return h('label', { class: 'opt' }, h('span', {}, label), c);
  };
  const slider = (key, label, min, max) => {
    const val = h('strong', {}, String(p[key]));
    const r = h('input', { type: 'range', min, max, value: p[key] });
    r.addEventListener('input', () => { p[key] = +r.value; val.textContent = r.value; regen(); });
    return h('label', { class: 'opt' }, h('span', {}, label, ' ', val), r);
  };
  const drawOpts = () => {
    opts.replaceChildren(...(p.mode === 'password'
      ? [slider('length', 'Length', 8, 64), check('upper', 'Uppercase A–Z'), check('lower', 'Lowercase a–z'), check('digits', 'Digits 0–9'), check('symbols', 'Symbols !@#')]
      : [slider('words', 'Words', 3, 10), check('capitalize', 'Capitalise words'), check('number', 'Add a digit')]));
  };
  const seg = h('div', { class: 'seg' },
    ...[['password', 'Password'], ['passphrase', 'Passphrase']].map(([m, label]) =>
      h('button', {
        type: 'button', 'aria-pressed': String(p.mode === m),
        onclick: (e) => {
          p.mode = m;
          seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
          drawOpts(); regen();
        },
      }, label)));
  drawOpts();
  regen();
  return h('div', { class: 'stack' },
    seg, out, opts,
    h('div', { class: 'row' },
      h('button', { class: 'btn secondary', type: 'button', onclick: regen }, 'Regenerate'),
      h('button', { class: 'btn secondary', type: 'button', onclick: () => copy(current, 'Password') }, 'Copy')),
    onUse && h('button', { class: 'btn', type: 'button', onclick: () => onUse(current) }, 'Use this password'));
}

function generatorScreen() {
  return [header('Generator', { backBtn: true }), h('main', {}, generatorPanel(null))];
}

// ---- settings --------------------------------------------------------------------------------
function settingsScreen() {
  const wrap = h('main', { class: 'stack' });
  (async () => {
    const s = await vault.getSettings();
    const sel = h('select', {}, ...[1, 2, 5, 10, 15].map((m) => h('option', { value: m, selected: m === s.autoLockMin }, `${m} minute${m > 1 ? 's' : ''}`)));
    sel.addEventListener('change', async () => {
      await vault.setSettings({ autoLockMin: +sel.value });
      idleMs = +sel.value * 60_000;
      armIdle();
      toast('Auto-lock updated');
    });

    const exportBackup = async () => {
      const blob = new Blob([JSON.stringify(await vault.exportBackup())], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `oa-backup-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      await vault.setSettings({ lastExport: Date.now() });
      toast('Encrypted backup saved to Downloads');
      go({ screen: 'settings' }, { replace: true });
    };

    const doImport = async () => {
      if (!(await confirmDialog('Replace vault?', 'This replaces everything in this vault with the contents of a backup file. Export a backup first if you are unsure.', 'Choose file', true))) return;
      if (await restoreFlow()) { toast('Backup restored'); resetToList(); }
    };

    const bioCard = h('div', { class: 'card stack' }, h('h2', {}, 'Fingerprint unlock'));
    if (!bio.bioSupported()) {
      bioCard.append(h('div', { class: 'small muted' }, 'Not available in this browser.'));
    } else if (await bio.isEnrolled()) {
      bioCard.append(
        h('div', { class: 'small muted' }, 'On. Your master password is still required every 3 days.'),
        h('button', {
          class: 'btn ghost', type: 'button',
          onclick: async () => { await bio.disable(); toast('Fingerprint unlock turned off'); go({ screen: 'settings' }, { replace: true }); },
        }, 'Turn off'));
    } else {
      bioCard.append(
        h('div', { class: 'small muted' }, 'Unlock with your fingerprint. You will be asked to touch the sensor twice while setting it up.'),
        h('button', {
          class: 'btn secondary', type: 'button',
          onclick: async () => {
            suppressLock = true;
            const raw = vault.getVaultKeyRaw();
            try {
              await bio.enroll(raw);
              toast('Fingerprint unlock is on');
            } catch (e) {
              toast(e.message || 'Could not set up fingerprint');
            } finally {
              raw.fill(0);
              suppressLock = false;
              armIdle();
            }
            if (vault.isUnlocked()) go({ screen: 'settings' }, { replace: true });
          },
        }, 'Turn on fingerprint unlock'));
    }

    wrap.replaceChildren(
      h('div', { class: 'card stack' },
        h('h2', {}, 'Security'),
        h('label', { class: 'field' }, h('span', {}, 'Auto-lock after inactivity'), sel),
        h('div', { class: 'small muted' }, 'The vault also locks the moment the app goes to the background.'),
        h('button', { class: 'btn secondary', type: 'button', onclick: changePasswordSheet }, 'Change master password')),
      bioCard,
      h('div', { class: 'card stack' },
        h('h2', {}, 'Backup'),
        h('div', { class: 'small muted' }, s.lastExport ? `Last manual export: ${new Date(s.lastExport).toLocaleString()}` : 'No backup exported yet.'),
        h('button', { class: 'btn secondary', type: 'button', onclick: exportBackup }, 'Export encrypted backup'),
        h('button', { class: 'btn ghost', type: 'button', onclick: doImport }, 'Import backup (replaces vault)'),
        h('div', { class: 'small muted' }, 'Backups stay encrypted with your master password.')),
      h('div', { class: 'small muted' }, `Old archives v${version} · ${vault.listEntries().length} entries`));
  })();
  return [header('Settings', { backBtn: true }), wrap];
}

function changePasswordSheet() {
  sheet((close) => {
    const cur = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Current master password' });
    const n1 = h('input', { type: 'password', autocomplete: 'off', placeholder: 'New master password (12+ chars)' });
    const n2 = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Repeat new password' });
    const meter = strengthMeter();
    const err = h('div', { class: 'error' });
    const btn = h('button', { class: 'btn', type: 'button' }, 'Change password');
    n1.addEventListener('input', () => meter.update(n1.value));
    btn.addEventListener('click', async () => {
      err.textContent = '';
      if (n1.value.length < 12 || strengthLabel(estimateBits(n1.value)).level < 1) { err.textContent = 'New password is too weak'; return; }
      if (n1.value !== n2.value) { err.textContent = 'New passwords do not match'; return; }
      btn.disabled = true; btn.textContent = 'Working…';
      try {
        await vault.changeMasterPassword(cur.value, n1.value);
        close();
        toast('Master password changed');
      } catch (e) {
        err.textContent = e.name === 'DecryptError' ? 'Current password is wrong' : e.message;
        btn.disabled = false; btn.textContent = 'Change password';
      }
    });
    return h('div', { class: 'stack' },
      h('h2', {}, 'Change master password'),
      h('div', { class: 'warn' }, 'The new password cannot be recovered either.'),
      cur, n1, meter, n2, err,
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: close }, 'Cancel'), btn));
  });
}

// ---------------------------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------------------------
async function render() {
  const screens = {
    setup: setupScreen, lock: lockScreen, list: listScreen, view: viewScreen,
    edit: editScreen, generator: generatorScreen, settings: settingsScreen,
  };
  if (view.screen !== 'lock') lockAuto = null;
  document.body.classList.toggle('is-lock', view.screen === 'lock' || view.screen === 'setup');
  const fn = screens[view.screen];
  app.replaceChildren(...(fn ? [fn()].flat() : []));
  window.scrollTo(0, 0);
}

async function boot() {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  view = { screen: (await vault.isInitialised()) ? 'lock' : 'setup' };
  render();
}
boot();
