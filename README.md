# Browser Coms for Codex

An integrated browser tab styled around VS Code's native browser experience. It can comment on live DOM elements, capture page regions, and attach the result to the current Codex thread.

## What it does

- Opens as a full-width VS Code editor tab with native-themed address, back, forward, reload, comment, and screenshot controls.
- Provides a branded shortcut in the editor title toolbar for opening or revealing the browser.
- Streams a real Chromium page and refreshes the image whenever the rendered UI changes.
- Forwards clicks, scrolling, and keyboard input in **Browse** mode.
- Captures CSS selector, HTML, accessible name, text, page URL, and a screenshot with **Comment on Element**.
- Captures a selected page region and an attached comment with the screenshot toolbar button.
- Lets you draw multiple strokes directly over the browser with the pencil button. Left-drag draws; right-click finishes the drawing and opens its comment box.
- Sends one capture or a batch to the installed OpenAI Codex extension.

The extension uses `chatgpt.addFileToThread`, the command exposed by the Codex extension for editor context. Element comments attach only a generated Markdown context file; area and full-page screenshots attach PNGs. It then opens the Codex sidebar. Codex deliberately does not expose a public command that silently submits a prompt, so the final submit remains under your control.

## Run from source

1. Open this folder in VS Code.
2. Run `npm install` if `node_modules` is not included.
3. Press `F5` and choose **Run Extension**.
4. In the Extension Development Host, run **Browser: Browser Coms for Codex** from the Command Palette.

Chrome, Chromium, Edge, or Brave must be installed. Common Windows, macOS, and Linux locations are detected, including per-user installs. For a custom path, set `browser-coms-for-codex.chromeExecutable`; `~`, `${env:NAME}`, and Windows `%NAME%` variables are supported.

New browser tabs open with the address field focused and a dropdown of recent pages and other open browser tabs. When there are no recent pages yet, `http://localhost:3000` is offered as Home; change `browser-coms-for-codex.homepage` to use a different development server.

The VSIX is platform-independent. On local Windows and macOS workspaces it launches the locally installed browser. In Remote SSH, WSL, Dev Containers, and Codespaces it runs in the workspace extension host, so Chromium must be installed in that remote environment.

## Use

1. Interact with the page normally.
2. Select the speech-bubble button to comment on an element, or select the screenshot icon for an area capture.
3. Type in the anchored **Add a comment** field for the selected element or screenshot area.
4. Press Enter or **+** to add a direct change request and its screenshot to Codex. The Codex composer stays focused; press Enter there to start processing. Escape cancels a draft.

Generated attachment files live in a unique operating-system temporary directory for the browser session. The extension removes that directory when the browser panel or extension closes; the operating system can also clear it as part of normal temporary-file cleanup. Captures stay out of individual projects while the first open workspace folder remains Codex's working directory.

## Limitations

- This is an inspectable Chromium mirror rather than VS Code's Simple Browser iframe. An iframe cannot inspect arbitrary cross-origin DOM or reliably capture sites that forbid embedding.
- DRM media, browser extensions, client certificates, and some anti-bot pages may not work in headless Chromium.
- The supported Codex handoff adds context to the composer; it does not auto-submit a message.
- VS Code commands cannot target the active Codex thread in a different VS Code window. Open this browser in the same window as the target Codex chat.

## Native browser reference

The toolbar follows the open-source VS Code `browserView` implementation: editor background, 16px Codicons, compact URL input, and an edge-to-edge viewport. It includes copy URL, comment controls, screenshot controls, real history availability, reload/stop, external opening, settings, Ctrl/Cmd+L and Ctrl/Cmd+R, Alt+Left/Right, and keyboard-operated context menus.

This is not a drop-in copy of the Electron WebContentsView. Codex annotation actions remain extension-specific. See THIRD_PARTY_NOTICES.md for source attribution.

## Context menu (0.5.0)

