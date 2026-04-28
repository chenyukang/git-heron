# GitHub Web Annotator

Github Web Annotator is [web.hypothes](https://web.hypothes.is/) like chrome extension, but instead of saving annotations to a central server, it saves them as Markdown files in a GitHub repository. This allows users to keep their annotations private, version-controlled, and easily accessible alongside their other code or notes.

You just need one Github repo and a token with write access to that repo, everything works!

## Load locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select this directory: `/path/to/github-hypo`.

## Screenshot



## GitHub token

Use a fine-grained personal access token scoped to one repository. The token needs:

- Repository access: the target repository only
- Repository permissions: **Contents: Read and write**

The extension stores the token in `chrome.storage.local` and sets the storage access level to trusted extension contexts so content scripts cannot read it directly.

## Usage

1. Click the extension button to open the in-page panel on the right.
2. Enter the token, repository (`owner/repo`), branch, and path.
3. Select text on a normal `http` or `https` page.
4. Press the floating annotation button.
5. Add a note or tags in the in-page editor, then save.

The extension uses an in-page right-side panel because Chrome controls the placement of its native side panel. Restricted browser pages may still fall back to the native side panel.
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
- Clicking a highlight opens the saved note in an in-page extension panel and also tries to open the Chrome side panel.
- PDF support is intentionally left for a later phase because browser PDF viewers are not ordinary pages for content script injection.
