#!/bin/bash

# macOS ARM64 (Apple Silicon) Optimized Build Script
# This script builds the application with optimizations for low-latency terminal input

set -e

echo "🍎 Building r-shell for macOS ARM64 with terminal latency optimizations..."

# Set environment variables for optimal ARM64 build
export CARGO_BUILD_TARGET="aarch64-apple-darwin"
export RUSTFLAGS="-C target-cpu=native -C opt-level=3"

# Clean previous builds
echo "🧹 Cleaning previous builds..."
pnpm clean 2>/dev/null || true
cd src-tauri
cargo clean
cd ..

# Install dependencies
echo "📦 Installing dependencies..."
pnpm install

# Build the Tauri app in release mode with optimizations
echo "🔨 Building Tauri app with ARM64 optimizations..."
pnpm tauri build --target aarch64-apple-darwin

echo "✅ Build complete!"
echo ""
echo "📍 Binary location: src-tauri/target/aarch64-apple-darwin/release/r-shell"
echo ""
echo "🚀 Optimizations applied:"
echo "   • TCP_NODELAY enabled (disables Nagle's algorithm)"
echo "   • Zero-latency input transmission (no batching)"
echo "   • Increased channel buffer sizes (4096/8192)"
echo "   • Immediate flush after every write"
echo "   • Native ARM64 CPU instructions"
echo "   • Link-time optimization (LTO)"
echo ""
