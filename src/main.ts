import {
  App,
  Component,
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
  TFolder,
  normalizePath,
} from 'obsidian';
import { domToCanvas } from 'modern-screenshot';

const PREVIEW_SELECTORS = '.markdown-preview-view, .markdown-reading-view, .cm-content';
const MAX_CANVAS_HEIGHT = 30000;
const MOBILE_MAX_CANVAS_HEIGHT = 16000;
const DESKTOP_IMAGE_TIMEOUT_MS = 3000;
const MOBILE_IMAGE_TIMEOUT_MS = 800;
const DESKTOP_FONT_TIMEOUT_MS = 1000;
const MOBILE_FONT_TIMEOUT_MS = 300;
const DESKTOP_SCALE = 2;
const MOBILE_SCALE = 1.25;
const SCREENSHOT_FOLDER = 'Attachments/Screenshots';

type CaptureOutput = 'auto' | 'clipboard' | 'file';
type WatermarkStyle = 'corner' | 'tiled';
type WatermarkCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

interface CaptureSource {
  offscreen: HTMLDivElement;
  insertAfter?: EditorPosition;
  fallbackMarkdown?: string;
  // A short-lived Component scoped to this capture's MarkdownRenderer.render call.
  // Unloaded after rasterization so child renderers (embeds, math, callouts, ...)
  // are not tied to the plugin's lifetime, which would leak. Only the rendered-
  // markdown path sets it; the live-DOM clone path leaves it undefined.
  component?: Component;
}

interface CaptureResult {
  blob: Blob;
  insertAfter?: EditorPosition;
  renderMode?: 'dom' | 'fallback';
}

interface MarkdownCaptureSnapshot {
  markdown: string;
  sourcePath: string;
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

  // Last non-collapsed selection inside a rendered note, stashed continuously so
  // capture survives the selection loss when a menu/ribbon is tapped on mobile.
  // Cloning this LIVE DOM is what makes iOS rasterize correctly — a freshly
  // MarkdownRenderer-rendered offscreen subtree comes back blank.
  private lastPreviewRange: Range | null = null;

