# Obsidian Confluence Vault Uploader

Sync your entire Obsidian vault to Confluence while maintaining the folder structure. Each folder becomes a parent page, and files become child pages organized hierarchically.

## Features
- **Hierarchical Sync**: Maintains Obsidian folder structure in Confluence
- **Smart Browsing**: Built-in page browser to select sync root from Confluence
- **URL Parser**: Paste Confluence URLs directly to set root page
- **Automatic Updates**: Updates existing pages without losing version history
- **Markdown Support**: Converts markdown to HTML using `marked`
- **Folder as Pages**: Folders are created as Confluence pages (can have child pages)

## Setup

### Prerequisites
- Node.js 18+ installed
- Npm or yarn

### Installation Steps
1. Clone or extract the plugin repository
2. Open the folder in VS Code
3. Run `npm install`
4. Run `npm run build`
5. Copy `manifest.json` and `main.js` to your Obsidian plugins folder:
   - Windows: `%APPDATA%\Obsidian\plugins\obsidian-confluence-vault-uploader\`
   - macOS: `~/Library/Application Support/Obsidian/plugins/obsidian-confluence-vault-uploader/`
   - Linux: `~/.obsidian/plugins/obsidian-confluence-vault-uploader/`
6. Reload plugins in Obsidian

## Configuration

1. Open **Settings → Confluence Vault Uploader**
2. Fill in your Confluence credentials:
   - **Confluence Base URL**: e.g., `https://example.atlassian.net/wiki`
   - **Username**: Your Confluence account email
   - **API Token**: [Generate from Confluence](https://id.atlassian.com/manage-profile/security/api-tokens)
   - **Space Key**: The space where pages will be created (e.g., `PDLS`)

3. Select the root page (optional):
   - Paste a page URL directly (e.g., `https://example.atlassian.net/wiki/spaces/PDLS/pages/7279083749/Source+Code`)
   - Or click **Browse** to select from a tree of available pages
   - Leave empty to sync to the space root

## Usage

1. In Obsidian, open the command palette (`Ctrl+P` / `Cmd+P`)
2. Search for "Sync vault to Confluence"
3. Wait for completion notification

The plugin will:
- Create folder pages if they don't exist
- Create/update file pages with content
- Maintain the exact vault folder structure
- Preserve Confluence version history on updates

## Example

If your vault has:
```
vault/
├── Source Code/
│   ├── Architecture.md
│   ├── API Docs/
│   │   └── REST.md
│   └── Setup.md
```

And you select "Source Code" as root, Confluence will have:
```
Source Code (root page)
├── Architecture
├── API Docs
│   └── REST
└── Setup
```

## Notes
- Root page selection is optional; sync to space root if not specified
- Existing pages are updated without losing version history
- Markdown files in root vault directory sync directly under root/space
- Empty folders create empty page containers (helpful for organization)
