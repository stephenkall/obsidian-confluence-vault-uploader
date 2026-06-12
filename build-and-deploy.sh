#!/bin/bash

# Setup PATH
export PATH="/c/Program Files/nodejs:$PATH"

# Get version from package.json
VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
echo "📦 Current version: $VERSION"

# Update manifest.json with current version
echo "🔄 Updating manifest.json..."
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" manifest.json

# Build
echo "🏗️  Building plugin..."
npm run build

# Deploy to Obsidian plugins folder
PLUGIN_DEST="C:/Users/zhuvi1/OneDrive - Mars Inc/Desktop/pdls/PDLS_Vault/.obsidian/plugins/obsidian-confluence-vault-uploader"

echo "📁 Copying to: $PLUGIN_DEST"
mkdir -p "$PLUGIN_DEST"

# Copy compiled files
cp main.js "$PLUGIN_DEST/"
cp main.js.map "$PLUGIN_DEST/"
cp manifest.json "$PLUGIN_DEST/"

echo "✅ Build complete! Version $VERSION deployed."
echo "🔄 Reload plugin in Obsidian (Settings → Community plugins → Reload or Ctrl+Shift+P → Reload)"
