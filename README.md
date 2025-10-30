# R-Shell - SSH Client Application

A modern, feature-rich SSH client application built with React, TypeScript, and Tauri.

## 🎯 Project Purpose

This project is a **learning and practice project for vibe coding** methodology. It demonstrates:

- 🎨 **AI-Generated Frontend**: The entire frontend UI is generated from Figma designs using [Figma Make](https://www.figma.com/make/uUd7WO54vPnv03SmioKWqj/SSH-Client-Application?node-id=0-1&t=ZzB8GvFKHeoUIZpw-1)
- 🤖 **AI-Assisted Development**: The complete development process is powered by **GitHub Copilot**
- 🚀 **Modern Workflow**: Experience the efficiency of AI-driven development with minimal manual coding

> **Note**: This is an experimental project to explore the capabilities and limitations of AI-assisted development workflows. The goal is to understand how far we can go with AI pair programming tools in building a complete desktop application.
>
> 📐 **View the Figma Design**: Check out the [Figma Make preview](https://www.figma.com/make/uUd7WO54vPnv03SmioKWqj/SSH-Client-Application?node-id=0-1&t=ZzB8GvFKHeoUIZpw-1) to see how the frontend was generated.

## Overview

R-Shell is a desktop SSH client that provides a beautiful and intuitive interface for managing SSH connections, file transfers, and remote system monitoring. Built with modern web technologies and packaged as a native desktop application using Tauri.

## Features

- 🖥️ **Multi-Session Management**: Handle multiple SSH sessions with tabbed interface
- 📁 **Integrated File Browser**: Browse and manage remote files directly
- 📊 **System Monitor**: Real-time monitoring of remote system resources
- 🔐 **Secure Connections**: Support for SSH, SFTP, and other protocols
- 🎨 **Modern UI**: Built with Radix UI components and Tailwind CSS
- ⚡ **Fast & Lightweight**: Powered by Tauri for native performance

## Tech Stack

### Frontend
- **React 19**: Modern React with latest features
- **TypeScript**: Type-safe development
- **Tailwind CSS**: Utility-first CSS framework
- **Radix UI**: Accessible component primitives
- **Lucide Icons**: Beautiful icon set
- **React Hook Form**: Form state management
- **Recharts**: Data visualization

### Backend/Desktop
- **Tauri 2**: Build native desktop apps with web technologies
- **Rust**: Fast and memory-efficient backend

## Project Structure

```
r-shell/
├── src/
│   ├── components/         # React components
│   │   ├── ui/            # Reusable UI components (Radix-based)
│   │   ├── connection-dialog.tsx
│   │   ├── integrated-file-browser.tsx
│   │   ├── menu-bar.tsx
│   │   ├── session-manager.tsx
│   │   ├── session-tabs.tsx
│   │   ├── settings-modal.tsx
│   │   ├── sftp-panel.tsx
│   │   ├── status-bar.tsx
│   │   ├── system-monitor.tsx
│   │   ├── terminal.tsx
│   │   ├── toolbar.tsx
│   │   └── welcome-screen.tsx
│   ├── lib/               # Utility functions
│   ├── styles/            # Global styles
│   ├── App.tsx            # Main application component
│   ├── main.tsx           # Application entry point
│   └── index.css          # Global CSS with Tailwind directives
├── src-tauri/             # Tauri/Rust backend
├── public/                # Static assets
└── index.html             # HTML entry point
```

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- pnpm (recommended) or npm
- Rust and Cargo (for Tauri)

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd r-shell
```

2. Install dependencies:
```bash
pnpm install
```

3. Run in development mode:
```bash
# Web only
pnpm run dev

# Desktop with Tauri
pnpm tauri dev
```

### Building for Production

```bash
# Build web assets
pnpm run build

# Build desktop application
pnpm tauri build
```

## Development

### Available Scripts

- `pnpm run dev` - Start Vite development server
- `pnpm run build` - Build for production
- `pnpm run preview` - Preview production build
- `pnpm tauri dev` - Run Tauri app in development mode
- `pnpm tauri build` - Build Tauri app for production

### Key Components

#### App.tsx
Main application component that manages:
- Session state and tabs
- Dialog modals (connection, SFTP, settings)
- Layout with resizable panels
- Session selection and navigation

#### Terminal Component
Provides terminal emulation with:
- Command input/output
- Session management
- Terminal themes
- Copy/paste support

#### Session Manager
Tree-view interface for:
- Organizing connections
- Quick connection access
- Folder-based grouping
- Connection details

#### File Browser
Integrated file management:
- Remote file browsing
- File upload/download
- Drag-and-drop support
- File operations (rename, delete, etc.)

#### System Monitor
Real-time monitoring:
- CPU usage
- Memory usage
- Network statistics
- Disk usage

## Integration with Figma Design

This project integrates a React frontend generated from Figma with the Tauri platform:

### What was Integrated:
1. ✅ All UI components from `SSH Client Application (Community)`
2. ✅ Radix UI component library for accessible UI primitives
3. ✅ Tailwind CSS for styling
4. ✅ Complete component structure with session management
5. ✅ Resizable panels for flexible layout
6. ✅ Modal dialogs for connections and settings

### Changes Made:
- Updated `package.json` with all required dependencies
- Configured Tailwind CSS with PostCSS
- Set up TypeScript path aliases (`@/*` → `./src/*`)
- Integrated Tauri-specific configurations in `vite.config.ts`
- Fixed import statements to remove version specifiers
- Created utility functions for component styling

## Configuration

### Tailwind CSS
Configured in `tailwind.config.js` with custom theme extending CSS variables for colors and border radius.

### TypeScript
Path aliases configured in `tsconfig.json`:
- `@/*` maps to `./src/*`

### Vite
Custom configuration in `vite.config.ts`:
- Path resolution for `@` alias
- Tauri-specific dev server settings
- HMR configuration

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

[Your License Here]

## Acknowledgments

- Built with components from [shadcn/ui](https://ui.shadcn.com/)
- UI design generated from Figma
- Icons from [Lucide](https://lucide.dev/)

## Development Guide

### Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v18 or later) and **pnpm**
- **Rust** (latest stable version)
- **Tauri CLI dependencies** for your platform:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: See [Tauri prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites)
  - **Windows**: Microsoft Visual Studio C++ Build Tools

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd r-shell
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

### Development Commands

- **Start development server** (with hot reload):
  ```bash
  pnpm tauri dev
  ```
  This starts both the Vite dev server and the Tauri application.

- **Build frontend only** (for testing):
  ```bash
  pnpm dev
  ```

- **Build for production**:
  ```bash
  pnpm tauri build
  ```

- **Type checking**:
  ```bash
  pnpm build
  ```

### Project Structure

```
r-shell/
├── src/                  # React frontend source
│   ├── App.tsx          # Main React component
│   ├── main.tsx         # React entry point
│   └── assets/          # Static assets
├── src-tauri/           # Rust backend source
│   ├── src/
│   │   ├── main.rs      # Tauri application entry
│   │   └── lib.rs       # Rust library code
│   ├── Cargo.toml       # Rust dependencies
│   └── tauri.conf.json  # Tauri configuration
├── public/              # Public static files
└── index.html           # HTML template
```

## Debugging Guide

### Frontend Debugging

#### Using Browser DevTools

1. Start the development server:
   ```bash
   pnpm tauri dev
   ```

2. Right-click in the application window and select **"Inspect Element"** or use:
   - **macOS**: `Cmd + Option + I`
   - **Linux/Windows**: `Ctrl + Shift + I`

3. You can now use the full Chrome DevTools to:
   - Inspect React components
   - Debug JavaScript/TypeScript
   - Monitor network requests
   - Check console logs

#### VS Code Debugging

1. Install the "Tauri" extension in VS Code

2. Create `.vscode/launch.json`:
   ```json
   {
     "version": "0.2.0",
     "configurations": [
       {
         "type": "chrome",
         "request": "launch",
         "name": "Debug Frontend",
         "url": "http://localhost:1420",
         "webRoot": "${workspaceFolder}/src"
       }
     ]
   }
   ```

3. Start dev server and use the debug configuration

### Backend (Rust) Debugging

#### Using Console Logs

Add debug prints in your Rust code:
```rust
println!("Debug: {:?}", some_variable);
// or use the dbg! macro
dbg!(some_variable);
```

View logs in the terminal where you ran `pnpm tauri dev`.

#### Using Rust Debugger (CodeLLDB)

1. Install the **"CodeLLDB"** extension in VS Code

2. Create or update `.vscode/launch.json`:
   ```json
   {
     "version": "0.2.0",
     "configurations": [
       {
         "type": "lldb",
         "request": "launch",
         "name": "Tauri Development Debug",
         "cargo": {
           "args": [
             "build",
             "--manifest-path=./src-tauri/Cargo.toml",
             "--no-default-features"
           ]
         },
         "cwd": "${workspaceFolder}"
       },
       {
         "type": "lldb",
         "request": "launch",
         "name": "Tauri Production Debug",
         "cargo": {
           "args": [
             "build",
             "--release",
             "--manifest-path=./src-tauri/Cargo.toml"
           ]
         },
         "cwd": "${workspaceFolder}"
       }
     ]
   }
   ```

3. Set breakpoints in Rust files and start debugging with F5

#### Using rust-analyzer

- Hover over types to see their definitions
- Use "Go to Definition" (F12) to navigate code
- Run individual tests with the "Run Test" code lens

### Common Debugging Scenarios

#### Application Won't Start

1. Check if ports are already in use:
   ```bash
   lsof -i :1420  # Frontend dev server
   ```

2. Clear build artifacts:
   ```bash
   pnpm tauri clean
   rm -rf node_modules
   pnpm install
   ```

3. Check Rust compilation errors in terminal output

#### Frontend/Backend Communication Issues

1. Enable verbose logging in `src-tauri/tauri.conf.json`:
   ```json
   {
     "tauri": {
       "bundle": {
         "active": true
       }
     },
     "build": {
       "devPath": "http://localhost:1420",
       "distDir": "../dist"
     }
   }
   ```

2. Check the browser console for IPC errors

3. Verify command definitions match between Rust and TypeScript

#### Performance Issues

1. Use React DevTools Profiler to identify slow components

2. Profile Rust code:
   ```bash
   cargo build --release --manifest-path=./src-tauri/Cargo.toml
   cargo flamegraph --manifest-path=./src-tauri/Cargo.toml
   ```

3. Check the DevTools Performance tab for frontend bottlenecks

### Logging Best Practices

#### Frontend
```typescript
console.log('[Debug]', data);
console.error('[Error]', error);
console.warn('[Warning]', warning);
```

#### Backend
```rust
use tauri::Manager;

// Use the log crate for different levels
log::info!("Info message");
log::debug!("Debug message");
log::error!("Error message");
log::warn!("Warning message");
```

### Testing

Run tests for different parts of the application:

```bash
# Frontend tests (if configured)
pnpm test

# Rust tests
cd src-tauri
cargo test

# Run specific test
cargo test test_name
```

## Troubleshooting

### Build Errors

- **Rust compilation fails**: Update Rust with `rustup update`
- **TypeScript errors**: Run `pnpm install` to ensure types are up to date
- **Missing dependencies**: Check platform-specific requirements

### Runtime Errors

- Check both terminal output (Rust logs) and browser console (JS logs)
- Verify file paths are correct for your OS
- Check permissions for file system or network access

## Additional Resources

- [Tauri Documentation](https://tauri.app/)
- [Tauri API Reference](https://tauri.app/v2/api/js/)
- [React Documentation](https://react.dev/)
- [Vite Documentation](https://vitejs.dev/)
- [Rust Book](https://doc.rust-lang.org/book/)
