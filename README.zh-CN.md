[English](README.md) | **简体中文**

# Screenshot Selection

把 Obsidian 里的笔记内容截成 PNG 图片。桌面端会把选中的渲染内容复制到系统剪贴板；移动端在可能的情况下把选中文字或当前 Markdown 块复制到剪贴板，并以库内文件作为回退。

图片会继承你当前的 Obsidian 主题（字体、配色、callout、代码高亮），所以截出来的样子跟笔记在屏幕上的样子一致。

![Screenshot Selection 演示 —— 选中内容、执行命令、粘出忠于主题的 PNG](https://raw.githubusercontent.com/HWY1dot0/obsidian-screenshot-selection/main/images/demo.gif)

## 功能

- 在阅读视图和实时预览里都能用
- 保留你的主题 —— 深色 / 浅色、字体、callout、代码高亮
- 完整截取整个选区，即使它滚出了屏幕
- 桌面端：直接复制到系统剪贴板 —— 没有保存对话框，也不用管理文件
- 移动端：复制到剪贴板；若 iOS 拦截了图片写入，则保存到 `Attachments/Screenshots/`；也可以不做精确触摸选择，直接截取当前块
- 从相机侧栏图标或编辑器右键菜单发起截图
- 可选水印 —— 一个角标，或斜向平铺的覆盖文字

## 安装

### 从社区插件浏览器安装

1. 设置 → 第三方插件 → 浏览
2. 搜索 "Screenshot Selection"
3. 安装并启用

### 手动安装

1. 从[最新发布](https://github.com/HWY1dot0/obsidian-screenshot-selection/releases/latest)下载 `main.js`、`manifest.json`、`styles.css`
2. 放进 `<你的库>/.obsidian/plugins/screenshot-selection/`
3. 设置 → 第三方插件 → 重载并启用 "Screenshot Selection"

## 使用

### 桌面端

1. 打开一篇笔记，切到阅读视图或实时预览
2. 选中你想截取的内容（用鼠标拖选）
3. 打开命令面板（`Cmd-P` / `Ctrl-P`），执行 **Capture selection to clipboard**
4. 在任何接受图片的应用里粘贴（`Cmd-V` / `Ctrl-V`）

可在 设置 → 快捷键 里为它绑定一个快捷键，实现一键截图。

### 移动端

1. 打开一篇笔记 —— 阅读视图效果最忠实
2. 选中你想截取的文字（或在编辑器里把光标放进某个块，以截取整个块）
3. 点相机侧栏图标、用编辑器菜单项，或执行 **Capture selection or block to file**
4. 若剪贴板写入成功，把 PNG 粘到另一个应用里
5. 若 iOS 拒绝了剪贴板写入，PNG 会保存到 `Attachments/Screenshots/`；条件允许时，会在被截取的块下方插入一个图片嵌入

## 水印（可选）

默认关闭。若要给截图打上品牌或加以保护，在 **设置 → Screenshot Selection** 里启用水印：

- **样式** —— *角标*（放在你选定的角落的一小行字）或 *斜向平铺*（在整张图上重复的文字）
- **文字** —— 任意字符串，例如你的用户名
- **不透明度** —— `0`–`1`；角标在 `0.5` 左右好看，平铺在 `0.1` 左右好看
- **字号**，以及**颜色**（留空则用主题的柔和文字色）

水印在截图时就画进图片里，所以它会留在你粘贴或保存的 PNG 上。

## 已知限制

- 桌面端剪贴板截图需要一个已渲染的选区 —— 请切到实时预览或阅读视图
- 移动端在阅读视图最忠实；实时预览会克隆编辑器 DOM，看起来可能有出入。若 iOS 无法栅格化选区，截图会回退到较朴素的文字渲染
- 移动端剪贴板图片写入仍可能被 iOS 拒绝；此时插件回退到保存库内文件
- 跨源嵌入（iframe、外部 PDF）会在截图里被隐藏
- 过高的选区会被拒绝 —— 请拆成几段分别截取

## 从源码构建

```bash
git clone https://github.com/HWY1dot0/obsidian-screenshot-selection
cd obsidian-screenshot-selection
npm install
OBSIDIAN_VAULT=~/path/to/your/vault npm run build
```

构建会把 `main.js`、`manifest.json`、`styles.css` 拷到 `<OBSIDIAN_VAULT>/.obsidian/plugins/screenshot-selection/`。用 `npm run dev` 进入监听模式。

## 网络使用

本插件自身不发起任何网络请求。它用到 `modern-screenshot` 库 —— 当渲染的选区里含有外部托管的图片（例如 `<img src="https://...">`）时，该库可能让你的浏览器去拉取那些图片，以便把它们嵌进截图。插件不会把任何数据发往任何第三方服务器。

## HWY1dot0 的其它插件

- [Calendar Hub](https://github.com/HWY1dot0/calendar-hub) —— 一个日历，浮出某一天散落在各文件夹里的每一篇笔记。
- [Copy for Email](https://github.com/HWY1dot0/obsidian-copy-for-email) —— 把笔记复制成富文本，粘进 Gmail、Outlook、Apple Mail 排版不散。

如果这个插件帮到了你的工作流，可以[请我喝杯咖啡](https://www.buymeacoffee.com/hwy1dot0)。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