  async onload() {
    await this.loadSettings();

    this.registerDomEvent(activeDocument, 'selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      if (nodeAsElement(range.commonAncestorContainer)?.closest(PREVIEW_SELECTORS)) {
        this.lastPreviewRange = range.cloneRange();
      }
    });

    this.addCommand({
      id: 'capture-selection-as-png',
      name: Platform.isMobile ? 'Capture selection or block' : 'Capture selection to clipboard',
      callback: () => {
        void this.captureActive(Platform.isMobile ? 'auto' : 'clipboard');
      },
    });

    if (!Platform.isMobile) {
      this.addCommand({
        id: 'capture-selection-as-png-file',
        name: 'Capture selection or block to file',
        callback: () => {
          void this.captureActive('file');
        },
      });
    }

    this.addRibbonIcon('camera', Platform.isMobile ? 'Screenshot selection or block' : 'Screenshot selection', () => {
      void this.captureActive(Platform.isMobile ? 'auto' : 'clipboard');
    });

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, _editor, info) => {
        const viewAtMenuOpen = info instanceof MarkdownView
          ? info
          : this.app.workspace.getActiveViewOfType(MarkdownView);
        const snapshot = viewAtMenuOpen
          ? getEditorMarkdownSnapshot(_editor, viewAtMenuOpen.file?.path ?? '')
          : null;

        menu.addItem((item) => {
          item
            .setTitle(Platform.isMobile ? 'Screenshot selection/block' : 'Screenshot selection/block to file')
            .setIcon('camera')
            .onClick(() => {
              const view = viewAtMenuOpen ?? this.app.workspace.getActiveViewOfType(MarkdownView);
              if (!view) {
                new Notice('Open a markdown note first');
                return;
              }
              // On mobile go through capture() so the live-DOM clone path runs;
              // the markdown snapshot re-renders and rasterizes blank on iOS.
              if (Platform.isMobile) {
                void this.capture(view, 'auto');
                return;
              }
              if (snapshot) {
                void this.captureMarkdownSnapshot(view, snapshot, 'file');
                return;
              }
              void this.capture(view, 'file');
            });
        });
      }),
    );

    this.addSettingTab(new ScreenshotSelectionSettingTab(this.app, this));
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = {
      watermark: Object.assign(
        {},
        DEFAULT_SETTINGS.watermark,
        data?.watermark,
      ),
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Current selection if it is live and inside a note, otherwise the last one
  // stashed before a tap collapsed it.
  getEffectiveSelectionRange(): Range | null {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      if (nodeAsElement(range.commonAncestorContainer)?.closest(PREVIEW_SELECTORS)) {
        return range;
      }
    }
    return this.lastPreviewRange;
  }

  private async captureActive(output: CaptureOutput) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice('Open a markdown note first');
      return;
    }

    await this.capture(view, output);
  }

  private async capture(view: MarkdownView, output: CaptureOutput) {
    const sourcePromise = output === 'clipboard'
      ? Promise.resolve(buildDomSelectionSource(view, Platform.isMobile))
      : buildFileSource(this, view);

    await this.captureFromSource(view, sourcePromise, output);
  }

  private async captureMarkdownSnapshot(
    view: MarkdownView,
    snapshot: MarkdownCaptureSnapshot,
    output: CaptureOutput,
  ) {
    await this.captureFromSource(
      view,
      buildSnapshotSource(this, snapshot, Platform.isMobile),
      output,
    );
  }

  private async captureFromSource(
    view: MarkdownView,
    sourcePromise: Promise<CaptureSource | null>,
    output: CaptureOutput,
  ) {
    if (output === 'auto') {
      await this.captureAutoFromSource(view, sourcePromise);
      return;
    }

    try {
      const source = await sourcePromise;
      if (!source) {
        new Notice(output === 'file' ? 'No note content to capture' : 'No content selected');
        return;
      }

      const result = await this.createCaptureResultFromSource(source);

      if (output === 'clipboard') {
        await writeBlobToClipboard(result.blob);
        new Notice('Copied selection as image', 2000);
        return;
      }

      await this.saveCaptureResult(view, result);
    } catch (e) {
      showCaptureError(e);
    }
  }

  private async captureAutoFromSource(view: MarkdownView, sourcePromise: Promise<CaptureSource | null>) {
    const progress = new Notice('Capturing screenshot...', 0);

    try {
      const source = await sourcePromise;
      if (!source) {
        new Notice('No note content to capture');
        return;
      }

      const result = await this.createCaptureResultFromSource(source);
      const modeNote = result.renderMode === 'fallback'
        ? ' (text fallback — iOS could not rasterize)'
        : result.renderMode === 'dom'
          ? ' (themed render)'
          : '';
      try {
        await writeBlobToClipboard(result.blob);
        new Notice(`Copied screenshot to clipboard${modeNote}`, 2500);
      } catch (e) {
        console.warn('[screenshot-selection] mobile clipboard write failed, saving to vault', e);
        await this.saveCaptureResult(view, result, `Saved screenshot and inserted link${modeNote}`);
      }
    } catch (e) {
      showCaptureError(e);
    } finally {
      progress.hide();
    }
  }

  private async createCaptureResultFromSource(source: CaptureSource): Promise<CaptureResult> {
    let offscreen: HTMLDivElement | null = null;

    try {
      offscreen = source.offscreen;
      activeDocument.body.appendChild(offscreen);

      await waitForAssets(offscreen);
      await waitForPaint();
      // Trim trailing whitespace on mobile too. This was previously desktop-only,
      // which is why mobile captures (since 0.2.1) had a long blank strip below
      // the content. The offscreen is attached and visible on mobile, so
      // getBoundingClientRect-based measurement is valid here.
      trimOffscreenToContent(offscreen);
      freezeLineHeights(offscreen);

      const inner = offscreen.firstElementChild as HTMLElement;
      const maxHeight = Platform.isMobile ? MOBILE_MAX_CANVAS_HEIGHT : MAX_CANVAS_HEIGHT;
      if (inner.offsetHeight > maxHeight) {
        throw new Error(`Selection too tall (${inner.offsetHeight}px). Select less and retry.`);
      }

      const bg = getComputedStyle(activeDocument.body).getPropertyValue('--background-primary').trim() || '#ffffff';
      const scale = Platform.isMobile ? MOBILE_SCALE : DESKTOP_SCALE;
      const wm = this.settings.watermark;
      const useWatermark = wm.enabled && wm.text.trim().length > 0;

      let renderMode: CaptureResult['renderMode'];
      let blob: Blob | null;
      if (Platform.isMobile) {
        const mobile = await renderMobileCaptureBlob(offscreen, bg, scale, useWatermark ? wm : null, source.fallbackMarkdown);
        blob = mobile.blob;
        renderMode = mobile.usedFallback ? 'fallback' : 'dom';
      } else {
        const canvas = await renderThemedCanvas(offscreen, bg, scale);
        if (useWatermark) {
          const effScale = offscreen.offsetWidth > 0 ? canvas.width / offscreen.offsetWidth : scale;
          drawWatermark(canvas, wm, effScale);
        }
        blob = await canvasToBlob(canvas);
      }

      if (!blob) {
        throw new Error('Capture failed: empty image');
      }

      return {
        blob,
        insertAfter: source.insertAfter,
        renderMode,
      };
    } finally {
      offscreen?.remove();
      source.component?.unload();
    }
  }

  private async saveCaptureResult(view: MarkdownView, result: CaptureResult, insertedNotice = 'Saved screenshot and inserted link') {
    const file = await saveBlobToVault(this.app, result.blob, view);
    const inserted = insertFileLink(view, file, result.insertAfter);
    new Notice(inserted ? insertedNotice : `Saved screenshot to ${file.path}`, 3000);
  }
}

