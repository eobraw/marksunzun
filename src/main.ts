import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import './style.css';

type DocumentData = { path: string; name: string; html: string; words: number; root: string };
type Entry = { path: string; name: string; is_dir: boolean };
type Directory = { path: string; root: string; entries: Entry[] };
type Heading = { id: string; text: string; level: number };

const icons: Record<string, string> = {
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4z"/><path d="M13 7a3 3 0 0 1 3-3h5v14h-4a4 4 0 0 0-4 3"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  root: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<path d="m12 3 10 18H2zM12 9v5m0 3v.1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const icon = (name: string, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? ''}</svg>`;
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <aside class="sidebar" aria-label="File browser">
    <div class="brand"><span class="brand-symbol">${icon('book')}</span><span>MarkSunzun<span class="brand-dot">.</span></span><button class="icon-button sidebar-close" id="close-sidebar" aria-label="Close sidebar">${icon('close')}</button></div>
    <div class="workspace-label">YOUR READING ROOM</div>
    <div class="open-actions"><button class="button button-primary" id="open-file">${icon('file')}<span>Open a file</span><kbd class="open-shortcut"></kbd></button><button class="button button-secondary" id="open-folder">${icon('folder')}<span>Open a folder</span></button></div>
    <div class="browser-heading"><span>EXPLORER</span><div><button class="icon-button" id="folder-root" aria-label="Go to root folder" title="Root folder" disabled>${icon('root')}</button><button class="icon-button" id="folder-up" aria-label="Go to parent folder" title="Parent folder" disabled>${icon('up')}</button></div></div>
    <div class="folder-location" id="folder-location" title="No folder open">No folder open</div>
    <label class="file-filter">${icon('search')}<input id="file-filter" type="search" placeholder="Filter files…" aria-label="Filter files" autocomplete="off" spellcheck="false" /></label>
    <nav class="file-list" id="file-list" aria-label="Files and folders"><div class="browser-empty">A place for your notes,<br />ideas, and everything between.<span>Open a folder to explore.</span></div></nav>
    <div class="sidebar-footer"><span class="local-dot"></span> Local files. A quieter space.</div>
  </aside>
  <button class="sidebar-scrim" id="sidebar-scrim" aria-label="Close file browser" tabindex="-1"></button>
  <main class="workspace" id="workspace">
    <header class="toolbar"><div class="toolbar-start"><button class="icon-button" id="toggle-sidebar" aria-label="Toggle file browser" aria-expanded="true" title="Toggle sidebar">${icon('panel')}</button><span class="toolbar-divider"></span><div class="breadcrumb" id="breadcrumb"><span class="breadcrumb-home">Your reading room</span></div></div><div class="toolbar-end"><span class="file-type" id="file-type" hidden>MARKDOWN</span><button class="icon-button" id="toggle-find" aria-label="Find in document" aria-expanded="false" title="Find in document" disabled>${icon('search')}</button><button class="icon-button theme-toggle" id="toggle-theme" aria-label="Switch to dark mode" title="Switch to dark mode">${icon('moon')}<span>Dark mode</span></button></div></header>
    <section class="find-bar" id="find-bar" aria-label="Find in document" hidden><label class="find-field">${icon('search')}<input type="search" id="find-input" placeholder="Find in document…" aria-label="Find in document" autocomplete="off" spellcheck="false" /></label><span id="find-count" class="find-count" role="status" aria-live="polite">Type to search</span><button class="icon-button" id="find-previous" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled>${icon('up')}</button><button class="icon-button" id="find-next" aria-label="Next match" title="Next match (Enter)" disabled>${icon('down')}</button><button class="icon-button" id="close-find" aria-label="Close find" title="Close (Escape)">${icon('close')}</button></section>
    <div class="notice" id="notice" role="alert" hidden><span>${icon('alert')}</span><p id="notice-text"></p><button class="icon-button" id="dismiss-notice" aria-label="Dismiss message">${icon('close')}</button></div>
    <div class="reading-layout">
      <div class="reading-scroll" id="reading-scroll" tabindex="0" aria-label="Document reading area">
        <section class="welcome" id="welcome" aria-labelledby="welcome-title"><div class="welcome-eyebrow"><span></span> A LITTLE ROOM TO READ</div><div class="welcome-mark">${icon('book')}</div><h1 id="welcome-title">Less noise.<br /><em>More meaning.</em></h1><p class="welcome-description">A thoughtful home for your Markdown.<br />Open a document, settle in, and let the words lead.</p><button class="button welcome-open" id="welcome-open">${icon('file')} Open a document ${icon('arrow')}</button><div class="welcome-alternative">or <button id="welcome-folder">explore a folder</button></div><div class="welcome-features"><div><span class="feature-number">01</span><strong>Just your words</strong><p>Beautiful type. Room to think.</p></div><div><span class="feature-number">02</span><strong>Always in sync</strong><p>Edit elsewhere. Read it here.</p></div><div><span class="feature-number">03</span><strong>Entirely local</strong><p>Your files stay yours.</p></div></div><div class="welcome-shortcuts"><span><kbd class="shortcut-open"></kbd> Open file</span><span><kbd class="shortcut-find"></kbd> Find anything</span></div></section>
        <article class="document" id="document" aria-label="Markdown document" hidden><div class="document-eyebrow"><span class="document-label">MARKDOWN /</span><span id="document-name"></span></div><div class="markdown" id="markdown"></div><div class="document-end"><span></span>${icon('book')}<span></span></div></article>
      </div>
      <aside class="outline" id="outline" aria-label="Document outline" hidden><div class="outline-label">ON THIS PAGE</div><nav id="outline-links" aria-label="Headings"></nav><div class="outline-footer">A little clarity goes a long way.</div></aside>
    </div>
    <footer class="statusbar"><div class="status-left"><span class="status-mark">${icon('book')}</span><span id="word-count">Ready when you are</span><span class="status-separator" id="reading-separator" hidden>·</span><span id="reading-time"></span></div><div class="status-right"><span id="live-state" role="status" aria-live="polite"><span class="live-dot"></span> All local</span><span class="status-app">MARKSUNZUN</span></div></footer>
  </main>`;

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const markdown = el('markdown');
const scrollArea = el('reading-scroll');
const findInput = el<HTMLInputElement>('find-input');
const filterInput = el<HTMLInputElement>('file-filter');
const platformMod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
document.querySelectorAll('.open-shortcut, .shortcut-open').forEach((node) => { node.textContent = `${platformMod} O`; });
document.querySelectorAll('.shortcut-find').forEach((node) => { node.textContent = `${platformMod} F`; });

let current: DocumentData | null = null;
let directory: Directory | null = null;
let headings: Heading[] = [];
let contentVersion = 0;
let documentVersion = 0;
let directoryVersion = 0;
let loading = false;
let folderLoading = false;
let matches: HTMLElement[][] = [];
let matchIndex = -1;
let findOpen = false;
let findTimer: number | undefined;
let reloadTimer: number | undefined;
let headingObserver: IntersectionObserver | null = null;
let watchReady = false;
let theme: 'light' | 'dark' = 'dark';
try { theme = localStorage.getItem('marksunzun-theme') === 'light' ? 'light' : 'dark'; } catch { /* Storage may be unavailable in a restricted webview. */ }

function setTheme(next: 'light' | 'dark') {
  theme = next;
  document.documentElement.dataset.theme = theme;
  const nextMode = theme === 'dark' ? 'light' : 'dark';
  const toggle = el('toggle-theme');
  toggle.innerHTML = `${icon(nextMode === 'light' ? 'sun' : 'moon')}<span>${nextMode === 'light' ? 'Light' : 'Dark'} mode</span>`;
  toggle.setAttribute('aria-label', `Switch to ${nextMode} mode`);
  toggle.title = `Switch to ${nextMode} mode`;
  try { localStorage.setItem('marksunzun-theme', theme); } catch { /* Reading works without preference storage. */ }
}
setTheme(theme);

function errorMessage(error: unknown) { return typeof error === 'string' ? error : error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
function showError(error: unknown) { el('notice-text').textContent = errorMessage(error); el('notice').hidden = false; }
function clearError() { el('notice').hidden = true; }
function setLive(text: string, state: 'live' | 'busy' | 'error' | 'idle' = 'live') {
  const node = el('live-state');
  node.replaceChildren();
  const dot = document.createElement('span');
  dot.className = `live-dot ${state}`;
  node.append(dot, document.createTextNode(` ${text}`));
}
function setLoading(value: boolean) {
  loading = value;
  app.classList.toggle('is-loading', value);
  for (const id of ['open-file', 'open-folder', 'welcome-open', 'welcome-folder']) el<HTMLButtonElement>(id).disabled = value;
  if (value) setLive('Opening…', 'busy');
  else setLive(current ? (watchReady ? 'Live updates' : 'Updates unavailable') : 'All local', current && !watchReady ? 'error' : current ? 'live' : 'idle');
}
function basename(path: string) { return path.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || path; }
function parentPath(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  if (cut <= 0) return path.startsWith('\\') ? '\\' : '/';
  const parent = path.slice(0, cut);
  return parent.endsWith(':') ? `${parent}${path[cut]}` : parent;
}
function isWithin(path: string, root: string) {
  let normalizedPath = path.replace(/\\/g, '/').replace(/\/$/, '');
  let normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (/^(?:[a-z]:|\/\/)/i.test(normalizedRoot)) { normalizedPath = normalizedPath.toLowerCase(); normalizedRoot = normalizedRoot.toLowerCase(); }
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}
function resolvePath(base: string, target: string) {
  const normalized = target.replace(/\\/g, '/');
  const absolute = normalized.startsWith('/') || /^[a-z]:\//i.test(normalized);
  const source = (absolute ? normalized : `${parentPath(base)}/${normalized}`).replace(/\\/g, '/');
  const prefix = source.startsWith('//') ? '//' : source.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of source.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (parts.length && !/^[a-z]:$/i.test(parts[parts.length - 1])) parts.pop(); }
    else parts.push(part);
  }
  const resolved = prefix + parts.join('/');
  return base.includes('\\') ? resolved.replace(/\//g, '\\') : resolved;
}

function setSidebar(open: boolean) {
  app.classList.toggle('sidebar-hidden', !open);
  app.classList.toggle('sidebar-open', open);
  el('toggle-sidebar').setAttribute('aria-expanded', String(open));
}
if (window.matchMedia('(max-width: 850px)').matches) setSidebar(false);
function closeMobileSidebar() { if (window.matchMedia('(max-width: 850px)').matches) setSidebar(false); }

function renderDirectory() {
  const list = el('file-list');
  list.replaceChildren();
  const location = el('folder-location');
  location.textContent = directory ? basename(directory.path) : 'No folder open';
  location.title = directory?.path ?? 'No folder open';
  el<HTMLButtonElement>('folder-up').disabled = !directory || directory.path === directory.root || folderLoading;
  el<HTMLButtonElement>('folder-root').disabled = !directory || directory.path === directory.root || folderLoading;
  filterInput.disabled = !directory;
  if (!directory) {
    const message = document.createElement('div'); message.className = 'browser-empty';
    message.textContent = 'Open a folder to browse your Markdown files.'; list.append(message); return;
  }
  const filter = filterInput.value.trim().toLocaleLowerCase();
  const entries = directory.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(filter));
  if (entries.length === 0) {
    const message = document.createElement('div'); message.className = 'browser-empty';
    message.textContent = filter ? 'No matching files or folders.' : 'No Markdown files here. Try another folder.'; list.append(message);
  }
  for (const entry of entries) {
    const button = document.createElement('button');
    button.className = `file-entry${entry.is_dir ? ' is-folder' : ''}${entry.path === current?.path ? ' is-active' : ''}`;
    button.title = entry.path;
    if (entry.path === current?.path) button.setAttribute('aria-current', 'page');
    button.innerHTML = icon(entry.is_dir ? 'folder' : 'file');
    const label = document.createElement('span'); label.textContent = entry.name; button.append(label);
    if (entry.is_dir) { const chevron = document.createElement('span'); chevron.className = 'entry-chevron'; chevron.innerHTML = icon('right'); button.append(chevron); }
    button.addEventListener('click', () => { if (loading) return; if (entry.is_dir) void loadDirectory(entry.path); else void openDocument(entry.path); });
    list.append(button);
  }
}
async function loadDirectory(path: string, resetFilter = true) {
  const version = ++directoryVersion;
  folderLoading = true;
  el('file-list').setAttribute('aria-busy', 'true');
  try {
    const result = await invoke<Directory>('list_directory', { path });
    if (version !== directoryVersion) return;
    directory = result;
    if (resetFilter) filterInput.value = '';
    renderDirectory();
  } catch (error) { if (version === directoryVersion) showError(error); }
  finally {
    if (version === directoryVersion) { folderLoading = false; el('file-list').removeAttribute('aria-busy'); renderDirectory(); }
  }
}

