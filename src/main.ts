import { MarkdownView, Notice, Plugin } from 'obsidian';
import { domToBlob } from 'modern-screenshot';

const PREVIEW_SELECTORS = '.markdown-preview-view, .markdown-reading-view, .cm-content';
const MAX_CANVAS_HEIGHT = 30000;
const IMAGE_TIMEOUT_MS = 3000;

export default class ScreenshotSelectionPlugin extends Plugin {
  async onload() {
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

      offscreen = buildOffscreen(range, previewRoot);
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
