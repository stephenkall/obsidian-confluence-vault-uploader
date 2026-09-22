# Obsidian Confluence Vault Uploader

Sync your entire Obsidian vault to Confluence, preserving the folder structure as a page hierarchy. Obsidian wiki links become real Confluence page links, callout blocks become Confluence macros, and code blocks get syntax highlighting.

## Features

- **Full vault sync** — every `.md` file becomes a Confluence page nested under the correct parent
- **Folder pages** — each folder is a Confluence page; files starting with `_` (MOC files) supply its content
- **Wiki link resolution** — `[[Page]]`, `[[Folder/Page]]`, `[[Page|Display Text]]`, and `![[Embed]]` all become working Confluence links
- **Callout conversion** — Obsidian `> [!note]`, `> [!warning]`, `> [!tip]`, `> [!danger]` etc. become Confluence info/warning/tip panels
- **Code block macros** — fenced code blocks with a language tag become Confluence code macros with syntax highlighting
- **Two-phase sync** — Phase 1 creates all pages; Phase 2 wires up every cross-page link so nothing is left broken
- **Incremental updates** — re-running only updates changed pages, preserving Confluence version history
- **Live status** — a status bar item always shows idle/syncing/last-result state; click it (or run **Show Confluence sync status**) for details
- **Configurable logging** — choose None/Normal/Verbose logging and inspect it any time with **Show Confluence sync log**, without opening the developer console
- **Cache repair** — **Repair Confluence sync cache** validates every cached page mapping and clears stale entries that cause `404` errors, queuing the affected files for re-sync

## Installation

> **Not yet in Obsidian's official Community Plugins directory** (submission pending — see below). Install manually for now. Because Obsidian's built-in "Check for updates" only manages plugins installed through that official directory, a manually installed copy will **not** auto-update; repeat these steps for each new release, or watch/star the repo for release notifications.

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/stephenkall/obsidian-confluence-vault-uploader/releases)
2. Create the folder `<your-vault>/.obsidian/plugins/confluence-vault-uploader/` — the folder name must match the `id` in `manifest.json` (`confluence-vault-uploader`)
3. Copy all three files into that folder
4. In Obsidian: **Settings → Community plugins → reload**, then enable **Confluence Vault Uploader**

**To build from source:**
```bash
git clone https://github.com/stephenkall/obsidian-confluence-vault-uploader.git
cd obsidian-confluence-vault-uploader
npm install
npm run build
# copy main.js + manifest.json + styles.css to your vault's plugin folder
```

## Configuration

Open **Settings → Confluence Vault Uploader** and fill in:

| Field | Description |
|---|---|
| **Confluence base URL** | e.g. `https://yourcompany.atlassian.net/wiki` |
| **Username** | Your Atlassian account email |
| **API token** | [Generate at Atlassian](https://id.atlassian.com/manage-profile/security/api-tokens) |
| **Root page URL** | Paste the full URL of the Confluence page that will be the sync root (space key and page ID are extracted automatically). Leave empty to sync under the space root. |

After filling in the root page URL, a confirmation line shows the extracted space and page ID. Use **Test Connection** to verify credentials before syncing.

## Usage

1. Open the command palette (`Ctrl+P` / `Cmd+P`)
2. Run **Sync vault to Confluence**
3. A progress notice appears for each file; a final notice reports success/failure counts

### Commands

| Command | Purpose |
|---|---|
| **Sync vault to Confluence** | Runs the full two-phase sync. Resumes automatically from the last checkpoint if a previous run stopped early. |
| **Stop Confluence sync** | Cancels an in-progress sync after the current file finishes. Progress is saved. |
| **Show Confluence sync status** | Opens a status panel: current state, progress, cached page count, log level, and the last completed sync's result. |
| **Show Confluence sync log** | Opens the in-app sync log (respects the log level below), with copy-to-clipboard and clear actions. |
| **Repair Confluence sync cache** | Validates every cached page mapping against Confluence and drops stale ones, queuing affected files for re-sync. Run this if sync reports `404` errors. |
| **Clear Confluence sync cache** | Wipes all cached state; the next sync starts completely fresh. |
| **Update Confluence page links (Phase 2)** | Re-runs only the cross-page link resolution step, without re-syncing page content. |

### Sync visibility

You never have to guess whether a sync is running, idle, or stuck:

- The **status bar** (bottom of the Obsidian window) always shows the current state and updates per file during a sync. Click it to open the full status panel.
- The **log level** setting (Settings → Confluence Vault Uploader → Sync visibility) controls how much detail is captured: `None` (errors only), `Normal` (per-file progress), or `Verbose` (per-request detail, also mirrored to the developer console). Errors are always captured regardless of this setting.
- If a sync is interrupted by an unexpected error, it no longer fails silently — a notice explains what happened, progress up to that point is saved, and the failure is recorded in the log and in the status panel's "last sync" summary.

## Vault conventions

### Folder pages and MOC files

A file whose name starts with `_` (e.g. `_Overview MOC.md`) is treated as the **content** of its parent folder's Confluence page rather than as a separate child page. This lets you write a rich index for each section.

```
01 - Overview/
├── _Overview MOC.md      ← becomes the body of the "01 - Overview" page
├── Architecture.md       ← child page
└── System Landscape.md   ← child page
```

### Wiki links

All standard Obsidian link formats are supported and resolved to real Confluence URLs in Phase 2:

| Obsidian syntax | Result |
|---|---|
| `[[Page Name]]` | Link to that page |
| `[[Folder/Page Name]]` | Link using a partial path (resolved from any depth) |
| `[[Page Name\|Display text]]` | Link with custom display text |
| `![[Page Name]]` | Embed converted to a link |

### Callouts

| Obsidian callout | Confluence macro |
|---|---|
| `> [!note]`, `> [!info]` | Info panel |
| `> [!tip]`, `> [!success]` | Tip panel |
| `> [!warning]`, `> [!caution]` | Warning panel |
| `> [!danger]`, `> [!error]`, `> [!bug]` | Warning panel |

## Notes

- Pages are matched by title within their parent; renaming a file creates a new page (the old one is not deleted automatically)
- The sync is safe to re-run; existing pages are updated in place
- Images embedded via `![[file.jpg]]` become links (Confluence image upload is not yet supported)
- Task list items (`- [ ]` / `- [x]`) are converted to `☐`/`☑` plain text, since Confluence storage format does not support HTML checkbox elements
- Confluence requires page titles to be unique within a space, regardless of folder structure — unlike a filesystem, which allows the same filename in different folders. If a file or folder name is used more than once in the vault (e.g. paired "logical"/"physical" exports sharing a GUID filename), that page's Confluence title is automatically prefixed with just enough of its parent path to make it unique (e.g. `seg_0/GUID.xml` instead of a bare `GUID.xml`), instead of failing with `Request failed, status 400`. This only affects the Confluence-visible title — internal link resolution always uses the full vault path, so links are unaffected. If one member of a colliding group already synced under its old bare title (e.g. from before this behavior existed), the next sync automatically renames it to match the same disambiguated scheme, so the whole group ends up styled consistently.

## Privacy & permissions

This plugin reads **every `.md` file in your vault** to build the page hierarchy and resolve cross-file links. No file content is sent anywhere except to the Confluence instance you configure. Your Confluence credentials (URL, username, API token) are stored locally in Obsidian's plugin data and are never transmitted to any third party.