async function buildFileSource(plugin: ScreenshotSelectionPlugin, view: MarkdownView): Promise<CaptureSource | null> {
  if (Platform.isMobile) {
    // Prefer a clone of the LIVE rendered DOM (Reading view / Live Preview). iOS
    // WKWebView rasterizes already-painted nodes correctly; a freshly
    // MarkdownRenderer-rendered offscreen subtree comes back blank (the
    // 0.2.3–0.2.7 regression). Use the stashed range so a tap that drops the
    // selection does not drop the capture.
    const range = plugin.getEffectiveSelectionRange();
    if (range) {
      const domSource = buildRangeSource(range, true);
      if (domSource) return domSource;
    }

    // Fallbacks re-render markdown (may be blank on iOS → text-canvas fallback
    // downstream): explicit editor selection, then the current block.
    const editorSelectionSource = await buildEditorMarkdownSource(plugin, view, true);
    if (editorSelectionSource) return editorSelectionSource;

    const editorSource = await buildEditorMarkdownSource(plugin, view);
    if (editorSource) return editorSource;

    return null;
  }

  if (view.getMode() === 'source') {
    const editorSource = await buildEditorMarkdownSource(plugin, view);
    if (editorSource) return editorSource;
  }

  const selectionSource = buildDomSelectionSource(view, Platform.isMobile, true);
  if (selectionSource) return selectionSource;

  return buildVisibleViewSource(view, Platform.isMobile);
}

async function buildEditorMarkdownSource(
  plugin: ScreenshotSelectionPlugin,
  view: MarkdownView,
  selectionOnly = false,
): Promise<CaptureSource | null> {
  const editor = view.editor;
  if (!editor) return null;

  const snapshot = getEditorMarkdownSnapshot(editor, view.file?.path ?? '', selectionOnly);
  if (!snapshot) return null;

  return buildSnapshotSource(plugin, snapshot, Platform.isMobile);
}

async function buildSnapshotSource(
  plugin: ScreenshotSelectionPlugin,
  snapshot: MarkdownCaptureSnapshot,
  mobile: boolean,
): Promise<CaptureSource> {
  const component = new Component();
  component.load();
  try {
    return {
      offscreen: await buildMarkdownOffscreen(plugin, snapshot.markdown, snapshot.sourcePath, mobile, component),
      insertAfter: snapshot.insertAfter,
      fallbackMarkdown: snapshot.markdown,
      component,
    };
  } catch (e) {
    // Render failed before the source was handed off — unload now so the
    // component is not orphaned (its owner only unloads it after capture).
    component.unload();
    throw e;
  }
}

function getEditorMarkdownSnapshot(
  editor: Editor,
  sourcePath: string,
  selectionOnly = false,
): MarkdownCaptureSnapshot | null {
  const selectedMarkdown = editor.getSelection();
  if (selectedMarkdown.trim()) {
    return {
      markdown: selectedMarkdown,
      sourcePath,
      insertAfter: editor.getCursor('to'),
    };
  }

  if (selectionOnly) return null;

  const block = getCurrentMarkdownBlock(editor);
  if (!block?.markdown.trim()) return null;

  return {
    markdown: block.markdown,
    sourcePath,
    insertAfter: block.end,
  };
}

