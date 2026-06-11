# Obsidian Confluence Vault Uploader

An Obsidian plugin that pushes an entire vault into a Confluence parent page folder using the Confluence REST API.

## Features
- Push all markdown files in the vault to Confluence
- Convert markdown to HTML via `marked`
- Create or update Confluence pages under a specified parent page
- Configure base URL, space, parent page, and credentials in plugin settings

## Setup
1. Open the plugin folder in VS Code.
2. Run `npm install`.
3. Run `npm run build`.
4. Copy `manifest.json`, `main.js`, and `styles.css` (if added) to your Obsidian community plugins folder.
5. Enable the plugin in Obsidian.

## Usage
1. Open Settings → Confluence Vault Uploader
2. Enter your Confluence Base URL, username, API token, space key, and parent page ID.
3. Use the command palette to run `Push vault to Confluence`.

## Notes
- Confluence uses the parent page ID as the upload folder anchor.
- This plugin uploads each markdown file as a separate Confluence page.
- Page titles are generated from the file path relative to the vault root.
