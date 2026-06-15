#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# publish.sh — Build verification and npm publish for @romatech/orm-providers-mssql
# ---------------------------------------------------------------------------
# Usage:
#   ./publish.sh          # publish current version
#   ./publish.sh patch    # bump patch, then publish (e.g. 2.0.0 -> 2.0.1)
#   ./publish.sh minor    # bump minor, then publish (e.g. 2.0.0 -> 2.1.0)
#   ./publish.sh major    # bump major, then publish (e.g. 2.0.0 -> 3.0.0)
# ---------------------------------------------------------------------------

BUMP="${1:-}"

echo "============================================"
echo " @romatech/orm-providers-mssql — publish pipeline"
echo "============================================"
echo ""

# 1. Ensure we are in the project root (where package.json lives)
if [ ! -f "package.json" ]; then
    echo "ERROR: package.json not found. Run this script from the project root."
    exit 1
fi

# 2. Ensure npm is logged in
echo "[1/6] Checking npm authentication..."
if ! npm whoami &>/dev/null; then
    echo "ERROR: Not logged in to npm. Run 'npm login' first."
    exit 1
fi
echo "       Logged in as: $(npm whoami)"
echo ""

# 3. Install dependencies
echo "[2/6] Installing dependencies..."
npm ci --silent
echo "       Done."
echo ""

# 4. Run tests
echo "[3/6] Running tests..."
npm test
echo ""

# 5. Version bump (optional)
if [ -n "$BUMP" ]; then
    echo "[4/6] Bumping version ($BUMP)..."
    npm version "$BUMP" --no-git-tag-version
    NEW_VERSION=$(node -p "require('./package.json').version")
    echo "       New version: $NEW_VERSION"
    echo ""
else
    echo "[4/6] No version bump requested. Publishing current version."
    NEW_VERSION=$(node -p "require('./package.json').version")
    echo "       Version: $NEW_VERSION"
    echo ""
fi

# 6. Dry run to verify package contents
echo "[5/6] Verifying package contents (dry run)..."
npm pack --dry-run
echo ""

# 7. Publish
echo "[6/6] Publishing @romatech/orm-providers-mssql@$NEW_VERSION to npm..."
npm publish --access public
echo ""

echo "============================================"
echo " Published @romatech/orm-providers-mssql@$NEW_VERSION"
echo "============================================"

# 8. If version was bumped, commit and tag
if [ -n "$BUMP" ]; then
    echo ""
    echo "Committing version bump and creating git tag..."
    git add package.json
    git commit -m "chore: release v$NEW_VERSION"
    git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
    echo ""
    echo "Don't forget to push:"
    echo "  git push && git push --tags"
fi