// Build a capture source from an explicit DOM range (a clone of live, already
// rendered note content). This is the path that rasterizes correctly on iOS.
function buildRangeSource(range: Range, mobile: boolean): CaptureSource | null {
  const anchor = nodeAsElement(range.commonAncestorContainer);
  if (!anchor?.closest(PREVIEW_SELECTORS)) return null;
  const contentWidth = mobile ? undefined : measureContentWidth(range);
  return {
    offscreen: buildSelectionOffscreen(range, mobile, contentWidth),
    fallbackMarkdown: range.toString().replace(/\n{3,}/g, '\n\n').trim(),
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

  const fallbackMarkdown = range.toString().replace(/\n{3,}/g, '\n\n').trim();
  const contentWidth = mobile ? undefined : measureContentWidth(range);

  return {
    offscreen: buildSelectionOffscreen(range, mobile, contentWidth),
    fallbackMarkdown,
  };
}

function buildVisibleViewSource(view: MarkdownView, mobile: boolean): CaptureSource | null {
  const root = view.containerEl.querySelector(PREVIEW_SELECTORS);
  if (!root) return null;

  const wrap = createCaptureWrap(mobile);

  if (root.classList.contains('cm-content') && root.parentElement) {
    const inner = createRenderedInner('screenshot-selection-inner');
    const { outer, host } = buildEditorContextHost(root.parentElement);
    host.appendChild(root.cloneNode(true));
    inner.appendChild(outer);
    wrap.appendChild(inner);
    return { offscreen: wrap };
  }

  const inner = createRenderedInner();
  inner.appendChild(root.cloneNode(true));
  wrap.appendChild(inner);

  return { offscreen: wrap };
}

async function buildMarkdownOffscreen(
  plugin: ScreenshotSelectionPlugin,
  markdown: string,
  sourcePath: string,
  mobile: boolean,
  component: Component,
): Promise<HTMLDivElement> {
  const wrap = createCaptureWrap(mobile);
  const inner = createRenderedInner();
  wrap.appendChild(inner);

  // Render with a short-lived Component (unloaded after capture) rather than the
  // plugin instance, so transient child renderers are not retained for the
  // plugin's whole lifetime.
  await MarkdownRenderer.render(plugin.app, markdown, inner, sourcePath, component);

  return wrap;
}

function getCurrentMarkdownBlock(editor: Editor): { markdown: string; end: EditorPosition } | null {
  const cursor = editor.getCursor();
  const lastLine = editor.lastLine();
  const focusLine = getNearestNonEmptyLine(editor, cursor.line);
  if (focusLine === null) return null;

  let startLine = focusLine;
  let endLine = focusLine;

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

function getNearestNonEmptyLine(editor: Editor, line: number): number | null {
  if (editor.getLine(line).trim()) return line;

  const lastLine = editor.lastLine();
  const maxDistance = Math.min(4, Math.max(line, lastLine - line));
  for (let distance = 1; distance <= maxDistance; distance += 1) {
    const before = line - distance;
    if (before >= 0 && editor.getLine(before).trim()) return before;

    const after = line + distance;
    if (after <= lastLine && editor.getLine(after).trim()) return after;
  }

  return null;
}

function nodeAsElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function createCaptureWrap(mobile: boolean, contentWidth?: number): HTMLDivElement {
  const wrap = activeDocument.createElement('div');
  wrap.className = 'screenshot-selection-capture';
  wrap.style.cssText = [
    'position: fixed',
    `left: ${mobile ? '8px' : '-10000px'}`,
    `top: ${mobile ? 'calc(env(safe-area-inset-top, 0px) + 8px)' : '0'}`,
    `z-index: ${mobile ? '2147483647' : '-1'}`,
    'pointer-events: none',
    'height: auto',
    `width: ${mobile ? 'min(390px, calc(100vw - 32px))' : (contentWidth != null ? Math.round(contentWidth) + 64 + 'px' : 'var(--file-line-width, 760px)')}`,
    `max-width: ${mobile ? '390px' : (contentWidth != null ? 'none' : '900px')}`,
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

function createRenderedInner(
  className = 'markdown-preview-view markdown-rendered show-indentation-guide screenshot-selection-inner',
): HTMLDivElement {
  const inner = activeDocument.createElement('div');
  inner.className = className;
  inner.style.cssText = [
    'width: 100%',
    'height: auto',
    'min-height: 0',
    'max-height: none',
    'padding: 0',
    'margin: 0',
    'overflow: visible',
  ].join(';');

  return inner;
}

// Replicate the classes and inline styles of the editor containers between
// `deepest` and the enclosing .markdown-source-view, so a detached CM6 clone
// keeps resolving the same CSS: Obsidian scopes editor rules to that chain
// (.markdown-source-view.mod-cm6, .is-live-preview, .cm-s-obsidian) and
// CodeMirror scopes its base theme to generated classes on .cm-editor.
// Without it the clone sits under reading-view classes, whose rules (e.g.
// `.markdown-rendered .list-bullet { float: inline-start }`) restyle editor
// widgets — bullets, checkboxes — onto the text.
function buildEditorContextHost(deepest: Element): { outer: HTMLElement; host: HTMLElement } {
  const chain: Element[] = [];
  let el: Element | null = deepest;
  for (let depth = 0; el && depth < 8; depth += 1) {
    chain.push(el);
    if (el.classList.contains('markdown-source-view')) break;
    el = el.parentElement;
  }

  let outer: HTMLElement | null = null;
  let host: HTMLElement | null = null;
  for (const source of chain.reverse()) {
    const replica = activeDocument.createElement('div');
    replica.className = source.className;
    const inline = source.getAttribute('style');
    if (inline) replica.setAttribute('style', inline);
    if (host) host.appendChild(replica);
    outer = outer ?? replica;
    host = replica;
  }

  return { outer: outer as HTMLElement, host: host as HTMLElement };
}

function buildSelectionOffscreen(range: Range, mobile: boolean, contentWidth?: number): HTMLDivElement {
  const wrap = createCaptureWrap(mobile, contentWidth);
  const cmContent = nodeAsElement(range.commonAncestorContainer)?.closest('.cm-content');

  if (cmContent) {
    const inner = createRenderedInner('screenshot-selection-inner');
    const { outer, host } = buildEditorContextHost(cmContent);
    host.appendChild(range.cloneContents());
    inner.appendChild(outer);
    wrap.appendChild(inner);
    return wrap;
  }

  const inner = createRenderedInner();
  inner.appendChild(range.cloneContents());

  wrap.appendChild(inner);
  return wrap;
}

async function waitForAssets(root: HTMLElement): Promise<void> {
  try {
    await withTimeout(activeDocument.fonts.ready, Platform.isMobile ? MOBILE_FONT_TIMEOUT_MS : DESKTOP_FONT_TIMEOUT_MS);
  } catch {
    /* fonts.ready can reject in odd states; not fatal */
  }
  const imgs = Array.from(root.querySelectorAll('img'));
  const imageTimeout = Platform.isMobile ? MOBILE_IMAGE_TIMEOUT_MS : DESKTOP_IMAGE_TIMEOUT_MS;
  await Promise.all(
    imgs.map((img) => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve(null);
      return Promise.race([
        img.decode().catch(() => null),
        new Promise((r) => window.setTimeout(r, imageTimeout)),
      ]);
    }),
  );
}

function trimOffscreenToContent(offscreen: HTMLElement): void {
  const inner = offscreen.firstElementChild as HTMLElement | null;
  if (!inner) return;

  const contentHeight = measureContentHeight(inner);
  if (contentHeight <= 0) return;

  // min-height / max-height / overflow are handled by styles.css (scoped to
  // .screenshot-selection-inner); only the measured height is dynamic.
  inner.style.height = `${contentHeight}px`;
}

// Pin every element's line-height to an explicit px value before capture.
// modern-screenshot drops inherited/CSS-variable line-heights when cloning
// into <foreignObject>, falling back to `normal` and collapsing CJK lines.
function freezeLineHeights(root: HTMLElement): void {
  const win = root.ownerDocument.defaultView ?? window;
  const els: HTMLElement[] = [root];
  root.querySelectorAll('*').forEach((el) => {
    if (el.instanceOf(HTMLElement)) els.push(el);
  });
  for (const el of els) {
    const cs = win.getComputedStyle(el);
    let lineHeight = cs.lineHeight;
    if (!lineHeight || lineHeight === 'normal') {
      const fontSize = parseFloat(cs.fontSize) || 16;
      lineHeight = `${Math.round(fontSize * 1.5 * 100) / 100}px`;
    }
    el.style.setProperty('line-height', lineHeight, 'important');
  }
}

// Measure the on-screen column width of the block containing the selection so
// the capture wrap keeps the source line breaks instead of the fixed 760/900px.
function measureContentWidth(range: Range): number | undefined {
  const win = range.startContainer.ownerDocument?.defaultView ?? window;
  // Walk up from the common ancestor, not range.startContainer: the start can
  // sit inside a shrink-wrapped block that is NOT the content column. A
  // selection wholly inside a callout begins in `.callout-title-inner`, which
  // hugs the title text (~65px); measuring it collapses the capture into a
  // one-glyph-per-line sliver. The common ancestor is by definition wide enough
  // to hold the whole selection.
  const common = range.commonAncestorContainer;
  // The selection's painted width is a floor: the container we pick must be at
  // least this wide, so we walk past any ancestor still narrower than the
  // selection (e.g. a shrink-wrapped flex/grid item) up to the real column.
  const needed = Math.round(range.getBoundingClientRect().width);
  let el: Element | null =
    common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement;
  let firstBlock: number | undefined;
  while (el) {
    const display = win.getComputedStyle(el).display;
    // Skip every inline-* variant: a selection can start inside inline-flex
    // widgets (e.g. the live-preview list bullet), whose width is not the
    // content column's.
    if (!display.startsWith('inline') && display !== 'contents') {
      const width = Math.round(el.getBoundingClientRect().width);
      if (width > 0) {
        if (firstBlock === undefined) firstBlock = width;
        if (width >= needed - 1) return width;
      }
    }
    el = el.parentElement;
  }
  return firstBlock;
}

function measureContentHeight(container: HTMLElement): number {
  const containerTop = container.getBoundingClientRect().top;
  let bottom = 0;

  for (const child of Array.from(container.children) as HTMLElement[]) {
    if (child.tagName === 'STYLE') continue;

    const rect = child.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    const style = getComputedStyle(child);
    const marginBottom = parseFloat(style.marginBottom) || 0;
    bottom = Math.max(bottom, rect.bottom - containerTop + marginBottom);
  }

  return Math.ceil(bottom);
}

// Elements whose height is intrinsic rather than a product of text flow; their
// pinned height must survive unpinClonedTextHeights.
const KEEP_PINNED_HEIGHT_TAGS = new Set([
  'IMG', 'VIDEO', 'CANVAS', 'SVG', 'IFRAME', 'EMBED', 'OBJECT',
  'INPUT', 'TEXTAREA', 'SELECT', 'PROGRESS', 'METER', 'HR',
]);

// modern-screenshot pins every cloned element's used width AND height as
// inline styles (width/height are excluded from its default-style diff on
// purpose). Text metrics inside the rasterized <foreignObject> are not
// bit-identical to the live document, so a CJK/latin mixed line can wrap one
// glyph earlier there; with the block's height pinned, the extra line
// overflows and the next block paints over it — paragraphs overlap at their
// boundary. Un-pin height on text-bearing containers so reflow grows the
// block and pushes content down instead. Width stays pinned: it is what
// preserves the source column and line breaks.
function unpinClonedTextHeights(node: Node): void {
  if (!node.instanceOf(HTMLElement)) return;
  if (!node.style.height && !node.style.getPropertyValue('block-size')) return;
  if (KEEP_PINNED_HEIGHT_TAGS.has(node.tagName)) return;
  // Empty containers (spacers, icons) keep their pinned height — only text
  // flow can reflow, so only text-bearing blocks need to grow.
  if (!node.textContent || !node.textContent.trim()) return;
  node.style.removeProperty('height');
  // block-size is the logical alias of height in horizontal writing modes and
  // is pinned alongside it (only width/height sit on modern-screenshot's
  // exclusion list); leaving it keeps the block clamped even with height gone.
  node.style.removeProperty('block-size');
}

// With heights un-pinned the content may end lower than the measured wrap, so
// the canvas is rendered with bottom headroom and cropped back to the actual
// painted content afterwards.
function canvasHeadroom(cssHeight: number): number {
  return Math.min(600, Math.max(96, Math.round(cssHeight * 0.08)));
}

// Scan up from the bottom for the last non-background row and crop the canvas
// to it plus the wrap's own bottom padding. The bottom-right corner sits in
// the headroom, so it is always background; compare against that pixel.
function cropCanvasBottom(canvas: HTMLCanvasElement, padBottomDevice: number): HTMLCanvasElement {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || w === 0 || h === 0) return canvas;

  let ref: Uint8ClampedArray;
  try {
    ref = ctx.getImageData(w - 1, h - 1, 1, 1).data;
  } catch {
    return canvas;
  }
  const tol = 12;

  // Read in chunks of rows, not row-by-row: each getImageData forces a full
  // GPU readback (the canvas came from modern-screenshot without
  // willReadFrequently, and that flag is fixed at first getContext), so
  // per-row reads take multi-second worst cases on tall captures.
  const chunkRows = 256;
  let contentBottom = 0;
  outer: for (let yEnd = h; yEnd > 0; yEnd -= chunkRows) {
    const yStart = Math.max(0, yEnd - chunkRows);
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, yStart, w, yEnd - yStart).data;
    } catch {
      return canvas;
    }
    const rowBytes = w * 4;
    for (let y = yEnd - 1; y >= yStart; y--) {
      const base = (y - yStart) * rowBytes;
      for (let i = base; i < base + rowBytes; i += 4) {
        if (
          Math.abs(data[i] - ref[0]) > tol ||
          Math.abs(data[i + 1] - ref[1]) > tol ||
          Math.abs(data[i + 2] - ref[2]) > tol ||
          Math.abs(data[i + 3] - ref[3]) > tol
        ) {
          contentBottom = y + 1;
          break outer;
        }
      }
    }
  }
  if (contentBottom === 0) return canvas; // uniform canvas — leave it to the blank check

  const target = Math.min(h, contentBottom + Math.round(padBottomDevice));
  if (target >= h) return canvas;

  const out = canvas.ownerDocument.createElement('canvas');
  out.width = w;
  out.height = target;
  const outCtx = out.getContext('2d');
  if (!outCtx) return canvas;
  outCtx.drawImage(canvas, 0, 0, w, target, 0, 0, w, target);
  return out;
}

