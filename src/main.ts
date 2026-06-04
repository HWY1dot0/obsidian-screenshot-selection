import {
  App,
  Editor,
  EditorPosition,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} from 'obsidian';
import { domToBlob, domToCanvas } from 'modern-screenshot';

const PREVIEW_SELECTORS = '.markdown-preview-view, .markdown-reading-view, .cm-content';
const MAX_CANVAS_HEIGHT = 30000;
const MOBILE_MAX_CANVAS_HEIGHT = 16000;
const IMAGE_TIMEOUT_MS = 3000;
const DESKTOP_SCALE = 2;
const MOBILE_SCALE = 1.5;
const SCREENSHOT_FOLDER = 'Attachments/Screenshots';

type CaptureOutput = 'clipboard' | 'file';
type WatermarkStyle = 'corner' | 'tiled';
type WatermarkCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

interface CaptureSource {
  offscreen: HTMLDivElement;
  insertAfter?: EditorPosition;
}

interface WatermarkSettings {
  enabled: boolean;
  text: string;
  style: WatermarkStyle;
  corner: WatermarkCorner;
  opacity: number;
  fontSize: number;
  color: string;
}

interface PluginSettings {
  watermark: WatermarkSettings;
}

const DEFAULT_SETTINGS: PluginSettings = {
  watermark: {
    enabled: false,
    text: '@HWY1dot0',
    style: 'corner',
    corner: 'bottom-right',
    opacity: 0.5,
    fontSize: 14,
    color: '',
  },
};

export default class ScreenshotSelectionPlugin extends Plugin {
  settings!: PluginSettings;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: 'capture-selection-as-png',
      name: Platform.isMobile ? 'Screenshot selection or block to file' : 'Screenshot selection to clipboard',
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          new Notice('Open a markdown note first');
          return;
        }
        void this.capture(view, Platform.isMobile ? 'file' : 'clipboard');
      },
    });

    if (!Platform.isMobile) {
      this.addCommand({
        id: 'capture-selection-as-png-file',
        name: 'Screenshot selection or block to file',
        callback: () => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (!view) {
            new Notice('Open a markdown note first');
            return;
          }
          void this.capture(view, 'file');
        },
      });
    }

    this.addSettingTab(new ScreenshotSelectionSettingTab(this.app, this));
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = {
      watermark: Object.assign(
        {},
        DEFAULT_SETTINGS.watermark,
        data?.watermark,
      ) as WatermarkSettings,
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async capture(view: MarkdownView, output: CaptureOutput) {
    let offscreen: HTMLDivElement | null = null;

    try {
      const source = output === 'file'
        ? await buildFileSource(this, view)
        : buildDomSelectionSource(view, Platform.isMobile);

      if (!source) {
        new Notice(output === 'file' ? 'No note content to capture' : 'No content selected');
        return;
      }

      offscreen = source.offscreen;
      document.body.appendChild(offscreen);

      await waitForAssets(offscreen);

      const inner = offscreen.firstElementChild as HTMLElement;
      const maxHeight = Platform.isMobile ? MOBILE_MAX_CANVAS_HEIGHT : MAX_CANVAS_HEIGHT;
      if (inner.offsetHeight > maxHeight) {
        new Notice(`Selection too tall (${inner.offsetHeight}px). Select less and retry.`);
        return;
      }

      const bg = getComputedStyle(document.body).getPropertyValue('--background-primary').trim() || '#ffffff';
      const scale = Platform.isMobile ? MOBILE_SCALE : DESKTOP_SCALE;
      const wm = this.settings.watermark;
      const useWatermark = wm.enabled && wm.text.trim().length > 0;

      const blob = useWatermark
        ? await captureWithWatermark(offscreen, bg, wm, scale)
        : await domToBlob(offscreen, { scale, type: 'image/png', backgroundColor: bg });

      if (!blob) {
        new Notice('Capture failed: empty image');
        return;
      }

      if (output === 'clipboard') {
        await writeBlobToClipboard(blob);
        new Notice('Copied selection as image', 2000);
        return;
      }

      const file = await saveBlobToVault(this.app, blob, view);
      const inserted = insertFileLink(view, file, source.insertAfter);
      new Notice(inserted ? 'Saved screenshot and inserted link' : `Saved screenshot to ${file.path}`, 3000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[screenshot-selection]', e);
      new Notice(`Capture failed: ${msg}`, 4000);
    } finally {
      offscreen?.remove();
    }
  }
}

async function buildFileSource(plugin: ScreenshotSelectionPlugin, view: MarkdownView): Promise<CaptureSource | null> {
  if (view.getMode() === 'source') {
    const editorSource = await buildEditorMarkdownSource(plugin, view);
    if (editorSource) return editorSource;
  }

  const selectionSource = buildDomSelectionSource(view, Platform.isMobile, true);
  if (selectionSource) return selectionSource;

  return buildVisibleViewSource(view, Platform.isMobile);
}

async function buildEditorMarkdownSource(plugin: ScreenshotSelectionPlugin, view: MarkdownView): Promise<CaptureSource | null> {
  const editor = view.editor;
  if (!editor) return null;

  const sourcePath = view.file?.path ?? '';
  const selectedMarkdown = editor.getSelection();
  if (selectedMarkdown.trim()) {
    return {
      offscreen: await buildMarkdownOffscreen(plugin, selectedMarkdown, sourcePath, Platform.isMobile),
      insertAfter: editor.getCursor('to'),
    };
  }

  const block = getCurrentMarkdownBlock(editor);
  if (!block?.markdown.trim()) return null;

  return {
    offscreen: await buildMarkdownOffscreen(plugin, block.markdown, sourcePath, Platform.isMobile),
    insertAfter: block.end,
  };
}

function buildDomSelectionSource(view: MarkdownView, mobile: boolean, quiet = false): CaptureSource | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  const anchor = nodeAsElement(range.commonAncestorContainer);
  const previewRoot = anchor?.closest(PREVIEW_SELECTORS);

  if (!previewRoot) {
    if (!quiet) {
      if (view.getMode() === 'source') {
        new Notice('Switch to Live Preview or Reading view to capture');
      } else {
        new Notice('Selection is outside the document');
      }
    }
    return null;
  }

  return {
    offscreen: buildSelectionOffscreen(range, mobile),
  };
}

