# GitHeron

> Web highlights and clippings, synced to GitHub as Markdown.

GitHeron is a [Hypothesis](https://web.hypothes.is/)-style browser extension. Instead of saving annotations to a central server, it saves highlights, notes, tags, and page clippings as Markdown files in a GitHub repository.

You only need one GitHub repository and a token with write access to that repository.

## Browser Support

- Chrome and Chromium browsers use `manifest.json` with Chrome `side_panel`.
- Firefox uses `manifest.firefox.json` with Firefox `sidebar_action` and background scripts. The packaged Firefox build targets Firefox 142 or newer.
- The in-page right-side panel works in both browsers on normal `http` and `https` pages.
- Firefox signing uses the Gecko extension ID in `manifest.firefox.json`.

## Build Packages

```bash
npm run build
```

This creates two release packages:

```text
dist/githeron-chrome-v<version>.zip
dist/githeron-firefox-v<version>.zip
```

For a single browser:

```bash
npm run build:chrome
npm run build:firefox
```

## Load Locally

### Chrome

1. Run `npm run build:chrome`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select `dist/chrome`.

You can also load the repository root directly during development.

### Firefox

Firefox must load the Firefox package, not the repository root. The repository root uses the Chrome manifest.

To try the released build:

1. Download `githeron-firefox-v<version>.zip` from the GitHub release.
2. Unzip it to a local folder.
3. Open `about:debugging#/runtime/this-firefox` in Firefox.
4. Choose **Load Temporary Add-on...**.
5. Select the unzipped `manifest.json`.

For local development:

1. Run `npm run build:firefox`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on...**.
4. Select `dist/firefox/manifest.json`.

Firefox temporary add-ons are removed when Firefox restarts, so load the package again after a browser restart. For permanent installation, the Firefox build needs to be signed through Mozilla Add-ons or Firefox self-distribution.

#### Notes for Firefox:

- The native Firefox sidebar may appear on the left because Firefox owns native sidebar placement. GitHeron still uses its in-page right-side panel for normal web pages.
- If clicking the toolbar button does nothing, reload the current tab after loading the temporary add-on. Existing tabs may not have the content script yet.
- Restricted pages such as `about:*`, browser settings, extension pages, and some store pages cannot host the in-page panel or highlights.
- The Firefox package targets Firefox 142 or newer.

## GitHub token

Use a fine-grained personal access token scoped to one repository. The token needs:

- Repository access: the target repository only
- Repository permissions: **Contents: Read and write**

The extension stores the token in extension local storage and sets the storage access level to trusted extension contexts when the browser supports it, so content scripts cannot read it directly.

## Usage

1. Click the extension button to open the in-page panel on the right.
2. Enter the token, repository (`owner/repo`), branch, and path.
3. Select text on a normal `http` or `https` page.
4. Press the floating annotation button.
5. Add a note or tags in the in-page editor, then save.

The extension uses an in-page right-side panel because browsers control the placement of native sidebars. Restricted browser pages may still fall back to the native browser sidebar or fail to host the in-page panel.
In settings, the floating selection button can be disabled. When it is disabled, use the configured shortcut to annotate the current selection. The default shortcut is `Ctrl+E`.
Use the clipping shortcut, default `Ctrl+O`, to extract the page's main content with Defuddle and save it as Markdown under `Clippings/<page title>.md`.
Settings also include `Background sync`. When enabled, saving an annotation or clipping updates the local page immediately, queues the GitHub write in the background, and shows sync status with a retry action for failed syncs.

Each page is committed as a readable Markdown file. The filename uses the current date plus the page title truncated to 20 characters:

```text
annotations/
  2026-04-28-link-title.md
```

When an older dated file for the same URL already exists, the extension writes the updated content to today's filename and removes the older file. The Markdown file includes YAML frontmatter for search and page metadata plus visible `Metadata` and `Highlights` sections.

The selector data needed to restore highlights is stored separately in:

```text
annotations/
  .gh-annotator/
    <url-sha256>.json
```

The Markdown frontmatter only keeps a short `annotation_data` pointer to that sidecar file.

Saving an annotation updates the Markdown file, the sidecar metadata file, and any old dated filename removal in one Git commit. With background sync enabled, that commit is created by the background queue after the annotation is saved locally.
Saving a clipping writes a separate Markdown file to the configured clip path. With background sync enabled, the clipping is queued locally first and committed to GitHub by the background worker.

## Current scope

- Works on normal web pages.
- Stores quote, prefix/suffix context, note, tags, color, URL, and title.
- Automatically restores page highlights from GitHub when a page opens.
- Shows the current page annotation count as a badge on the extension button.
- Shows status on the extension badge when the current page has been clipped and synced, unless annotations are already using the badge for their count.
- Caches page annotations locally and can sync them back from GitHub.
- Stores recently used tags locally and shows them as quick-select chips when adding notes.
- Uses the vendored Defuddle browser bundle for main-content clipping.
- Clicking a highlight opens the saved note in an in-page extension panel and also tries to open the native browser sidebar when available.
- PDF support is intentionally left for a later phase because browser PDF viewers are not ordinary pages for content script injection.

## Release

Publish Chrome and Firefox as separate assets for the same tag:

```text
githeron-chrome-v<version>.zip
githeron-firefox-v<version>.zip
```
