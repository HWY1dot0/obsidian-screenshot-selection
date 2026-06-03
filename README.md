# Screenshot Selection

Capture the currently selected content in an Obsidian note as a PNG and copy it to the system clipboard. Useful for sharing a snippet of a rendered note to WeChat, Xiaohongshu, Slack, or anywhere else that accepts pasted images.

The image inherits your current Obsidian theme (fonts, colors, callouts, code highlighting), so the output looks the way the note looks on screen.

## Features

- Works in Reading View and Live Preview
- Captures the full selection, even if it scrolls beyond the viewport
- Preserves theme styling — dark / light, custom fonts, callouts, code blocks
- Output goes straight to the system clipboard — no save dialog, no file management
- Optional watermark — a corner label or a diagonal tiled overlay
- Desktop only (clipboard image write is unreliable on mobile Obsidian)

## Install

### From the Community Plugins browser (after the plugin is accepted)

1. Settings → Community plugins → Browse
2. Search for "Screenshot Selection"
3. Install and enable

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/HWY1dot0/obsidian-screenshot-selection/releases/latest)
2. Drop them into `<your-vault>/.obsidian/plugins/screenshot-selection/`
3. Settings → Community plugins → reload and enable "Screenshot Selection"

## Usage

1. Open a note, switch to Reading View or Live Preview
2. Select the content you want to capture (drag-select with the mouse)
3. Open the command palette (`Cmd-P` / `Ctrl-P`) and run **Screenshot selection to clipboard**
4. Paste (`Cmd-V` / `Ctrl-V`) into any app that accepts images

Assign a hotkey via Settings → Hotkeys for one-keystroke capture.

## Watermark (optional)

Off by default. To brand or protect your screenshots, enable a watermark in **Settings → Screenshot Selection**:

- **Style** — *Corner label* (a short line in the corner you choose) or *Diagonal tiled* (repeated text across the whole image)
- **Text** — any string, e.g. your handle
- **Opacity** — `0`–`1`; a corner label looks good around `0.5`, a tiled overlay around `0.1`
- **Font size**, and **color** (leave blank to use the theme's muted text color)

The watermark is drawn onto the image at capture time, so it stays on the PNG you paste.

## Known limits

- Source mode (raw markdown) is not supported — switch to Live Preview or Reading View
- Cross-origin embeds (iframes, external PDFs) are hidden in the captured image
- Very tall selections (above ~30000px rendered height) are rejected — split into smaller captures

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

## License

MIT — see [LICENSE](LICENSE).