- **Add Element to Chat**: select an element to attach its DOM context without a screenshot (Ctrl+Shift+C, or Shift+Cmd+C on macOS).
- **Comment on Elements**: toggle annotation mode; Enter or + attaches your comment to Codex (Ctrl+Alt+C, or Option+Cmd+C on macOS).
- **Add Screenshot to Chat**: attach the current viewport (Ctrl+Alt+S, or Option+Cmd+S on macOS).

The live viewport automatically uses VS Code's current display pixel ratio, so it stays sharp when the window is moved between monitors. Set `browser-coms-for-codex.renderScale` to `1`–`4` only when you want to override automatic matching.

The screenshot icon starts rectangular area selection (Ctrl+Alt+A, or Option+Cmd+A on macOS). Releasing an area drag opens the anchored comment box; Enter or `+` attaches the area image and comment together. Use Ctrl+Alt+S (Option+Cmd+S on macOS) for a full viewport screenshot.

The checkmark tracks comment mode. Menu colors follow the active VS Code theme.

## Browser toolbar and menu (0.14.0)

The toolbar includes standalone comment and screenshot-area controls plus the overflow menu. Neither context icon has an adjacent dropdown.

The overflow menu provides New Tab, page zoom, Find in Page, device viewport presets, external browser opening, navigation history, favorites, site permissions, workspace browser-storage clearing, and browser settings. Standard Ctrl/Cmd shortcuts work while the browser panel has focus.

## Comment interactions (0.6.0)

Comment mode stays active after adding or cancelling a comment. Click outside the composer to dismiss it; that click does not activate the underlying page or select another element. Click again to select the next element. Escape dismisses a draft first; Escape outside the composer exits comment mode. Tab and Shift+Tab cycle between the comment input and Add button. Shift+Enter adds a line break; IME confirmation does not submit.

Selection responses are correlated with requests so a cancelled or superseded selection cannot reopen the composer. Navigation invalidates drafts. Scrolling works while selecting, and leaving the viewport clears the hover. Dragging across elements selects their common ancestor. An attachment failure restores the draft for retry. Existing static markers are hidden after scrolling or navigation to avoid showing stale positions.

Run `npm test` for the helper, attachment, and Chromium interaction regressions. UI tests use installed Chrome at `/usr/bin/google-chrome`; set `BROWSER_EXECUTABLE` to another Chrome/Chromium executable if needed. Tests exercise real DOM inspection and screenshots, with the VS Code/Codex command boundary mocked; they do not submit to a live chat.

## Codex handoff (0.15.0)

Element comments are written as direct browser change requests: their Markdown contains the page URL, target selector, accessible name, and DOM excerpt. Codex receives only that Markdown file, then the exact comment is pasted into the current composer.

Area screenshots send only the selected PNG and paste the exact comment into the composer. Full screenshots send only the PNG and paste a brief `Browser screenshot: <page URL>` prompt. This keeps screenshot handoffs focused while preserving the URL Codex needs for context.

Click the `+` button to add the selected capture to the current Codex composer for review before submission.

Press Enter or click the `+` button to attach the capture, copy the generated prompt to the clipboard, focus Codex, and invoke VS Code's Paste command. Review the prompt and submit from Codex. This uses the current chat without the TODO workflow.

Automatic paste depends on the Codex composer receiving focus. If VS Code reports that paste failed, the extension retries up to three times and shows a message only after every attempt fails. VS Code does not acknowledge whether the text was inserted, so check the prompt before sending. The comment remains on the clipboard because paste delivery is asynchronous. Tests mock the VS Code command boundary; they do not verify insertion into a live Codex sidebar.

## Markers and live updates (0.8.0)

Submitted comments do not leave numbered markers or persistent borders in the browser. The outline and element label appear only while hovering over a target or composing a comment.

The extension checks the rendered Chromium page every `browser-coms-for-codex.refreshInterval` milliseconds (1000 ms by default) and sends a new frame only when the pixels change. Browser interactions refresh immediately. Changes made by Codex appear automatically when the development server applies them through hot reload. If the development server does not support hot reload or is not running, rebuild the app and reload the browser page.
