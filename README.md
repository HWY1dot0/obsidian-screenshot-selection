# Screenshot Selection

Capture note content in Obsidian as a PNG. On desktop, selected rendered content is copied to the system clipboard. On mobile, selected text or the current markdown block is copied to the clipboard when possible, with a vault file fallback.

The image inherits your current Obsidian theme (fonts, colors, callouts, code highlighting), so the output looks the way the note looks on screen.

![Screenshot Selection demo — select content, run the command, paste a theme-faithful PNG](https://raw.githubusercontent.com/HWY1dot0/obsidian-screenshot-selection/main/images/demo.gif)

## Features

- Works in Reading View and Live Preview
- Preserves your theme — dark / light, fonts, callouts, code highlighting
- Captures the full selection, even if it scrolls beyond the screen
- Desktop: copies straight to the system clipboard — no save dialog or file management
- Mobile: copies to the clipboard, or saves to `Attachments/Screenshots/` if iOS blocks image writing; can also capture the current block without a precise touch selection
- Capture from the camera ribbon icon or the editor context menu
- Optional watermark — a corner label or a diagonal tiled overlay

## Install

### From the Community Plugins browser

1. Settings → Community plugins → Browse
2. Search for "Screenshot Selection"
3. Install and enable

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/HWY1dot0/obsidian-screenshot-selection/releases/latest)
2. Drop them into `<your-vault>/.obsidian/plugins/screenshot-selection/`
3. Settings → Community plugins → reload and enable "Screenshot Selection"

## Usage

### Desktop

1. Open a note, switch to Reading View or Live Preview
2. Select the content you want to capture (drag-select with the mouse)
3. Open the command palette (`Cmd-P` / `Ctrl-P`) and run **Capture selection to clipboard**
4. Paste (`Cmd-V` / `Ctrl-V`) into any app that accepts images

Assign a hotkey via Settings → Hotkeys for one-keystroke capture.

### Mobile

1. Open a note — Reading View gives the most faithful result
2. Select the text you want to capture (or, in the editor, place the cursor inside a block to capture the whole block)
3. Tap the camera ribbon action, use the editor menu item, or run **Capture selection or block to file**
4. If clipboard writing succeeds, paste the PNG into another app
5. If iOS rejects clipboard writing, the PNG is saved under `Attachments/Screenshots/`; when possible, an image embed is inserted below the captured block

## Watermark (optional)

Off by default. To brand or protect your screenshots, enable a watermark in **Settings → Screenshot Selection**:

- **Style** — *Corner label* (a short line in the corner you choose) or *Diagonal tiled* (repeated text across the whole image)
- **Text** — any string, e.g. your handle
- **Opacity** — `0`–`1`; a corner label looks good around `0.5`, a tiled overlay around `0.1`
- **Font size**, and **color** (leave blank to use the theme's muted text color)

The watermark is drawn onto the image at capture time, so it stays on the PNG you paste or save.

## Known limits

- Desktop clipboard capture expects a rendered selection — switch to Live Preview or Reading View
- Mobile is most faithful in Reading View; Live Preview clones the editor DOM and may look different. If iOS can't rasterize the selection, the capture falls back to a plainer text render
- Mobile clipboard image write may still be rejected by iOS; the plugin falls back to saving a vault file
- Cross-origin embeds (iframes, external PDFs) are hidden in the captured image
- Very tall selections are rejected — split into smaller captures

## Build from source

```bash
git clone https://github.com/HWY1dot0/obsidian-screenshot-selection
cd obsidian-screenshot-selection
npm install
OBSIDIAN_VAULT=~/path/to/your/vault npm run build
```

The build copies `main.js`, `manifest.json`, and `styles.css` to `<OBSIDIAN_VAULT>/.obsidian/plugins/screenshot-selection/`. Use `npm run dev` for watch mode.

## Network usage

This plugin makes no network requests of its own. It uses the `modern-screenshot` library, which — when rendering a selection that contains externally-hosted images (e.g. `<img src="https://...">`) — may have your browser fetch those images so they can be embedded in the capture. No data is sent to any third-party server by the plugin.

## More plugins by HWY1dot0

- [Calendar Hub](https://github.com/HWY1dot0/calendar-hub) — one calendar that surfaces every note from a given day, in any folder.
- [Copy for Email](https://github.com/HWY1dot0/obsidian-copy-for-email) — copy notes as rich text that survives pasting into Gmail, Outlook and Apple Mail.

If this plugin helps your workflow, you can [buy me a coffee](https://www.buymeacoffee.com/hwy1dot0).

## License

MIT — see [LICENSE](LICENSE).
