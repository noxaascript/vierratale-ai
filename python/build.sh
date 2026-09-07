#!/bin/bash
# Build VierrataleAI standalone binary
set -e

echo "Building VierrataleAI..."

cd "$(dirname "$0")"

# Install dependencies
pip install -r requirements.txt
pip install pyinstaller

# Build binary
pyinstaller \
  --onefile \
  --name vierrataleai \
  --add-data "vierrataleai/prompts:vierrataleai/prompts" \
  --clean \
  vierrataleai/__main__.py

echo "Build complete: dist/vierrataleai"
echo "Run: ./dist/vierrataleai"
