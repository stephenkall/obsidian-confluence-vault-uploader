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

## Installation

> **Not yet in the Obsidian community plugin list.** Install manually for now.

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/stephenkall/obsidian-confluence-vault-uploader/releases)
2. Create the folder `<your-vault>/.obsidian/plugins/obsidian-confluence-vault-uploader/`
3. Copy both files into that folder
4. In Obsidian: **Settings → Community plugins → reload**, then enable **Confluence Vault Uploader**

**To build from source:**
```bash
git clone https://github.com/stephenkall/obsidian-confluence-vault-uploader.git
cd obsidian-confluence-vault-uploader
npm install
npm run build
# copy main.js + manifest.json to your vault's plugin folder
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

## Privacy & permissions

This plugin reads **every `.md` file in your vault** to build the page hierarchy and resolve cross-file links. No file content is sent anywhere except to the Confluence instance you configure. Your Confluence credentials (URL, username, API token) are stored locally in Obsidian's plugin data and are never transmitted to any third party.