function buildVisibleViewSource(view: MarkdownView, mobile: boolean): CaptureSource | null {
  const root = view.containerEl.querySelector(PREVIEW_SELECTORS);
  if (!root) return null;

  const wrap = createCaptureWrap(mobile);
  const inner = createRenderedInner();
  inner.appendChild(root.cloneNode(true));
  appendCaptureFix(inner);
  wrap.appendChild(inner);

  return { offscreen: wrap };
}

async function buildMarkdownOffscreen(
  plugin: ScreenshotSelectionPlugin,
  markdown: string,
  sourcePath: string,
  mobile: boolean,
): Promise<HTMLDivElement> {
  const wrap = createCaptureWrap(mobile);
  const inner = createRenderedInner();
  wrap.appendChild(inner);

  await MarkdownRenderer.render(plugin.app, markdown, inner, sourcePath, plugin);
  appendCaptureFix(inner);

  return wrap;
}

function getCurrentMarkdownBlock(editor: Editor): { markdown: string; end: EditorPosition } | null {
  const cursor = editor.getCursor();
  const lastLine = editor.lastLine();
  let startLine = cursor.line;
  let endLine = cursor.line;

  if (!editor.getLine(cursor.line).trim()) return null;

  while (startLine > 0 && editor.getLine(startLine - 1).trim()) {
    startLine -= 1;
  }

  while (endLine < lastLine && editor.getLine(endLine + 1).trim()) {
    endLine += 1;
  }

  const end: EditorPosition = {
    line: endLine,
    ch: editor.getLine(endLine).length,
  };

  return {
    markdown: editor.getRange({ line: startLine, ch: 0 }, end),
    end,
  };
}

function nodeAsElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function createCaptureWrap(mobile: boolean): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = [
    'position: fixed',
    'left: -10000px',
    'top: 0',
    'z-index: -1',
    'pointer-events: none',
    `width: ${mobile ? 'min(390px, calc(100vw - 32px))' : 'var(--file-line-width, 760px)'}`,
    `max-width: ${mobile ? '390px' : '900px'}`,
    'background: var(--background-primary)',
    'color: var(--text-normal)',
    `padding: ${mobile ? '18px 20px' : '28px 32px'}`,
    'box-sizing: border-box',
    'font-family: var(--font-text)',
    'font-size: var(--font-text-size, 16px)',
    'line-height: var(--line-height-normal)',
  ].join(';');

  return wrap;
}

