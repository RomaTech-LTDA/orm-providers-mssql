#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# publish.sh — Build verification and npm publish for @romatech/orm-providers-mssql
# ---------------------------------------------------------------------------
# Usage:
#   ./publish.sh          # bump minor and publish (default)
#   ./publish.sh patch    # bump patch, then publish
#   ./publish.sh minor    # bump minor, then publish
#   ./publish.sh major    # bump major, then publish
# ---------------------------------------------------------------------------

BUMP="${1:-minor}"
PKG_NAME="@romatech/orm-providers-mssql"

echo "============================================"
echo " $PKG_NAME — publish pipeline"
echo "============================================"
echo ""

# 1. Ensure we are in the project root
if [ ! -f "package.json" ]; then
    echo "ERROR: package.json not found. Run this script from the project root."
    exit 1
fi

# 2. Ensure npm is logged in
echo "[1/7] Checking npm authentication..."
if ! npm whoami &>/dev/null; then
    echo "ERROR: Not logged in to npm. Run 'npm login' first."
    exit 1
fi
echo "       Logged in as: $(npm whoami)"
echo ""

# 3. Sync @romatech/orm dependency to latest published version
echo "[2/7] Syncing @romatech/orm to latest version..."
ORM_VERSION=$(npm view @romatech/orm version 2>/dev/null || echo "1.0.0")
echo "       Latest @romatech/orm: $ORM_VERSION"
sed -i "s|\"@romatech/orm\": \".*\"|\"@romatech/orm\": \"^$ORM_VERSION\"|g" package.json
echo ""

# 4. Install dependencies
echo "[3/7] Installing dependencies..."
npm ci --silent
echo "       Done."
echo ""

# 5. Build
echo "[4/7] Building..."
npm run build
echo ""

# 6. Version bump
echo "[5/7] Bumping version ($BUMP)..."
npm version "$BUMP" --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")
echo "       New version: $NEW_VERSION"
echo ""

# 7. Publish
echo "[6/7] Publishing $PKG_NAME@$NEW_VERSION to npm..."
npm publish --access public
echo ""

echo "============================================"
echo " Published $PKG_NAME@$NEW_VERSION"
echo "============================================"

# 8. Commit and tag
echo ""
echo "[7/7] Committing version bump and creating git tag..."
git add package.json package-lock.json 2>/dev/null || true
git commit -m "chore: release v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
echo ""
echo "Don't forget to push:"
echo "  git push && git push --tags"
