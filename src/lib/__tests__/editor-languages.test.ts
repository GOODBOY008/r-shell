import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, defaultHighlightStyle } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import {
  detectEditorLanguage,
  EDITOR_LANGUAGE_IDS,
  loadEditorLanguage,
  type EditorLanguageId,
} from "../editor-languages";

describe("editor language detection", () => {
  it.each([
    ["deploy.sh", "shell"], ["/opt/scripts/DEPLOY.BASH", "shell"],
    [".bashrc", "shell"], ["/home/user/.zshrc", "shell"], [".profile", "shell"],
    [".env", "shell"], [".env.production", "shell"], ["app.env", "shell"],
    ["config.yaml", "yaml"], ["COMPOSE.YML", "yaml"], ["settings.json", "json"],
    ["settings.jsonc", "jsonc"], ["tsconfig.app.json", "jsonc"],
    ["/srv/.vscode/settings.json", "jsonc"], [".eslintrc", "jsonc"],
    ["app.py", "python"], ["app.tsx", "tsx"], ["index.jsx", "jsx"],
    ["app.mjs", "javascript"], ["app.mts", "typescript"],
    ["styles.scss", "scss"], ["styles.less", "less"], ["README.md", "markdown"],
    ["main.rs", "rust"], ["main.cpp", "cpp"], ["App.java", "java"], ["build.gradle.kts", "kotlin"],
    ["schema.sql", "sql"], ["index.php", "php"], ["main.go", "go"], ["script.rb", "ruby"],
    ["app.service", "systemd"], ["backup.timer", "systemd"], ["app.socket", "systemd"],
    ["app.ini", "ini"], ["app.cfg", "ini"], ["my.cnf", "ini"], ["app.properties", "ini"],
    [".gitconfig", "ini"], [".editorconfig", "ini"], [".npmrc", "ini"],
    ["pyproject.toml", "toml"], ["Cargo.lock", "toml"], ["Pipfile", "toml"],
    ["Dockerfile", "dockerfile"], ["Dockerfile.prod", "dockerfile"], ["Containerfile", "dockerfile"],
    ["nginx.conf", "nginx"], ["/etc/nginx/sites-enabled/default", "nginx"],
    ["/etc/nginx/sites-enabled/example.com", "nginx"],
    ["/etc/nginx/sites-available/config", "nginx"], ["nginx/snippets/proxy.conf", "nginx"],
    ["C:\\nginx\\conf\\site.conf", "nginx"],
    ["/etc/systemd/system/app.service.d/override.conf", "systemd"],
    ["/home/me/.config/systemd/user/app.service.d/override.conf", "systemd"],
    ["app.conf", "ini"], ["/home/me/.ssh/config", "ini"],
    ["/etc/nginx/scripts/check.py", "python"], ["/etc/nginx/README.txt", "plaintext"],
    ["/etc/nginx/data.json", "json"], ["/etc/systemd/user/data.yaml", "yaml"],
    ["notes.txt", "plaintext"], ["error.log", "plaintext"], ["file.unknown", "plaintext"],
    ["/folder.with.dots/README", "plaintext"], ["constructor", "plaintext"], ["x.__proto__", "plaintext"],
    ["", "plaintext"],
  ] as const)("detects %s as %s", (filename, expected) => {
    expect(detectEditorLanguage(filename)).toBe(expected);
  });

  it.each([
    ["#!/bin/sh\necho ok", "shell"],
    ["#!/usr/bin/env bash\necho ok", "shell"],
    ["#!/usr/bin/env -S python3 -u\nprint('ok')", "python"],
    ["#!/usr/bin/env /opt/venv/bin/python3\nprint('ok')", "python"],
    ["#!/opt/venv/bin/python3.12\nprint('ok')", "python"],
    ["#!/usr/bin/env NODE_ENV=production node\nconsole.log('ok')", "javascript"],
    ["#!/usr/bin/ruby\nputs 'ok'", "ruby"],
    ["#!/usr/bin/perl\nprint 'ok';", "perl"],
    ["#!/usr/bin/lua\nprint('ok')", "lua"],
    ["#!/usr/bin/unknown\nhello", "plaintext"],
  ] as const)("uses an extensionless script's shebang: %s", (content, expected) => {
    expect(detectEditorLanguage("/usr/local/bin/tool", content)).toBe(expected);
  });

  it("distinguishes ambiguous configuration files by their contents", () => {
    expect(detectEditorLanguage("site.conf", "# virtual host\nserver {\n listen 80;\n}\n")).toBe("nginx");
    expect(detectEditorLanguage("proxy.conf", "proxy_pass http://127.0.0.1:3000;\n")).toBe("nginx");
    expect(detectEditorLanguage("override.conf", "[Service]\nRestart=always\n")).toBe("systemd");
    expect(detectEditorLanguage("settings", "[database]\nhost=localhost\n")).toBe("ini");
    expect(detectEditorLanguage("other.conf", "# settings\nkey=value\n")).toBe("ini");
  });

  it("keeps explicit language choices ahead of content heuristics", () => {
    expect(detectEditorLanguage("notes.txt", "#!/usr/bin/python3\nprint('ok')")).toBe("plaintext");
    expect(detectEditorLanguage("config.yaml", "[Service]\nRestart=always")).toBe("yaml");
  });

  it("bounds content detection and leaves unrelated extensionless text plain", () => {
    expect(detectEditorLanguage("notes", "An ordinary note\nhello world")).toBe("plaintext");
    expect(detectEditorLanguage("notes", "# comment\n".repeat(2000) + "server {\n}")).toBe("plaintext");
  });
});

