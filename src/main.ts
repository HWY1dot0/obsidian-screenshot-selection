import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { domToBlob } from 'modern-screenshot';

const PREVIEW_SELECTORS = '.markdown-preview-view, .markdown-reading-view, .cm-content';
const MAX_CANVAS_HEIGHT = 30000;
const IMAGE_TIMEOUT_MS = 3000;

type WatermarkPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'center';

interface ScreenshotSelectionSettings {
  watermarkEnabled: boolean;
  watermarkText: string;
  watermarkPosition: WatermarkPosition;
  watermarkOpacity: number;
  watermarkFontSize: number;
}

const DEFAULT_SETTINGS: ScreenshotSelectionSettings = {
  watermarkEnabled: false,
  watermarkText: 'Screenshot Selection',
  watermarkPosition: 'bottom-right',
  watermarkOpacity: 0.35,
  watermarkFontSize: 14,
};

export default class ScreenshotSelectionPlugin extends Plugin {
  settings: ScreenshotSelectionSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ScreenshotSelectionSettingTab(this.app, this));

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

      offscreen = buildOffscreen(range, previewRoot, this.settings);
      document.body.appendChild(offscreen);

      await waitForAssets(offscreen);

      const inner = offscreen.firstElementChild as HTMLElement;
      if (inner.offsetHeight > MAX_CANVAS_HEIGHT) {
        new Notice(`Selection too tall (${inner.offsetHeight}px). Select less and retry.`);
        return;
      }

      const bg = getComputedStyle(document.body).getPropertyValue('--background-primary').trim() || '#ffffff';
      const blob = await domToBlob(offscreen, {
        scale: 2,
        type: 'image/png',
        backgroundColor: bg,
      });

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

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

function nodeAsElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function buildOffscreen(
  range: Range,
  previewRoot: Element,
  settings: ScreenshotSelectionSettings,
): HTMLDivElement {
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
    'overflow: hidden',
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
  appendWatermark(wrap, settings);
  return wrap;
}

function appendWatermark(wrap: HTMLDivElement, settings: ScreenshotSelectionSettings) {
  const text = settings.watermarkText.trim();
  if (!settings.watermarkEnabled || !text) return;

  const watermark = document.createElement('div');
  watermark.textContent = text;
  watermark.style.cssText = [
    'position: absolute',
    ...watermarkPositionStyles(settings.watermarkPosition),
    'z-index: 1',
    'max-width: calc(100% - 64px)',
    'box-sizing: border-box',
    'pointer-events: none',
    'color: var(--text-muted)',
    'background: color-mix(in srgb, var(--background-primary) 72%, transparent)',
    'border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent)',
    'border-radius: 6px',
    'padding: 4px 8px',
    `font-size: ${clamp(settings.watermarkFontSize, 10, 32)}px`,
    'font-family: var(--font-interface)',
    'font-weight: 500',
    'line-height: 1.3',
    'white-space: nowrap',
    'overflow: hidden',
    'text-overflow: ellipsis',
    `opacity: ${clamp(settings.watermarkOpacity, 0.1, 1)}`,
  ].join(';');

  wrap.appendChild(watermark);
}

function watermarkPositionStyles(position: WatermarkPosition): string[] {
  switch (position) {
    case 'bottom-left':
      return ['left: 16px', 'bottom: 16px'];
    case 'top-right':
      return ['right: 16px', 'top: 16px'];
    case 'top-left':
      return ['left: 16px', 'top: 16px'];
    case 'center':
      return ['left: 50%', 'top: 50%', 'transform: translate(-50%, -50%)'];
    case 'bottom-right':
    default:
      return ['right: 16px', 'bottom: 16px'];
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
  plugin: ScreenshotSelectionPlugin;

  constructor(app: App, plugin: ScreenshotSelectionPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Watermark')
      .setDesc('Add a text watermark to captured images.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.watermarkEnabled).onChange(async (value) => {
          this.plugin.settings.watermarkEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Watermark text')
      .setDesc('Shown only when watermark is enabled.')
      .addText((text) =>
        text
          .setPlaceholder('Screenshot Selection')
          .setValue(this.plugin.settings.watermarkText)
          .onChange(async (value) => {
            this.plugin.settings.watermarkText = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Watermark position')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            'bottom-right': 'Bottom right',
            'bottom-left': 'Bottom left',
            'top-right': 'Top right',
            'top-left': 'Top left',
            center: 'Center',
          })
          .setValue(this.plugin.settings.watermarkPosition)
          .onChange(async (value) => {
            this.plugin.settings.watermarkPosition = value as WatermarkPosition;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Watermark opacity')
      .setDesc('Lower values make the watermark more subtle.')
      .addSlider((slider) =>
        slider
          .setLimits(0.1, 1, 0.05)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.watermarkOpacity)
          .onChange(async (value) => {
            this.plugin.settings.watermarkOpacity = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Watermark font size')
      .setDesc('Measured in pixels.')
      .addSlider((slider) =>
        slider
          .setLimits(10, 32, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.watermarkFontSize)
          .onChange(async (value) => {
            this.plugin.settings.watermarkFontSize = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
