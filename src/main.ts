import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { domToBlob, domToCanvas } from 'modern-screenshot';

const PREVIEW_SELECTORS = '.markdown-preview-view, .markdown-reading-view, .cm-content';
const MAX_CANVAS_HEIGHT = 30000;
const IMAGE_TIMEOUT_MS = 3000;
const SCALE = 2;

type WatermarkStyle = 'corner' | 'tiled';
type WatermarkCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

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
      name: 'Screenshot selection to clipboard',
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          new Notice('Open a markdown note first');
          return;
        }
        void this.capture(view);
      },
    });

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

  private async capture(view: MarkdownView) {
    let offscreen: HTMLDivElement | null = null;

    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        new Notice('No content selected');
        return;
      }

      const range = sel.getRangeAt(0);
      const anchor = nodeAsElement(range.commonAncestorContainer);
      const previewRoot = anchor?.closest(PREVIEW_SELECTORS);

      if (!previewRoot) {
        if (view.getMode() === 'source') {
          new Notice('Switch to Live Preview or Reading view to capture');
        } else {
          new Notice('Selection is outside the document');
        }
        return;
      }

      offscreen = buildOffscreen(range, previewRoot);
      document.body.appendChild(offscreen);

      await waitForAssets(offscreen);

      const inner = offscreen.firstElementChild as HTMLElement;
      if (inner.offsetHeight > MAX_CANVAS_HEIGHT) {
        new Notice(`Selection too tall (${inner.offsetHeight}px). Select less and retry.`);
        return;
      }

      const bg = getComputedStyle(document.body).getPropertyValue('--background-primary').trim() || '#ffffff';

      const wm = this.settings.watermark;
      const useWatermark = wm.enabled && wm.text.trim().length > 0;

      const blob = useWatermark
        ? await captureWithWatermark(offscreen, bg, wm)
        : await domToBlob(offscreen, { scale: SCALE, type: 'image/png', backgroundColor: bg });

      if (!blob) {
        new Notice('Capture failed: empty image');
        return;
      }

      await writeBlobToClipboard(blob);
      new Notice('Copied selection as image', 2000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[screenshot-selection]', e);
      new Notice(`Capture failed: ${msg}`, 4000);
    } finally {
      offscreen?.remove();
    }
  }
}

function nodeAsElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function buildOffscreen(range: Range, previewRoot: Element): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = [
    'position: fixed',
    'left: -10000px',
    'top: 0',
    'z-index: -1',
    'pointer-events: none',
    'width: var(--file-line-width, 760px)',
    'max-width: 900px',
    'background: var(--background-primary)',
    'color: var(--text-normal)',
    'padding: 28px 32px',
    'box-sizing: border-box',
    'font-family: var(--font-text)',
    'font-size: var(--font-text-size)',
    'line-height: var(--line-height-normal)',
  ].join(';');

  const inner = document.createElement('div');
  inner.className = 'markdown-preview-view markdown-rendered show-indentation-guide';
  inner.style.cssText = 'width: 100%; padding: 0;';
  inner.appendChild(range.cloneContents());

  const fix = document.createElement('style');
  fix.textContent = `
    pre, .cm-line, code { white-space: pre-wrap !important; word-break: break-word; }
    iframe, embed, object, video { display: none !important; }
    img { max-width: 100% !important; height: auto !important; }
  `;
  inner.appendChild(fix);

  wrap.appendChild(inner);
  return wrap;
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
): Promise<Blob | null> {
  const canvas = await domToCanvas(offscreen, { scale: SCALE, backgroundColor: bg });
  const effScale = offscreen.offsetWidth > 0 ? canvas.width / offscreen.offsetWidth : SCALE;
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
