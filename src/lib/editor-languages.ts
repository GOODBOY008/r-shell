import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { tags } from "@lezer/highlight";

async function loadProperties(): Promise<Extension> {
  const { properties } = await import("@codemirror/legacy-modes/mode/properties");
  return StreamLanguage.define({ ...properties, tokenTable: { quote: tags.string } });
}

// Keep parsers out of the initial bundle. Each language is loaded once, when an
// editor actually needs it. Repeated requests share a cached loading promise.
const loaders = {
  plaintext: async (): Promise<Extension> => [],
  shell: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell),
  nginx: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/nginx")).nginx),
  systemd: loadProperties,
  ini: loadProperties,
  toml: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  json: async () => (await import("@codemirror/lang-json")).json(),
  jsonc: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/javascript")).json),
  python: async () => (await import("@codemirror/lang-python")).python(),
  javascript: async () => (await import("@codemirror/lang-javascript")).javascript(),
  typescript: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
  jsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  tsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }),
  html: async () => (await import("@codemirror/lang-html")).html(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  scss: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/css")).sCSS),
  less: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/css")).less),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  xml: async () => (await import("@codemirror/lang-xml")).xml(),
  rust: async () => (await import("@codemirror/lang-rust")).rust(),
  cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
  java: async () => (await import("@codemirror/lang-java")).java(),
  kotlin: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).kotlin),
  sql: async () => (await import("@codemirror/lang-sql")).sql(),
  php: async () => (await import("@codemirror/lang-php")).php(),
  go: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/go")).go),
  ruby: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/ruby")).ruby),
  perl: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/perl")).perl),
  lua: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/lua")).lua),
  dockerfile: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile),
} satisfies Record<string, () => Promise<Extension>>;

export type EditorLanguageId = keyof typeof loaders;
export const EDITOR_LANGUAGE_IDS = Object.keys(loaders) as EditorLanguageId[];

const languageCache = new Map<EditorLanguageId, Promise<Extension>>();

export function loadEditorLanguage(id: EditorLanguageId): Promise<Extension> {
  let pending = languageCache.get(id);
  if (!pending) {
    pending = loaders[id]().catch((error: unknown) => {
      // A failed chunk load must not poison later attempts to enable highlighting.
      languageCache.delete(id);
      throw error;
    });
    languageCache.set(id, pending);
  }
  return pending;
}

const extensions: Record<string, EditorLanguageId> = {
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ksh: "shell", env: "shell",
  ini: "ini", cfg: "ini", cnf: "ini", properties: "ini",
  service: "systemd", socket: "systemd", timer: "systemd", target: "systemd",
  mount: "systemd", automount: "systemd", path: "systemd", slice: "systemd",
  scope: "systemd", network: "systemd", netdev: "systemd", link: "systemd",
  toml: "toml", yaml: "yaml", yml: "yaml", json: "json", jsonc: "jsonc",
  py: "python", pyw: "python", js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", jsx: "jsx", tsx: "tsx",
  html: "html", htm: "html", svelte: "html", vue: "html",
  css: "css", scss: "scss", less: "less", md: "markdown", mdx: "markdown", markdown: "markdown",
  xml: "xml", svg: "xml", xsl: "xml", xslt: "xml", rs: "rust",
  c: "cpp", h: "cpp", cpp: "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp", hxx: "cpp",
  java: "java", kt: "kotlin", kts: "kotlin", sql: "sql", php: "php",
  go: "go", rb: "ruby", pl: "perl", pm: "perl", lua: "lua", dockerfile: "dockerfile",
  txt: "plaintext", log: "plaintext",
};

const filenames: Record<string, EditorLanguageId> = {
  ".bashrc": "shell", ".bash_profile": "shell", ".bash_login": "shell", ".bash_logout": "shell",
  ".profile": "shell", ".zshrc": "shell", ".zprofile": "shell", ".zshenv": "shell",
  ".zlogin": "shell", ".zlogout": "shell", ".envrc": "shell", bashrc: "shell", profile: "shell",
  ".gitconfig": "ini", ".gitmodules": "ini", ".editorconfig": "ini", ".npmrc": "ini",
  ".pypirc": "ini", ".coveragerc": "ini", ssh_config: "ini", sshd_config: "ini",
  ".babelrc": "jsonc", ".eslintrc": "jsonc", ".prettierrc": "jsonc", ".jshintrc": "jsonc",
  ".yamllint": "yaml", pipfile: "toml", "cargo.lock": "toml",
};

function languageFromShebang(content: string): EditorLanguageId | undefined {
  const firstLine = content.slice(0, 512).split(/\r?\n/, 1)[0];
  if (!firstLine.startsWith("#!")) return;
  const words = firstLine.slice(2).trim().split(/\s+/);
  let command = words[0].split("/").pop() ?? "";
  if (command === "env") {
    command = words.slice(1).find(word => !word.startsWith("-") && !word.includes("=")) ?? "";
    command = command.split("/").pop() ?? "";
  }
  if (/^(?:(?:ba|da|k|z)?sh|fish)$/.test(command)) return "shell";
  if (/^python(?:[23](?:\.\d+)*)?$/.test(command)) return "python";
  if (/^(?:node|nodejs|deno|bun)$/.test(command)) return "javascript";
  if (/^ruby(?:\d[\d.]*)?$/.test(command)) return "ruby";
  if (/^perl(?:\d[\d.]*)?$/.test(command)) return "perl";
  if (/^lua(?:\d[\d.]*)?$/.test(command)) return "lua";
}

/**
 * Prefer explicit file types, then server-config paths and a bounded content
 * sample for ambiguous .conf / extensionless files. Unknown text stays plain.
 * Accept full remote paths so nginx's extensionless sites-enabled entries and
 * systemd drop-ins get the same highlighting as their main configuration files.
 */
export function detectEditorLanguage(filename: string, content = ""): EditorLanguageId {
  const path = filename.replace(/\\/g, "/").toLowerCase();
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";

  if (name === ".env" || name.startsWith(".env.")) return "shell";
  if (/^(?:dockerfile|containerfile)(?:\..+)?$/.test(name)) return "dockerfile";
  if (/^(?:tsconfig|jsconfig)(?:\.[^.]+)*\.json$/.test(name)
    || /\/\.vscode\/(?:settings|tasks|launch|extensions)\.json$/.test(path)) return "jsonc";
  if (Object.prototype.hasOwnProperty.call(filenames, name)) return filenames[name];
  if (Object.prototype.hasOwnProperty.call(extensions, ext)) return extensions[ext];

  // Explicit extensions above win over path hints. Unknown suffixes in nginx
  // paths can be site names such as example.com, rather than file extensions.
  if (name === "nginx" || name === "nginx.conf" || /(?:^|\/)nginx\//.test(path)) return "nginx";
  if (/(?:^|\/)systemd\/(?:system|user)\//.test(path)) return "systemd";

  const sample = content.slice(0, 8192);
  const shebang = languageFromShebang(sample);
  if (shebang) return shebang;

  if (ext === "conf" || !ext) {
    if (/^\s*\[(?:Unit|Service|Install|Socket|Timer|Mount|Automount|Path|Network|NetDev|Link|Match)\]\s*$/m.test(sample)) return "systemd";
    if (/^\s*(?:(?:http|events|stream|server|location|upstream|map|types)\b[^\n{}]*\{|(?:worker_processes|proxy_pass|fastcgi_pass|server_name|listen)\s+[^;\n]+;)/m.test(sample)) return "nginx";
    if (ext === "conf" || name === "config" || /^\s*\[[^\]\n]+\]\s*$/m.test(sample)) return "ini";
  }
  return "plaintext";
}