// Shared themed rasterizer: render with un-pinned text heights into a canvas
// with bottom headroom, then crop back to the painted content.
async function renderThemedCanvas(
  offscreen: HTMLElement,
  bg: string,
  scale: number,
): Promise<HTMLCanvasElement> {
  const rect = offscreen.getBoundingClientRect();
  const cssWidth = Math.ceil(rect.width);
  const cssHeight = Math.ceil(rect.height);
  const padBottomCss = parseFloat(getComputedStyle(offscreen).paddingBottom) || 0;

  const canvas = await domToCanvas(offscreen, {
    scale,
    backgroundColor: bg,
    width: cssWidth,
    height: cssHeight + canvasHeadroom(cssHeight),
    onCloneEachNode: unpinClonedTextHeights,
  });

  const effScale = cssWidth > 0 ? canvas.width / cssWidth : scale;
  return cropCanvasBottom(canvas, padBottomCss * effScale);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms)),
  ]);
}

async function waitForPaint(): Promise<void> {
  await nextAnimationFrame();
  if (Platform.isMobile) {
    await nextAnimationFrame();
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

interface CanvasTheme {
  background: string;
  text: string;
  muted: string;
  accent: string;
  codeBackground: string;
  font: string;
  monospaceFont: string;
}

interface CanvasRow {
  text: string;
  x: number;
  y: number;
  maxWidth: number;
  fontSize: number;
  lineHeight: number;
  fontWeight: string;
  fontFamily: string;
  color: string;
  background?: string;
  accent?: string;
}

// Mobile: iOS WKWebView rasterizes SVG <foreignObject> unreliably and often
// yields a blank canvas. Try the real themed render first so the output matches
// the note, detect a blank result, and only then fall back to the hand-drawn
// markdown canvas. The previous build always took the fallback, which is why
// mobile captures looked nothing like the note.
async function renderMobileCaptureBlob(
  offscreen: HTMLElement,
  bg: string,
  scale: number,
  wm: WatermarkSettings | null,
  fallbackMarkdown?: string,
): Promise<{ blob: Blob | null; usedFallback: boolean }> {
  try {
    const canvas = await renderThemedCanvas(offscreen, bg, scale);
    if (!isCanvasBlank(canvas)) {
      if (wm?.text.trim()) {
        const effScale = offscreen.offsetWidth > 0 ? canvas.width / offscreen.offsetWidth : scale;
        drawWatermark(canvas, wm, effScale);
      }
      const blob = await canvasToBlob(canvas);
      if (blob) return { blob, usedFallback: false };
    } else {
      console.warn('[screenshot-selection] mobile DOM rasterize came back blank, using canvas fallback');
    }
  } catch (e) {
    console.warn('[screenshot-selection] mobile DOM rasterize failed, using canvas fallback', e);
  }

  if (fallbackMarkdown?.trim()) {
    return { blob: await renderMarkdownCanvasBlob(fallbackMarkdown, wm), usedFallback: true };
  }
  // Nothing to redraw from — return the DOM render even if it is blank, rather
  // than failing outright.
  return { blob: await canvasToBlob(await renderThemedCanvas(offscreen, bg, scale)), usedFallback: true };
}

// Detect a blank/empty rasterization by downscaling and checking whether every
// pixel matches the corner (which sits in the capture wrap's padding, so it is
// always background). Downscaling keeps the scan cheap while still catching
// thin content like text, which averages into non-background pixels.
function isCanvasBlank(canvas: HTMLCanvasElement): boolean {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return true;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false; // cannot inspect → assume real content, keep the render

  let ref: Uint8ClampedArray;
  try {
    ref = ctx.getImageData(0, 0, 1, 1).data; // corner = wrap padding = background
  } catch {
    return false; // tainted/unreadable → keep the render
  }
  const tol = 12;

  // Scan at FULL resolution in horizontal stripes, exiting on the first pixel
  // that differs from the background. (An earlier version downscaled the whole
  // canvas, which averaged thin text into near-background grey and wrongly
  // reported real captures as blank — that bypassed the good render and forced
  // the text fallback.) Content sits near the top, so the common case exits in
  // the first stripe; only a genuinely uniform canvas scans far.
  const stripeRows = 64;
  for (let y = 0; y < h; y += stripeRows) {
    const rows = Math.min(stripeRows, h - y);
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, y, w, rows).data;
    } catch {
      return false;
    }
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (Math.abs(a - ref[3]) > tol) return false;
      if (a < 8) continue; // transparent like the background
      if (
        Math.abs(data[i] - ref[0]) > tol ||
        Math.abs(data[i + 1] - ref[1]) > tol ||
        Math.abs(data[i + 2] - ref[2]) > tol
      ) {
        return false; // a pixel differs from the background → real content
      }
    }
  }
  return true;
}

