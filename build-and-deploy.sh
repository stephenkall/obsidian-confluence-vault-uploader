#!/bin/bash

# Setup PATH for Node.js (Git Bash on Windows)
export PATH="/c/Program Files/nodejs:$PATH"

# Load local vault path from .env (copy .env.example → .env to configure)
if [ -f .env ]; then
  # shellcheck disable=SC1091
  source .env
fi

if [ -z "$OBSIDIAN_PLUGIN_DIR" ]; then
  echo "❌ OBSIDIAN_PLUGIN_DIR not set. Copy .env.example → .env and fill in the path."
  exit 1
fi

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
echo "📁 Copying to: $OBSIDIAN_PLUGIN_DIR"
mkdir -p "$OBSIDIAN_PLUGIN_DIR"

cp main.js "$OBSIDIAN_PLUGIN_DIR/"
cp main.js.map "$OBSIDIAN_PLUGIN_DIR/"
cp manifest.json "$OBSIDIAN_PLUGIN_DIR/"

echo "✅ Build complete! Version $VERSION deployed."
echo "🔄 Reload plugin in Obsidian (Settings → Community plugins → Reload or Ctrl+Shift+P → Reload)"