// Strip navigable resources before the sanitized fragment ever reaches the document.
// Keeping the original target only as data lets every link/image pass through the backend.
DOMPurify.addHook('uponSanitizeElement', (node) => {
  if (!(node instanceof Element)) return;
  if (node.tagName === 'IMG') {
    const source = node.getAttribute('src');
    node.removeAttribute('src'); node.removeAttribute('srcset');
    if (source !== null) node.setAttribute('data-marksunzun-image', source);
  }
  if (node.tagName === 'A') {
    const href = node.getAttribute('href');
    node.removeAttribute('href'); node.removeAttribute('target'); node.removeAttribute('download');
    if (href !== null) node.setAttribute('data-marksunzun-link', href);
  }
});
function slug(text: string) {
  return text.toLocaleLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-') || 'section';
}
function prepareMarkdown(html: string) {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'video', 'audio', 'source', 'link', 'meta', 'svg', 'math'],
    FORBID_ATTR: ['style', 'src', 'srcset', 'action', 'formaction', 'autofocus', 'contenteditable'],
    ALLOW_DATA_ATTR: true,
  });
  for (const input of fragment.querySelectorAll('input')) {
    if (input.type === 'checkbox') { input.disabled = true; input.tabIndex = -1; }
    else input.remove();
  }
  const ids = new Set<string>();
  fragment.querySelectorAll('[id]').forEach((node) => { if (!/^H[1-6]$/.test(node.tagName)) ids.add(node.id); });
  headings = [];
  fragment.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach((heading) => {
    const text = heading.textContent?.trim() || 'Untitled section';
    const base = slug(text);
    let id = base; let duplicate = 1;
    while (ids.has(id) || (document.getElementById(id) && !markdown.contains(document.getElementById(id)))) id = `${base}-${duplicate++}`;
    ids.add(id); heading.id = id;
    headings.push({ id, text, level: Number(heading.tagName[1]) });
  });
  fragment.querySelectorAll<HTMLAnchorElement>('a').forEach((anchor) => {
    if (anchor.dataset.marksunzunLink !== undefined) { anchor.href = '#'; anchor.title = anchor.dataset.marksunzunLink; }
    anchor.removeAttribute('ping'); anchor.removeAttribute('target'); anchor.removeAttribute('download');
  });
  fragment.querySelectorAll<HTMLElement>('pre code').forEach((code) => {
    const language = [...code.classList].find((name) => name.startsWith('language-'))?.slice(9);
    if (language && hljs.getLanguage(language)) {
      code.innerHTML = hljs.highlight(code.textContent ?? '', { language, ignoreIllegals: true }).value;
      code.classList.add('hljs');
    } else { code.classList.add('hljs'); }
  });
  return fragment;
}
async function loadImages(documentPath: string, version: number) {
  const images = [...markdown.querySelectorAll<HTMLImageElement>('img')];
  // Bound concurrent IPC work for image-heavy documents.
  let cursor = 0;
  async function worker() {
    while (cursor < images.length) {
      const image = images[cursor++];
      if (version !== contentVersion) return;
      const source = image.dataset.marksunzunImage ?? '';
      image.classList.add('document-image');
      image.loading = 'lazy'; image.decoding = 'async';
      if (!source || (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source) && !/^[a-z]:[\\/]/i.test(source))) {
        image.classList.add('image-unavailable');
        image.title = 'Remote and embedded images are not loaded. Only local document images are allowed.';
        image.alt = `${image.alt || 'Image'} — external image blocked`;
        continue;
      }
      try {
        const data = await invoke<string>('read_image', { documentPath, source });
        if (version !== contentVersion || !image.isConnected) return;
        if (!/^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,/i.test(data)) throw new Error('Unsupported image format.');
        image.src = data;
        image.addEventListener('error', () => { image.classList.add('image-unavailable'); image.title = 'This image could not be decoded.'; image.alt = `${image.alt || 'Image'} — unable to display`; }, { once: true });
      } catch (error) {
        if (version !== contentVersion) return;
        image.classList.add('image-unavailable'); image.title = errorMessage(error);
        image.alt = `${image.alt || 'Image'} — unavailable`;
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
}
function renderOutline() {
  const container = el('outline-links'); container.replaceChildren();
  el('outline').hidden = headings.length === 0;
  const minLevel = headings.reduce((level, heading) => Math.min(level, heading.level), 6);
  for (const heading of headings) {
    const button = document.createElement('button');
    button.className = 'outline-link'; button.textContent = heading.text; button.title = heading.text;
    button.style.setProperty('--depth', String(Math.min(heading.level - minLevel, 3)));
    button.dataset.heading = heading.id;
    button.addEventListener('click', () => jumpToAnchor(heading.id));
    container.append(button);
  }
  headingObserver?.disconnect();
  headingObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible[0]) setActiveHeading((visible[0].target as HTMLElement).id);
  }, { root: scrollArea, rootMargin: '0px 0px -65% 0px', threshold: 0 });
  markdown.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading) => headingObserver!.observe(heading));
  if (headings[0]) setActiveHeading(headings[0].id);
}
function setActiveHeading(id: string) {
  el('outline-links').querySelectorAll<HTMLElement>('.outline-link').forEach((button) => {
    const active = button.dataset.heading === id;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current');
  });
}
function jumpToAnchor(anchor: string) {
  let decoded = anchor;
  try { decoded = decodeURIComponent(anchor); } catch { /* Match a literal malformed fragment if present. */ }
  const target = [...markdown.querySelectorAll<HTMLElement>('[id]')].find((node) => node.id === decoded)
    ?? [...markdown.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')].find((node) => slug(node.textContent ?? '') === slug(decoded));
  if (!decoded) { scrollArea.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); target.tabIndex = -1; target.focus({ preventScroll: true }); setActiveHeading(target.id); }
  else showError(`The section “${decoded}” was not found in this document.`);
}
function updateDocumentChrome() {
  const hasDocument = current !== null;
  el('welcome').hidden = hasDocument;
  el('document').hidden = !hasDocument;
  el('file-type').hidden = !hasDocument;
  el<HTMLButtonElement>('toggle-find').disabled = !hasDocument;
  el('reading-separator').hidden = !hasDocument;
  const crumb = el('breadcrumb'); crumb.replaceChildren();
  if (current) {
    const folder = document.createElement('span'); folder.className = 'breadcrumb-home'; folder.textContent = basename(parentPath(current.path));
    const arrow = document.createElement('span'); arrow.innerHTML = icon('right');
    const file = document.createElement('span'); file.className = 'breadcrumb-file'; file.textContent = current.name;
    crumb.append(folder, arrow, file); crumb.title = current.path;
    el('document-name').textContent = current.name;
    el('word-count').textContent = `${current.words.toLocaleString()} ${current.words === 1 ? 'word' : 'words'}`;
    el('reading-time').textContent = `${Math.max(1, Math.ceil(current.words / 220))} min read`;
    document.title = `${current.name} — MarkSunzun`;
  } else {
    crumb.textContent = 'Your reading room'; crumb.removeAttribute('title');
    el('word-count').textContent = 'Ready when you are'; el('reading-time').textContent = '';
    el('outline').hidden = true; document.title = 'MarkSunzun — A little room to read';
  }
}
function commitDocument(result: DocumentData, version: number, preserveScroll: boolean, anchor?: string) {
  const previousScroll = preserveScroll ? scrollArea.scrollTop : 0;
  const fragment = prepareMarkdown(result.html);
  const renderedVersion = ++contentVersion;
  current = result;
  matches = []; matchIndex = -1;
  markdown.replaceChildren(fragment);
  if (!markdown.textContent?.trim() && !markdown.querySelector('img,hr,table')) {
    const empty = document.createElement('p'); empty.className = 'empty-document'; empty.textContent = 'A blank page. There’s room for something good here.'; markdown.append(empty);
  }
  updateDocumentChrome(); renderOutline(); renderDirectory();
  if (findOpen) performFind(false);
  scrollArea.scrollTop = previousScroll;
  if (anchor !== undefined) requestAnimationFrame(() => { if (version === documentVersion) jumpToAnchor(anchor); });
  void loadImages(result.path, renderedVersion);
}
async function openDocument(path: string, options: { preserveScroll?: boolean; anchor?: string; live?: boolean } = {}) {
  if (loading && !options.live) return;
  const version = ++documentVersion;
  setLoading(true);
  if (!options.live) clearError();
  try {
    const result = await invoke<DocumentData>('read_document', { path });
    if (version !== documentVersion) return;
    commitDocument(result, version, !!options.preserveScroll, options.anchor);
    clearError();
    if (!options.live) { closeMobileSidebar(); void loadDirectory(parentPath(result.path)); }
  } catch (error) {
    if (version === documentVersion) { showError(error); }
  } finally { if (version === documentVersion) { setLoading(false); if (!el('notice').hidden && options.live) setLive('Reload failed', 'error'); } }
}
async function pickFile() {
  if (loading) return;
  const version = ++documentVersion; setLoading(true); clearError();
  try {
    const result = await invoke<DocumentData | null>('pick_file');
    if (version !== documentVersion || !result) return;
    commitDocument(result, version, false);
    closeMobileSidebar(); void loadDirectory(parentPath(result.path));
  } catch (error) { if (version === documentVersion) showError(error); }
  finally { if (version === documentVersion) setLoading(false); }
}
async function pickFolder() {
  if (loading) return;
  const version = ++documentVersion; setLoading(true); clearError();
  const folderVersion = ++directoryVersion;
  folderLoading = false; el('file-list').removeAttribute('aria-busy'); renderDirectory();
  try {
    const result = await invoke<Directory | null>('pick_folder');
    if (version !== documentVersion || !result) return;
    if (current && !isWithin(current.path, result.root)) {
      current = null; ++contentVersion; markdown.replaceChildren(); headings = []; headingObserver?.disconnect(); closeFind(); updateDocumentChrome();
    }
    if (folderVersion === directoryVersion) { directory = result; filterInput.value = ''; renderDirectory(); }
    setSidebar(true);
  } catch (error) { if (version === documentVersion) showError(error); }
  finally { if (version === documentVersion) setLoading(false); }
}

