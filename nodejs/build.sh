#!/bin/bash
# Build VierrataleAI Node.js version for packaging
set -e

cd "$(dirname "$0")"

echo "Installing dependencies..."
npm install

echo "Testing..."
node bin/vierrataleai.js --version

echo "Packaging..."
npm pack

echo "Build complete!"
echo "To publish: npm publish --tag beta"