function createRenderedInner(): HTMLDivElement {
  const inner = document.createElement('div');
  inner.className = 'markdown-preview-view markdown-rendered show-indentation-guide';
  inner.style.cssText = 'width: 100%; padding: 0;';

  return inner;
}

function buildSelectionOffscreen(range: Range, mobile: boolean): HTMLDivElement {
  const wrap = createCaptureWrap(mobile);
  const inner = createRenderedInner();
  inner.appendChild(range.cloneContents());
  appendCaptureFix(inner);

  wrap.appendChild(inner);
  return wrap;
}

function appendCaptureFix(inner: HTMLElement): void {
  const fix = document.createElement('style');
  fix.textContent = `
    pre, .cm-line, code { white-space: pre-wrap !important; word-break: break-word; }
    iframe, embed, object, video { display: none !important; }
    img { max-width: 100% !important; height: auto !important; }
    .cm-cursor, .cm-selectionBackground { display: none !important; }
  `;
  inner.appendChild(fix);
}

async function waitForAssets(root: HTMLElement): Promise<void> {
  try {
    await document.fonts.ready;
  } catch {
    /* fonts.ready can reject in odd states; not fatal */
  }
  const imgs = Array.from(root.querySelectorAll('img')) as HTMLImageElement[];
  await Promise.all(
    imgs.map((img) => {
      if (img.complete && img.naturalWidth > 0) return null;
      return Promise.race([
        img.decode().catch(() => null),
        new Promise((r) => setTimeout(r, IMAGE_TIMEOUT_MS)),
      ]);
    }),
  );
}

async function captureWithWatermark(
  offscreen: HTMLElement,
  bg: string,
  wm: WatermarkSettings,
  scale: number,
): Promise<Blob | null> {
  const canvas = await domToCanvas(offscreen, { scale, backgroundColor: bg });
  const effScale = offscreen.offsetWidth > 0 ? canvas.width / offscreen.offsetWidth : scale;
  drawWatermark(canvas, wm, effScale);
  return await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/png'),
  );
}

function drawWatermark(canvas: HTMLCanvasElement, wm: WatermarkSettings, scale: number): void {
  const text = wm.text.trim();
  const ctx = canvas.getContext('2d');
  if (!text || !ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const fontPx = Math.max(1, wm.fontSize) * scale;
  const fontFamily = getComputedStyle(document.body).getPropertyValue('--font-text').trim() || 'sans-serif';

  ctx.save();
  ctx.globalAlpha = clamp(wm.opacity, 0, 1);
  ctx.fillStyle = resolveWatermarkColor(wm.color);
  ctx.font = `${fontPx}px ${fontFamily}`;

  if (wm.style === 'tiled') {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-Math.PI / 6);
    const stepX = Math.max(ctx.measureText(text).width + 80 * scale, 160 * scale);
    const stepY = Math.max(fontPx * 4, 80 * scale);
    const reach = Math.sqrt(W * W + H * H);
    for (let y = -reach; y <= reach; y += stepY) {
      for (let x = -reach; x <= reach; x += stepX) {
        ctx.fillText(text, x, y);
      }
    }
  } else {
    const pad = 14 * scale;
    ctx.textBaseline = 'alphabetic';
    const isRight = wm.corner.endsWith('right');
    const isBottom = wm.corner.startsWith('bottom');
    ctx.textAlign = isRight ? 'right' : 'left';
    const x = isRight ? W - pad : pad;
    const y = isBottom ? H - pad : pad + fontPx;
    ctx.fillText(text, x, y);
  }

  ctx.restore();
}