function clearMatches() {
  for (const mark of markdown.querySelectorAll('mark[data-find-match]')) mark.replaceWith(...mark.childNodes);
  markdown.normalize(); matches = []; matchIndex = -1;
}
function updateFindStatus() {
  el('find-count').textContent = !findInput.value ? 'Type to search' : matches.length ? `${matchIndex + 1} of ${matches.length}` : 'No matches';
  el<HTMLButtonElement>('find-previous').disabled = matches.length === 0;
  el<HTMLButtonElement>('find-next').disabled = matches.length === 0;
}
function performFind(scroll = true) {
  clearMatches();
  if (!findInput.value) { updateFindStatus(); return; }
  const query = new RegExp(findInput.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const walker = document.createTreeWalker(markdown, NodeFilter.SHOW_TEXT, {
    acceptNode(node) { return node.parentElement?.closest('script,style,.empty-document') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
  });
  const groups: { owner: Element; nodes: Text[]; text: string }[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const owner = node.parentElement?.closest('p,h1,h2,h3,h4,h5,h6,li,pre,td,th,blockquote') ?? markdown;
    let group = groups[groups.length - 1];
    if (!group || group.owner !== owner) { group = { owner, nodes: [], text: '' }; groups.push(group); }
    group.nodes.push(node); group.text += node.data;
  }
  for (const group of groups) {
    const hits: { start: number; end: number; marks: HTMLElement[] }[] = [];
    query.lastIndex = 0;
    let found: RegExpExecArray | null;
    while ((found = query.exec(group.text)) !== null) hits.push({ start: found.index, end: found.index + found[0].length, marks: [] });
    if (!hits.length) continue;
    let offset = 0;
    let hitIndex = 0;
    for (const node of group.nodes) {
      const end = offset + node.length;
      while (hitIndex < hits.length && hits[hitIndex].end <= offset) hitIndex++;
      const fragment = document.createDocumentFragment();
      let position = 0;
      for (let index = hitIndex; index < hits.length && hits[index].start < end; index++) {
        const hit = hits[index];
        const start = Math.max(0, hit.start - offset);
        const stop = Math.min(node.length, hit.end - offset);
        fragment.append(document.createTextNode(node.data.slice(position, start)));
        const mark = document.createElement('mark'); mark.dataset.findMatch = ''; mark.textContent = node.data.slice(start, stop);
        fragment.append(mark); hit.marks.push(mark); position = stop;
      }
      if (position) { fragment.append(document.createTextNode(node.data.slice(position))); node.replaceWith(fragment); }
      offset = end;
    }
    for (const hit of hits) matches.push(hit.marks);
  }
  if (matches.length) {
    matchIndex = 0; matches[0].forEach((mark) => mark.classList.add('current-match'));
    if (scroll) matches[0][0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  updateFindStatus();
}
function moveFind(direction: number) {
  if (findTimer) { clearTimeout(findTimer); findTimer = undefined; performFind(false); }
  if (!matches.length) return;
  matches[matchIndex]?.forEach((mark) => mark.classList.remove('current-match'));
  matchIndex = (matchIndex + direction + matches.length) % matches.length;
  matches[matchIndex].forEach((mark) => mark.classList.add('current-match'));
  matches[matchIndex][0].scrollIntoView({ behavior: 'smooth', block: 'center' }); updateFindStatus();
}
function openFind() {
  if (!current) return;
  findOpen = true; el('find-bar').hidden = false; el('toggle-find').setAttribute('aria-expanded', 'true');
  findInput.focus(); findInput.select();
}
function closeFind() {
  clearTimeout(findTimer);
  findTimer = undefined; findOpen = false; el('find-bar').hidden = true; el('toggle-find').setAttribute('aria-expanded', 'false');
  clearMatches(); updateFindStatus();
}

async function followLink(source: string) {
  if (!current) return;
  const target = source.trim();
  if (/^https?:\/\//i.test(target)) {
    try { await invoke('open_external', { url: target }); } catch (error) { showError(error); }
    return;
  }
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) { showError('Only local Markdown files and http/https links can be opened.'); return; }
  if (target.startsWith('#')) { jumpToAnchor(target.slice(1)); return; }
  const hash = target.indexOf('#');
  const rawPath = (hash === -1 ? target : target.slice(0, hash)).split('?')[0];
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); } catch { showError('This link contains an invalid encoded path.'); return; }
  if (!decoded) { if (hash !== -1) jumpToAnchor(target.slice(hash + 1)); return; }
  const path = resolvePath(current.path, decoded);
  if (path.replace(/\\/g, '/') === current.path.replace(/\\/g, '/')) { jumpToAnchor(hash === -1 ? '' : target.slice(hash + 1)); return; }
  await openDocument(path, { anchor: hash === -1 ? undefined : target.slice(hash + 1) });
}
markdown.addEventListener('click', (event) => {
  const anchor = (event.target as Element).closest<HTMLAnchorElement>('a');
  if (!anchor) return; event.preventDefault();
  if (anchor.dataset.marksunzunLink !== undefined) void followLink(anchor.dataset.marksunzunLink);
});
markdown.addEventListener('auxclick', (event) => { if ((event.target as Element).closest('a')) event.preventDefault(); });

for (const id of ['open-file', 'welcome-open']) el(id).addEventListener('click', () => void pickFile());
for (const id of ['open-folder', 'welcome-folder']) el(id).addEventListener('click', () => void pickFolder());
el('toggle-sidebar').addEventListener('click', () => setSidebar(app.classList.contains('sidebar-hidden')));
for (const id of ['close-sidebar', 'sidebar-scrim']) el(id).addEventListener('click', () => setSidebar(false));
el('toggle-theme').addEventListener('click', () => setTheme(theme === 'light' ? 'dark' : 'light'));
el('toggle-find').addEventListener('click', () => { if (findOpen) { closeFind(); el('toggle-find').focus(); } else openFind(); });
el('close-find').addEventListener('click', () => { closeFind(); el('toggle-find').focus(); });
el('find-previous').addEventListener('click', () => moveFind(-1));
el('find-next').addEventListener('click', () => moveFind(1));
el('dismiss-notice').addEventListener('click', clearError);
filterInput.addEventListener('input', renderDirectory);
findInput.addEventListener('input', () => { clearTimeout(findTimer); findTimer = window.setTimeout(() => { findTimer = undefined; performFind(); }, 120); });
findInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); moveFind(event.shiftKey ? -1 : 1); } });
el('folder-up').addEventListener('click', () => { if (!loading && directory && directory.path !== directory.root) void loadDirectory(parentPath(directory.path)); });
el('folder-root').addEventListener('click', () => { if (!loading && directory) void loadDirectory(directory.root); });
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    if (event.key.toLowerCase() === 'o') { event.preventDefault(); if (event.shiftKey) void pickFolder(); else void pickFile(); }
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); openFind(); }
  }
  if (event.key === 'Escape') {
    if (findOpen) { closeFind(); el('toggle-find').focus(); }
    else if (window.matchMedia('(max-width: 850px)').matches) setSidebar(false);
  }
});

async function initialize() {
  const version = ++documentVersion; setLoading(true);
  let watchError: unknown;
  try {
    const unlisten = await listen<string>('document-changed', (event) => {
      if (!current || event.payload !== current.path) return;
      clearTimeout(reloadTimer);
      const path = event.payload;
      const reload = () => {
        if (current?.path !== path) return;
        if (loading) { reloadTimer = window.setTimeout(reload, 180); return; }
        void openDocument(path, { preserveScroll: true, live: true });
      };
      reloadTimer = window.setTimeout(reload, 180);
    });
    watchReady = true;
    window.addEventListener('pagehide', () => { unlisten(); headingObserver?.disconnect(); clearTimeout(reloadTimer); }, { once: true });
  } catch (error) { watchError = error; }
  // A real native startup command is the only source of initial document content.
  try {
    const result = await invoke<DocumentData | null>('startup_document');
    if (version === documentVersion && result) { commitDocument(result, version, false); void loadDirectory(parentPath(result.path)); }
  } catch (error) { if (version === documentVersion) showError(error); }
  finally { if (version === documentVersion) setLoading(false); }
  if (watchError) showError(`Live updates are unavailable: ${errorMessage(watchError)}`);
}
renderDirectory();
void initialize();
