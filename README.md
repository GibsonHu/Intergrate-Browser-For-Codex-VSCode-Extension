# Integrated Browser for Codex

## Share the live browser with Codex

Version 0.17.0 exposes the live tab through an MCP server named `integrated_browser`. Click **Share Browser with Codex** at the right of the address bar and select Allow. This attaches the tab ID and pastes a prompt into the current Codex composer. Press Send to start. Codex can discover the tab, inspect its DOM/accessibility tree, see screenshots, and use selectors or screenshot coordinates to click, type, scroll, drag, navigate, and reload. Actions happen in the same visible tab. Copy Address is in More Actions.

The button highlights while sharing; click it again to stop. Closing the tab also revokes the connection. An action already in progress may finish. The MCP process discovers only explicitly shared tabs via private session files and authenticated localhost connections. Credentials never appear in tool results or chat attachments. Codex and the MCP process must run on the same host as the extension (the remote machine for Remote SSH). This is a custom browser MCP integration, not the built-in Codex browser provider.

### One-time MCP setup

Use Node.js 20 or newer. Register the bundled server with Codex, replacing the path with the actual extension installation directory (or this source checkout after `npm install`):

```sh
codex mcp add integrated_browser -- node /absolute/path/to/extension/src/browser-mcp.js
```

Use an absolute Node executable path if your default Node is older. Restart the Codex session after adding the server so its tools load. The server may start before any tab is shared; `browser_tabs` will then return an empty list. After sharing, the tab becomes discoverable without restarting the server. If upgrading removes the old installation directory, re-register using the new path.

The tools are `browser_tabs`, `browser_dom`, `browser_inspect`, `browser_screenshot`, `browser_navigate`, `browser_reload`, `browser_click`, `browser_click_xy`, `browser_fill`, `browser_type`, `browser_press`, `browser_scroll`, and `browser_drag`. Each page tool requires the explicit `tabId` returned by discovery or the share attachment. Screenshots are returned as MCP images. Coordinates use CSS pixels in that screenshot; device scale is 1. DOM inspection is limited to 500 visible main-document elements and 30,000 characters of page text. Use screenshots and coordinate actions for canvas, shadow DOM, and iframe content. Codex performs the observe/action/verify loop when you send a browser task; sharing alone does not submit a task or start an independent agent.

An integrated browser tab styled around VS Code's native browser experience. It can comment on live DOM elements, capture page regions, and attach the result to the current Codex thread.

## What it does

- Opens as a full-width VS Code editor tab with native-themed address, back, forward, reload, and split context controls.
- Streams a real Chromium page and refreshes the image whenever the rendered UI changes.
- Forwards clicks, scrolling, and keyboard input in **Browse** mode.
- Captures CSS selector, HTML, accessible name, text, page URL, and a screenshot with **Comment on Element**.
- Captures a selected page region and an attached comment with the screenshot toolbar button.
- Sends one capture or a batch to the installed OpenAI Codex extension.

The extension uses `chatgpt.addFileToThread`, the command exposed by the Codex extension for editor context. Element comments attach a generated Markdown context file and PNG; area and full-page screenshots attach only PNGs. It then opens the Codex sidebar. Codex deliberately does not expose a public command that silently submits a prompt, so the final submit remains under your control.

## Run from source

1. Open this folder in VS Code.
2. Run `npm install` if `node_modules` is not included.
3. Press `F5` and choose **Run Extension**.
4. In the Extension Development Host, run **Browser: Open Integrated Browser for Codex** from the Command Palette.

Chrome, Chromium, Edge, or Brave must be installed. Common Windows, macOS, and Linux locations are detected, including per-user installs. For a custom path, set `intergrateBrowserForCodex.chromeExecutable`; `~`, `${env:NAME}`, and Windows `%NAME%` variables are supported.

The default page is `http://localhost:3000`; change `intergrateBrowserForCodex.homepage` for a different development server.

The VSIX is platform-independent. On local Windows and macOS workspaces it launches the locally installed browser. In Remote SSH, WSL, Dev Containers, and Codespaces it runs in the workspace extension host, so Chromium must be installed in that remote environment.

## Use

1. Interact with the page normally.
2. Select the speech-bubble button to comment on an element, or select the adjacent screenshot button and drag a rectangular area.
3. Type in the anchored **Add a comment** field for the selected element or screenshot area.
4. Press Enter or **+** to add a direct change request and its screenshot to Codex. The Codex composer stays focused; press Enter there to start processing. Escape cancels a draft.

Generated capture files live under `~/.intergrate-browser-for-codex/captures`. They stay out of individual projects while the first open workspace folder remains Codex's working directory.

## Limitations

- This is an inspectable Chromium mirror rather than VS Code's Simple Browser iframe. An iframe cannot inspect arbitrary cross-origin DOM or reliably capture sites that forbid embedding.
- DRM media, browser extensions, client certificates, and some anti-bot pages may not work in headless Chromium.
- The supported Codex handoff adds context to the composer; it does not auto-submit a message.
- VS Code commands cannot target the active Codex thread in a different VS Code window. Open this browser in the same window as the target Codex chat.

