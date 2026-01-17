#!/bin/bash

# R-Shell Version Bump Script
# Usage: ./scripts/bump-version.sh [major|minor|patch] [--no-commit]
#
# This script bumps the version across all project files:
# - package.json
# - src-tauri/Cargo.toml
# - src-tauri/tauri.conf.json
# - CHANGELOG.md

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
BUMP_TYPE="${1:-patch}"
NO_COMMIT=false
SKIP_CHANGELOG=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --no-commit)
      NO_COMMIT=true
      shift
      ;;
    --skip-changelog)
      SKIP_CHANGELOG=true
      shift
      ;;
  esac
done

# Validate bump type
if [[ ! "$BUMP_TYPE" =~ ^(major|minor|patch)$ ]]; then
  echo -e "${RED}Error: Invalid bump type '$BUMP_TYPE'. Use: major, minor, or patch${NC}"
  exit 1
fi

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "${BLUE}Current version: ${CURRENT_VERSION}${NC}"

# Calculate new version
IFS='.' read -r -a VERSION_PARTS <<< "$CURRENT_VERSION"
MAJOR="${VERSION_PARTS[0]}"
MINOR="${VERSION_PARTS[1]}"
PATCH="${VERSION_PARTS[2]}"

case $BUMP_TYPE in
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  patch)
    PATCH=$((PATCH + 1))
    ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
echo -e "${GREEN}New version: ${NEW_VERSION}${NC}"

# Confirmation
read -p "Bump version from ${CURRENT_VERSION} to ${NEW_VERSION}? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo -e "${YELLOW}Version bump cancelled${NC}"
  exit 0
fi

# Update package.json
echo -e "${BLUE}Updating package.json...${NC}"
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS
  sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json
else
  # Linux
  sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json
fi

# Update src-tauri/Cargo.toml
echo -e "${BLUE}Updating src-tauri/Cargo.toml...${NC}"
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/^version = \"$CURRENT_VERSION\"/version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml
else
  sed -i "s/^version = \"$CURRENT_VERSION\"/version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml
fi

# Update src-tauri/tauri.conf.json
echo -e "${BLUE}Updating src-tauri/tauri.conf.json...${NC}"
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" src-tauri/tauri.conf.json
else
  sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" src-tauri/tauri.conf.json
fi

# Update Cargo.lock by building
echo -e "${BLUE}Updating src-tauri/Cargo.lock...${NC}"
cd src-tauri
cargo build --quiet 2>/dev/null || true
cd ..

# Update CHANGELOG.md
if [ "$SKIP_CHANGELOG" = false ]; then
  echo -e "${BLUE}Updating CHANGELOG.md...${NC}"
  CURRENT_DATE=$(date +%Y-%m-%d)
  
  # Create temporary file with new version section
  TEMP_FILE=$(mktemp)
  
  # Read CHANGELOG and insert new version section after "## [Unreleased]" section
  awk -v version="$NEW_VERSION" -v date="$CURRENT_DATE" '
    /^## \[Unreleased\]/ { 
      print
      getline
      print
      getline
      print
      print ""
      print "## [" version "] - " date
      print ""
      print "### Added"
      print ""
      print "- _Add new features here_"
      print ""
      print "### Changed"
      print ""
      print "- _Add changes here_"
      print ""
      print "### Fixed"
      print ""
      print "- _Add bug fixes here_"
      next
    }
    { print }
  ' CHANGELOG.md > "$TEMP_FILE"
  
  mv "$TEMP_FILE" CHANGELOG.md
  
  echo -e "${YELLOW}⚠️  Please update CHANGELOG.md with actual changes before committing${NC}"
fi

# Create git commit
if [ "$NO_COMMIT" = false ]; then
  echo -e "${BLUE}Creating git commit...${NC}"
  
  git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
  
  if [ "$SKIP_CHANGELOG" = false ]; then
    git add CHANGELOG.md
  fi
  
  COMMIT_MSG="chore: bump version to ${NEW_VERSION}"
  
  git commit -m "$COMMIT_MSG"
  
  echo -e "${GREEN}✓ Version bumped to ${NEW_VERSION} and committed${NC}"
  echo -e "${YELLOW}Don't forget to:${NC}"
  echo -e "  1. Update CHANGELOG.md with actual changes"
  echo -e "  2. Run: git commit --amend (if needed)"
  echo -e "  3. Create a git tag: git tag v${NEW_VERSION}"
  echo -e "  4. Push changes: git push && git push --tags"
else
  echo -e "${GREEN}✓ Version bumped to ${NEW_VERSION}${NC}"
  echo -e "${YELLOW}Files modified (not committed):${NC}"
  echo -e "  - package.json"
  echo -e "  - src-tauri/Cargo.toml"
  echo -e "  - src-tauri/Cargo.lock"
  echo -e "  - src-tauri/tauri.conf.json"
  if [ "$SKIP_CHANGELOG" = false ]; then
    echo -e "  - CHANGELOG.md"
  fi
fi