async function renderMarkdownCanvasBlob(markdown: string, wm: WatermarkSettings | null): Promise<Blob | null> {
  const theme = getCanvasTheme();
  const scale = Math.min(Math.max(window.devicePixelRatio || 2, 1.5), 2.5);
  const cssWidth = Math.min(390, Math.max(320, window.innerWidth - 24));
  const paddingX = 22;
  const paddingY = 20;
  const contentWidth = cssWidth - paddingX * 2;
  const measureCanvas = activeDocument.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  if (!measureCtx) throw new Error('Canvas unavailable');

  const rows = layoutMarkdownCanvasRows(markdown, measureCtx, theme, paddingX, paddingY, contentWidth);
  const lastRow = rows[rows.length - 1];
  const cssHeight = Math.max(80, Math.ceil((lastRow ? lastRow.y + lastRow.lineHeight : paddingY) + paddingY));

  const canvas = activeDocument.createElement('canvas');
  canvas.width = Math.ceil(cssWidth * scale);
  canvas.height = Math.ceil(cssHeight * scale);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');

  ctx.save();
  ctx.scale(scale, scale);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  for (const row of rows) {
    if (row.background) {
      ctx.fillStyle = row.background;
      ctx.fillRect(paddingX - 8, row.y - row.fontSize - 4, contentWidth + 16, row.lineHeight + 4);
    }
    if (row.accent) {
      ctx.fillStyle = row.accent;
      ctx.fillRect(paddingX - 10, row.y - row.fontSize - 2, 3, row.lineHeight + 2);
    }

    ctx.fillStyle = row.color;
    ctx.font = `${row.fontWeight} ${row.fontSize}px ${row.fontFamily}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(row.text, row.x, row.y, row.maxWidth);
  }
  ctx.restore();

  if (wm?.text.trim()) {
    drawWatermark(canvas, wm, scale);
  }

  return await canvasToBlob(canvas);
}

function layoutMarkdownCanvasRows(
  markdown: string,
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  paddingX: number,
  paddingY: number,
  contentWidth: number,
): CanvasRow[] {
  const rows: CanvasRow[] = [];
  let y = paddingY;
  let inCode = false;

  for (const rawLine of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fence = rawLine.match(/^\s*```/);
    if (fence) {
      inCode = !inCode;
      y += rows.length ? 8 : 0;
      continue;
    }

    if (!rawLine.trim()) {
      y += 10;
      continue;
    }

    const style = getMarkdownCanvasLineStyle(rawLine, inCode, theme);
    ctx.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
    const wrapped = wrapCanvasText(ctx, style.text, contentWidth - style.indent);

    for (const line of wrapped) {
      y += style.lineHeight;
      rows.push({
        text: line,
        x: paddingX + style.indent,
        y,
        maxWidth: contentWidth - style.indent,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        fontFamily: style.fontFamily,
        color: style.color,
        background: style.background,
        accent: style.accent,
      });
    }

    y += style.after;
  }

  return rows;
}