describe("editor language loading and highlighting", () => {
  it.each(EDITOR_LANGUAGE_IDS)("loads a usable CodeMirror extension for %s", async id => {
    const extension = await loadEditorLanguage(id);
    expect(() => EditorState.create({ doc: "test", extensions: [extension] })).not.toThrow();
  });

  it.each<{
    id: EditorLanguageId;
    content: string;
    comment: string;
    token: string;
  }>([
    { id: "shell", content: '# deploy\nNAME="world"\necho "$NAME"\n', comment: "# deploy", token: '"world"' },
    { id: "nginx", content: '# proxy\nserver {\n  listen 80;\n}\n', comment: "# proxy", token: "listen" },
    { id: "systemd", content: '# app\n[Service]\nExecStart=/usr/bin/node app.js\n', comment: "# app", token: "/usr/bin/node app.js" },
    { id: "ini", content: '# database\n[db]\nhost=localhost\n', comment: "# database", token: "localhost" },
    { id: "toml", content: '# server\n[app]\nname = "demo"\n', comment: "# server", token: '"demo"' },
    { id: "yaml", content: '# app\nname: "demo"\n', comment: "# app", token: '"demo"' },
    { id: "jsonc", content: '// settings\n{"name": "demo"}\n', comment: "// settings", token: '"demo"' },
    { id: "python", content: '# greeting\ndef hello():\n    return "world"\n', comment: "# greeting", token: '"world"' },
    { id: "dockerfile", content: '# image\nFROM alpine:3.22\nRUN echo "hello"\n', comment: "# image", token: "FROM" },
  ])("highlights comments and syntax in $id", async ({ id, content, comment, token }) => {
    const state = EditorState.create({ doc: content, extensions: [await loadEditorLanguage(id)] });
    const tree = ensureSyntaxTree(state, content.length, 1000)!;
    const comments: string[] = [];
    const styled: string[] = [];
    highlightTree(tree, classHighlighter, (from, to, classes) => {
      if (classes.includes("tok-comment")) comments.push(content.slice(from, to));
    });
    // Assert against the actual light-theme highlighter too: a parser can emit
    // tags without those tags receiving a visible color (legacy INI values).
    highlightTree(tree, defaultHighlightStyle, (from, to) => styled.push(content.slice(from, to)));
    expect(comments).toContain(comment);
    expect(styled.join("\n")).toContain(token);
  });
});
