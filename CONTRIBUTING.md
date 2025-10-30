# Contributing to R-Shell

First off, thank you for considering contributing to R-Shell! 🎉

## 🎯 Project Context

This is a **learning and practice project for vibing coding** methodology. The frontend is AI-generated from Figma designs, and development is powered by GitHub Copilot. We welcome contributions that align with this experimental approach!

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Pull Request Process](#pull-request-process)
- [Style Guidelines](#style-guidelines)
- [Community](#community)

## Code of Conduct

This project adheres to a code of conduct that all contributors are expected to follow. Please be respectful and constructive in all interactions.

## How Can I Contribute?

### 🐛 Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates. When creating a bug report, include:

- **Clear title and description**
- **Steps to reproduce** the issue
- **Expected vs actual behavior**
- **Screenshots** if applicable
- **Environment details** (OS, Rust version, Node version)

### 💡 Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When suggesting an enhancement:

- **Use a clear and descriptive title**
- **Provide a detailed description** of the suggested enhancement
- **Explain why this enhancement would be useful**
- **Include mockups or examples** if applicable

### 🔧 Pull Requests

1. Fork the repo and create your branch from `main`
2. If you've added code that should be tested, add tests
3. Ensure the test suite passes
4. Make sure your code follows the existing style
5. Write a clear commit message

## Development Setup

### Prerequisites

- Node.js (v18+)
- pnpm
- Rust (latest stable)
- Tauri CLI dependencies

### Installation

```bash
# Clone your fork
git clone https://github.com/your-username/r-shell.git
cd r-shell

# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev
```

### Testing

```bash
# Run frontend tests
pnpm test

# Run Rust tests
cd src-tauri
cargo test

# Run E2E tests (configure credentials first)
pnpm playwright test
```

## Pull Request Process

1. **Update documentation** - Update the README.md with details of changes if applicable
2. **Follow commit conventions** - Use conventional commits format:
   - `feat:` - New features
   - `fix:` - Bug fixes
   - `docs:` - Documentation changes
   - `style:` - Code style changes (formatting, etc)
   - `refactor:` - Code refactoring
   - `test:` - Adding or updating tests
   - `chore:` - Maintenance tasks

3. **Update tests** - Add or update tests as needed
4. **Keep commits focused** - One logical change per commit
5. **Write clear PR descriptions** - Explain what and why

### Example Commit Messages

```
feat: add SSH key authentication support
fix: resolve memory leak in terminal component
docs: update installation instructions for Windows
refactor: simplify connection profile management
```

## Style Guidelines

### TypeScript/React

- Use TypeScript for all new code
- Follow existing code formatting (Prettier)
- Use functional components and hooks
- Keep components focused and single-purpose
- Add JSDoc comments for complex functions

### Rust

- Follow Rust standard style guidelines (rustfmt)
- Use `cargo clippy` to catch common mistakes
- Add documentation comments for public APIs
- Handle errors properly (don't unwrap in production code)

### General

- Write self-documenting code with clear variable names
- Keep functions small and focused
- Add comments for complex logic
- Update documentation when changing behavior

## Project Structure

```
r-shell/
├── src/                  # React frontend
│   ├── components/       # React components
│   ├── lib/             # Utility functions
│   └── __tests__/       # Frontend tests
├── src-tauri/           # Rust backend
│   ├── src/             # Rust source code
│   └── Cargo.toml       # Rust dependencies
├── tests/               # E2E tests
└── docs/                # Documentation
```

## Areas for Contribution

We especially welcome contributions in these areas:

### High Priority
- 🐛 Bug fixes
- 📝 Documentation improvements
- ✨ UI/UX enhancements
- 🧪 Test coverage improvements

### Feature Requests
- 🔐 Additional authentication methods (SSH keys, 2FA)
- 📊 Enhanced system monitoring features
- 🎨 Theme customization
- 🔌 Plugin system
- 📦 Package management integration
- 🔍 Search functionality in terminal history

### Technical Debt
- ♻️ Code refactoring
- 🎯 Performance optimizations
- 🔒 Security improvements
- ⚡ Build optimization

## Testing Guidelines

### Frontend Testing
- Test user interactions
- Test component rendering
- Mock Tauri commands
- Test edge cases

### Backend Testing
- Test SSH connection handling
- Test file operations
- Test command execution
- Test error scenarios

### E2E Testing
- Test complete user workflows
- Test cross-platform compatibility
- Configure test credentials in test files

## Community

### Getting Help

- 📖 Read the [README](README.md) and documentation
- 🔍 Search existing [issues](https://github.com/GOODBOY008/r-shell/issues)
- 💬 Ask questions in [Discussions](https://github.com/GOODBOY008/r-shell/discussions)

### Recognition

Contributors will be recognized in our README and release notes!

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.

---

Thank you for contributing to R-Shell! 🚀