function resolveWatermarkColor(color: string): string {
  const c = color.trim();
  if (c) return c;
  const muted = getComputedStyle(document.body).getPropertyValue('--text-muted').trim();
  return muted || '#888888';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

async function saveBlobToVault(app: App, blob: Blob, view: MarkdownView): Promise<TFile> {
  await ensureFolder(app, SCREENSHOT_FOLDER);

  const noteBaseName = sanitizeFileName(view.file?.basename ?? 'note');
  const basePath = normalizePath(`${SCREENSHOT_FOLDER}/${noteBaseName}-${timestampForFile()}.png`);
  const path = await getAvailablePath(app, basePath);

  return app.vault.createBinary(path, await blob.arrayBuffer());
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const normalized = normalizePath(folderPath);
  const parts = normalized.split('/').filter(Boolean);
  let current = '';

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getFolderByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

async function getAvailablePath(app: App, path: string): Promise<string> {
  if (!app.vault.getAbstractFileByPath(path)) return path;

  const extIndex = path.lastIndexOf('.');
  const stem = extIndex >= 0 ? path.slice(0, extIndex) : path;
  const ext = extIndex >= 0 ? path.slice(extIndex) : '';

  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
  }

  throw new Error('Could not find an available screenshot filename');
}

function insertFileLink(view: MarkdownView, file: TFile, insertAfter?: EditorPosition): boolean {
  const editor = view.editor;
  if (!editor || view.getMode() !== 'source') return false;

  const sourcePath = view.file?.path ?? '';
  let link = view.app.fileManager.generateMarkdownLink(file, sourcePath);
  if (!link.startsWith('!')) link = `!${link}`;

  const pos = insertAfter ?? editor.getCursor('to');
  const line = editor.getLine(pos.line);
  const prefix = pos.ch === 0 ? '' : '\n';
  const suffix = line.slice(pos.ch).trim() ? '\n' : '';

  editor.replaceRange(`${prefix}${link}\n${suffix}`, pos, pos, 'screenshot-selection');
  return true;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^\[\]]+/g, '-').replace(/\s+/g, ' ').trim() || 'note';
}

function timestampForFile(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');

  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    '-',
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join('');
}

async function writeBlobToClipboard(blob: Blob): Promise<void> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return;
  } catch (e) {
    console.warn('[screenshot-selection] navigator.clipboard.write failed, falling back to Electron', e);
  }

  const electron = (window as any).require?.('electron');
  if (!electron?.clipboard || !electron?.nativeImage) {
    throw new Error('Clipboard API unavailable');
  }
  const buf = Buffer.from(await blob.arrayBuffer());
  electron.clipboard.writeImage(electron.nativeImage.createFromBuffer(buf));
}

class ScreenshotSelectionSettingTab extends PluginSettingTab {
  private plugin: ScreenshotSelectionPlugin;

  constructor(app: App, plugin: ScreenshotSelectionPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const wm = this.plugin.settings.watermark;

    new Setting(containerEl)
      .setName('Add watermark')
      .setDesc('Draw a watermark onto each captured screenshot.')
      .addToggle((toggle) =>
        toggle.setValue(wm.enabled).onChange(async (value) => {
          wm.enabled = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (!wm.enabled) {
      return;
    }

    new Setting(containerEl).setName('Watermark text').addText((text) =>
      text
        .setPlaceholder('@your-handle')
        .setValue(wm.text)
        .onChange(async (value) => {
          wm.text = value;
          await this.plugin.saveSettings();
        }),
    );

    new Setting(containerEl).setName('Style').addDropdown((dropdown) =>
      dropdown
        .addOption('corner', 'Corner label')
        .addOption('tiled', 'Diagonal tiled')
        .setValue(wm.style)
        .onChange(async (value) => {
          wm.style = value as WatermarkStyle;
          await this.plugin.saveSettings();
          this.display();
        }),
    );

    if (wm.style === 'corner') {
      new Setting(containerEl).setName('Corner').addDropdown((dropdown) =>
        dropdown
          .addOption('top-left', 'Top left')
          .addOption('top-right', 'Top right')
          .addOption('bottom-left', 'Bottom left')
          .addOption('bottom-right', 'Bottom right')
          .setValue(wm.corner)
          .onChange(async (value) => {
            wm.corner = value as WatermarkCorner;
            await this.plugin.saveSettings();
          }),
      );
    }

    new Setting(containerEl)
      .setName('Opacity')
      .setDesc('0 = invisible, 1 = solid. Tiled usually looks best around 0.1.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setValue(wm.opacity)
          .setDynamicTooltip()
          .onChange(async (value) => {
            wm.opacity = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName('Font size (px)').addText((text) =>
      text.setValue(String(wm.fontSize)).onChange(async (value) => {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) {
          wm.fontSize = n;
          await this.plugin.saveSettings();
        }
      }),
    );

    new Setting(containerEl)
      .setName('Color')
      .setDesc('Leave blank to use the theme muted text color, or set a hex like #888888.')
      .addText((text) =>
        text
          .setPlaceholder('(theme default)')
          .setValue(wm.color)
          .onChange(async (value) => {
            wm.color = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