## Native browser reference

The toolbar follows the open-source VS Code `browserView` implementation: editor background, 16px Codicons, compact URL input, and an edge-to-edge viewport. Version 0.4.0 matches the supplied reference with a 32px icon-only toolbar, copy URL action, comment controls, overflow menu, and a selection-anchored comment field with an element/dimensions label. Includes real history availability, reload/stop, external opening, settings, Ctrl/Cmd+L and Ctrl/Cmd+R, Alt+Left/Right, and keyboard-operated context menus.

This is not a drop-in copy of the Electron WebContentsView. Codex annotation actions remain extension-specific. See THIRD_PARTY_NOTICES.md for source attribution.

## Context menu (0.5.0)

- **Add Element to Chat**: select an element to attach its DOM context and screenshot immediately (Ctrl+Shift+C, or Shift+Cmd+C on macOS).
- **Comment on Elements**: toggle annotation mode; Enter or + attaches your comment to Codex (Ctrl+Alt+C, or Option+Cmd+C on macOS).
- **Add Console Logs to Chat**: attach up to 500 recent console messages and page errors recorded since this browser opened.
- **Add Screenshot to Chat**: attach the current viewport (Ctrl+Alt+S, or Option+Cmd+S on macOS).

The dedicated screenshot button beside the comment control starts rectangular area selection (Ctrl+Alt+A, or Option+Cmd+A on macOS). Releasing the drag opens the anchored comment box; Enter or `+` attaches the area image and comment together.

The checkmark tracks comment mode. Menu colors follow the active VS Code theme.

## Browser toolbar and menu (0.14.0)

The toolbar includes the split comment control, a commented-area screenshot button, a Developer Tools button, and the overflow menu. Developer Tools docks the live page on the left and Chromium's bundled remote debugging frontend on the right. Elements, Console, Sources, Network, styles, device controls, and the standard Chromium tools operate against the live page. Drag the center divider to resize the panes, or select the Developer Tools button again to close the dock.

The overflow menu provides New Tab, page zoom, Find in Page, device viewport presets, external browser opening, navigation history, favorites, site permissions, workspace browser-storage clearing, and browser settings. Standard Ctrl/Cmd shortcuts work while the browser panel has focus.

## Comment interactions (0.6.0)

Comment mode stays active after adding or cancelling a comment. Click outside the composer to dismiss it; that click does not activate the underlying page or select another element. Click again to select the next element. Escape dismisses a draft first; Escape outside the composer exits comment mode. Tab and Shift+Tab cycle between the comment input and Add button. Shift+Enter adds a line break; IME confirmation does not submit.

Selection responses are correlated with requests so a cancelled or superseded selection cannot reopen the composer. Navigation invalidates drafts. Scrolling works while selecting, and leaving the viewport clears the hover. Dragging across elements selects their common ancestor. Attachments use the screenshot saved when the element was selected (up to 50 recent selections per browser session). An attachment failure restores the draft for retry. Existing static markers are hidden after scrolling or navigation to avoid showing stale positions.

Run `npm test` for the helper, attachment, and Chromium interaction regressions. UI tests use installed Chrome at `/usr/bin/google-chrome`; set `BROWSER_EXECUTABLE` to another Chrome/Chromium executable if needed. Tests exercise real DOM inspection and screenshots, with the VS Code/Codex command boundary mocked; they do not submit to a live chat.

## Codex handoff (0.15.0)

Element comments are written as direct browser change requests: their Markdown contains the page URL, target selector, accessible name, DOM excerpt, and screenshot reference. Codex receives that Markdown and the PNG, then the exact comment is pasted into the current composer.

Area screenshots send only the selected PNG and paste the exact comment into the composer. Full screenshots send only the PNG and paste a brief `Browser screenshot: <page URL>` prompt. This keeps screenshot handoffs focused while preserving the URL Codex needs for context.

Click the `+` button to add the selected capture to the current Codex composer for review before submission.

Press Enter or click the `+` button to attach the capture, copy the generated prompt to the clipboard, focus Codex, and invoke VS Code's Paste command. Review the prompt and submit from Codex. This uses the current chat without the TODO workflow.

Automatic paste depends on the Codex composer receiving focus. VS Code does not acknowledge whether the text was inserted, so check the prompt before sending. The comment remains on the clipboard because paste delivery is asynchronous. Tests mock the VS Code command boundary; they do not verify insertion into a live Codex sidebar.

## Markers and live updates (0.8.0)

Submitted comments do not leave numbered markers or persistent borders in the browser. The outline and element label appear only while hovering over a target or composing a comment.

The extension checks the rendered Chromium page every `intergrateBrowserForCodex.refreshInterval` milliseconds (700 ms by default) and sends a new frame only when the pixels change. Changes made by Codex appear automatically when the development server applies them through hot reload. If the development server does not support hot reload or is not running, rebuild the app and reload the browser page.