function getMarkdownCanvasLineStyle(line: string, inCode: boolean, theme: CanvasTheme) {
  if (inCode) {
    return {
      text: line.replace(/\t/g, '  '),
      indent: 0,
      fontSize: 13,
      lineHeight: 19,
      fontWeight: '400',
      fontFamily: theme.monospaceFont,
      color: theme.text,
      background: theme.codeBackground,
      accent: '',
      after: 0,
    };
  }

  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    const level = heading[1].length;
    const fontSize = level === 1 ? 24 : level === 2 ? 21 : 18;
    return {
      text: stripInlineMarkdown(heading[2]),
      indent: 0,
      fontSize,
      lineHeight: Math.round(fontSize * 1.35),
      fontWeight: '700',
      fontFamily: theme.font,
      color: theme.text,
      background: '',
      accent: '',
      after: 8,
    };
  }

  const quote = line.match(/^\s*>\s?(.*)$/);
  if (quote) {
    return {
      text: stripInlineMarkdown(quote[1].replace(/^\[![^\]]+\]\s*/, '')),
      indent: 8,
      fontSize: 15,
      lineHeight: 22,
      fontWeight: '400',
      fontFamily: theme.font,
      color: theme.text,
      background: '',
      accent: theme.accent,
      after: 2,
    };
  }

  const list = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
  if (list) {
    const marker = /^\d/.test(list[1]) ? `${list[1]} ` : '- ';
    return {
      text: `${marker}${stripInlineMarkdown(list[2].replace(/^\[[ xX]\]\s+/, ''))}`,
      indent: 8,
      fontSize: 16,
      lineHeight: 23,
      fontWeight: '400',
      fontFamily: theme.font,
      color: theme.text,
      background: '',
      accent: '',
      after: 2,
    };
  }

  return {
    text: stripInlineMarkdown(line),
    indent: 0,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '400',
    fontFamily: theme.font,
    color: theme.text,
    background: '',
    accent: '',
    after: 4,
  };
}

function wrapCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) lines.push(current);
    if (ctx.measureText(word).width <= maxWidth) {
      current = word;
    } else {
      const broken = breakLongCanvasWord(ctx, word, maxWidth);
      lines.push(...broken.slice(0, -1));
      current = broken[broken.length - 1] ?? '';
    }
  }

  if (current) lines.push(current);
  return lines;
}

function breakLongCanvasWord(ctx: CanvasRenderingContext2D, word: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';

  for (const ch of Array.from(word)) {
    const candidate = current + ch;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) lines.push(current);
    current = ch;
  }

  if (current) lines.push(current);
  return lines;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m: string, target: string, alias?: string) => `[image: ${alias || target}]`)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m: string, target: string, alias?: string) => alias || target)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, (_m: string, alt: string) => alt ? `[image: ${alt}]` : '[image]')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function getCanvasTheme(): CanvasTheme {
  return {
    background: cssVar('--background-primary', '#ffffff'),
    text: cssVar('--text-normal', '#222222'),
    muted: cssVar('--text-muted', '#666666'),
    accent: cssVar('--interactive-accent', '#7c6df2'),
    codeBackground: cssVar('--code-background', cssVar('--background-secondary', '#f4f4f4')),
    font: cssVar('--font-text', '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'),
    monospaceFont: cssVar('--font-monospace', 'ui-monospace, SFMono-Regular, Menlo, monospace'),
  };
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(activeDocument.body).getPropertyValue(name).trim() || fallback;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

function drawWatermark(canvas: HTMLCanvasElement, wm: WatermarkSettings, scale: number): void {
  const text = wm.text.trim();
  const ctx = canvas.getContext('2d');
  if (!text || !ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const fontPx = Math.max(1, wm.fontSize) * scale;
  const fontFamily = getComputedStyle(activeDocument.body).getPropertyValue('--font-text').trim() || 'sans-serif';

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
  const muted = getComputedStyle(activeDocument.body).getPropertyValue('--text-muted').trim();
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
    // getAbstractFileByPath (since 0.11.11) instead of getFolderByPath (1.5.7)
    // to stay within the declared minAppVersion (1.5.0).
    if (!(app.vault.getAbstractFileByPath(current) instanceof TFolder)) {
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
  return name.replace(/[\\/:*?"<>|#^[\]]+/g, '-').replace(/\s+/g, ' ').trim() || 'note';
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

// Electron's nativeImage needs a real Node Buffer; Obsidian's renderer exposes
// the global, but this browser-typed project has no Node typings for it.
declare const Buffer: { from(data: ArrayBuffer): Uint8Array };

interface ElectronClipboardModule {
  clipboard?: { writeImage(image: unknown): void };
  nativeImage?: { createFromBuffer(buffer: Uint8Array): unknown };
}

// Desktop-only fallback: reach Electron's clipboard through require('electron')
// without an `any` cast (require is not in the renderer's typed globals).
function getElectronClipboardModule(): ElectronClipboardModule | null {
  const req = (window as unknown as { require?: (id: string) => unknown }).require;
  if (typeof req !== 'function') return null;
  return req('electron') as ElectronClipboardModule;
}

async function writeBlobToClipboard(blob: Blob): Promise<void> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return;
  } catch (e) {
    console.warn('[screenshot-selection] navigator.clipboard.write failed, falling back to Electron', e);
  }

  const electron = getElectronClipboardModule();
  if (!electron?.clipboard || !electron.nativeImage) {
    throw new Error('Clipboard API unavailable');
  }
  const buf = Buffer.from(await blob.arrayBuffer());
  electron.clipboard.writeImage(electron.nativeImage.createFromBuffer(buf));
}

function showCaptureError(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('[screenshot-selection]', e);
  new Notice(`Capture failed: ${msg}`, 4000);
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
