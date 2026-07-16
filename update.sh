#!/bin/bash

# ===================================================
#   Family Website Monitor — Auto Update Script
#   Pulls the latest changes from GitHub and applies them
# ===================================================

REPO_URL="git@github.com:Moaaz-i/family-website-monitor.git"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   Family Website Monitor Updater     ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Check if git is installed
if ! command -v git &> /dev/null; then
    echo "❌ Error: Git is not installed on this machine"
    exit 1
fi

cd "$SCRIPT_DIR"

# Check if remote origin exists
REMOTE=$(git remote get-url origin 2>/dev/null)
if [ -z "$REMOTE" ]; then
    echo "🔗 No remote found, connecting to GitHub..."
    git remote add origin "$REPO_URL"
fi

echo "📡 Remote: $REMOTE"
echo ""

# Save current commit before updating
BEFORE=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

echo "🔄 Fetching latest updates from GitHub..."
echo "─────────────────────────────────────"

# Fetch updates from remote
git fetch origin main 2>&1

# Check if there are any new updates
LOCAL=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE_HEAD" ]; then
    echo ""
    echo "✅ Already up to date — no new changes found"
    echo "🏷️  Current version: $(git log -1 --format='%h — %s' 2>/dev/null)"
    echo ""
    exit 0
fi

echo ""
echo "📦 New updates available! Applying changes..."
echo "─────────────────────────────────────"

# Apply updates (hard reset to ensure all files are replaced)
git reset --hard origin/main 2>&1

AFTER=$(git rev-parse --short HEAD 2>/dev/null)

echo ""
echo "╔══════════════════════════════════════╗"
echo "║       ✅ Update successful!          ║"
echo "╠══════════════════════════════════════╣"
echo "║  Before: $BEFORE                      "
echo "║  After:  $AFTER                       "
echo "╚══════════════════════════════════════╝"
echo ""
echo "📋 Updated files:"
git diff --name-only "$BEFORE" HEAD 2>/dev/null | sed 's/^/   ✔ /'
echo ""
echo "⚠️  Reload the extension from:"
echo "   chrome://extensions  →  🔄 Reload button"
echo ""
