import React, { useRef, useEffect, useCallback, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars, dropCursor } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { loadEditorConfig, EDITOR_CONFIG_CHANGED_EVENT, type EditorConfig } from "@/lib/editor-config";

// Language imports
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { sql } from "@codemirror/lang-sql";
import { php } from "@codemirror/lang-php";

/** Map file extension to a CodeMirror language extension */
function getLanguageExtension(filename: string): Extension | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "jsx":
      return javascript({ jsx: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "json":
    case "jsonc":
      return json();
    case "py":
    case "pyw":
      return python();
    case "html":
    case "htm":
    case "svelte":
    case "vue":
      return html();
    case "css":
    case "scss":
    case "less":
      return css();
    case "md":
    case "mdx":
    case "markdown":
      return markdown();
    case "xml":
    case "svg":
    case "xsl":
    case "xslt":
      return xml();
    case "yml":
    case "yaml":
      return yaml();
    case "rs":
      return rust();
    case "c":
    case "h":
    case "cpp":
    case "cxx":
    case "cc":
    case "hpp":
    case "hxx":
      return cpp();
    case "java":
    case "kt":
    case "kts":
      return java();
    case "sql":
      return sql();
    case "php":
      return php();
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "conf":
    case "ini":
    case "toml":
    case "cfg":
    case "env":
    case "log":
    case "txt":
    default:
      return null;
  }
}

interface CodeEditorProps {
  /** Initial document content */
  value: string;
  /** Called whenever the document changes */
  onChange?: (value: string) => void;
  /** Filename used for language detection */
  filename?: string;
  /** Read-only mode */
  readOnly?: boolean;
  /** Use dark theme (defaults to true). Ignored when the user has chosen a theme via editor settings. */
  dark?: boolean;
  /** Additional CSS class for the wrapper */
  className?: string;
}

export function CodeEditor({
  value,
  onChange,
  filename = "",
  readOnly = false,
  dark = true,
  className = "",
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const [editorConfig, setEditorConfig] = useState<EditorConfig>(() => loadEditorConfig());

  // Reload config whenever it changes in settings
  useEffect(() => {
    const handler = () => setEditorConfig(loadEditorConfig());
    window.addEventListener(EDITOR_CONFIG_CHANGED_EVENT, handler);
    return () => window.removeEventListener(EDITOR_CONFIG_CHANGED_EVENT, handler);
  }, []);

  // Keep callback ref fresh without recreating the editor
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const buildExtensions = useCallback((): Extension[] => {
    const exts: Extension[] = [
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      rectangularSelection(),
      crosshairCursor(),
      highlightSelectionMatches(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      // Dispatch listener for onChange
      EditorView.updateListener.of((update) => {
        if (update.docChanged && onChangeRef.current) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
      // Tab size from config
      EditorState.tabSize.of(editorConfig.tabSize),
    ];

    // Conditional extensions based on user config
    if (editorConfig.lineNumbers) {
      exts.push(lineNumbers());
      exts.push(highlightActiveLineGutter());
    }
    if (editorConfig.highlightActiveLine) {
      exts.push(highlightActiveLine());
    }
    if (editorConfig.foldGutter) {
      exts.push(foldGutter());
    }
    if (editorConfig.bracketMatching || editorConfig.matchBrackets) {
      exts.push(bracketMatching());
    }
    if (editorConfig.wordWrap) {
      exts.push(EditorView.lineWrapping);
    }

    // Theme: user-configured theme takes precedence over the `dark` prop
    const themeId = editorConfig.theme;
    if (themeId === "oneDark") {
      exts.push(oneDark);
    } else if (themeId === "light") {
      // No extra extension needed — CodeMirror's base chrome is light
    } else if (dark) {
      exts.push(oneDark);
    }

    if (readOnly) {
      exts.push(EditorState.readOnly.of(true));
    }

    const lang = getLanguageExtension(filename);
    if (lang) {
      exts.push(lang);
    }

    return exts;
  }, [filename, readOnly, dark, editorConfig]);

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: buildExtensions(),
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Only recreate when language/readOnly/dark changes, not on every value change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildExtensions]);

  // Sync external value changes (e.g. loading a new file) without recreating the editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== value) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      ref={containerRef}
      className={`overflow-auto border rounded-md ${className}`}
      style={{
        height: "100%",
        fontSize: `${editorConfig.fontSize}px`,
        fontFamily: editorConfig.fontFamily,
      }}
    />
  );
}
