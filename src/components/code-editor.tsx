import { useRef, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
  dropCursor,
} from "@codemirror/view";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  indentOnInput,
  indentUnit,
  bracketMatching,
  foldGutter,
  foldKeymap,
} from "@codemirror/language";
import {
  search,
  searchKeymap,
  openSearchPanel,
  gotoLine,
  highlightSelectionMatches,
} from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  loadEditorConfig,
  saveEditorConfig,
  dispatchEditorConfigChanged,
  EDITOR_CONFIG_CHANGED_EVENT,
  type EditorConfig,
} from "@/lib/editor-config";
import {
  detectEditorLanguage,
  loadEditorLanguage,
  type EditorLanguageId,
} from "@/lib/editor-languages";
import { notify } from "@/lib/notifications";
import { useCommandShortcuts } from "@/lib/keyboard-shortcuts";
import { EditorSearchPanel } from "./editor-search-panel";
import { EditorToolbar, EditorStatusBar } from "./editor-controls";
import "@/styles/editor.css";

const externalValueChange = Annotation.define<boolean>();
const editorTypography = EditorView.theme({
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.55" },
  ".cm-content": { padding: "12px 0" },
  ".cm-line": { padding: "0 16px 0 8px" },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 12px 0 12px",
    minWidth: "40px",
  },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px" },
  "&.cm-focused": { outline: "none" },
});
// The app and editor themes are independent. An explicit background prevents
// light syntax colors from falling onto the app's dark workspace background.
const lightTheme = EditorView.theme({
  "&": { color: "#24292e", backgroundColor: "#ffffff" },
  ".cm-gutters": {
    color: "#6e7781",
    backgroundColor: "#f6f8fa",
    borderColor: "#d0d7de",
  },
  ".cm-activeLine": { backgroundColor: "#f6f8fa" },
  ".cm-activeLineGutter": { backgroundColor: "#eaeef2" },
});

interface CodeEditorProps {
  /** Document content */
  value: string;
  /** Called whenever the user changes the document */
  onChange?: (value: string) => void;
  /** Filename or full remote path used for language detection */
  filename?: string;
  /** Read-only mode */
  readOnly?: boolean;
  autoFocus?: boolean;
  isActive?: boolean;
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
  autoFocus = false,
  isActive = true,
  dark = true,
  className = "",
}: CodeEditorProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [searchHost, setSearchHost] = useState<{
    dom: HTMLElement;
    view: EditorView;
  } | null>(null);
  const [goToLineOpen, setGoToLineOpen] = useState(false);
  const [replaceRequest, setReplaceRequest] = useState(0);
  useCommandShortcuts({
    findInEditor: () => { if (viewRef.current) openSearchPanel(viewRef.current); },
    replaceInEditor: () => {
      if (viewRef.current && !viewRef.current.state.readOnly) {
        setReplaceRequest(value => value + 1);
        openSearchPanel(viewRef.current);
      }
    },
    goToLine: () => setGoToLineOpen(true),
  }, { enabled: isActive, element: () => containerRef.current?.parentElement ?? null });
  const [editorConfig, setEditorConfig] = useState<EditorConfig>(() =>
    loadEditorConfig(),
  );
  const [compartments] = useState(() => ({
    options: new Compartment(),
    language: new Compartment(),
  }));
  const [languageOverride, setLanguageOverride] = useState<{
    filename: string;
    language: EditorLanguageId | "auto";
  } | null>(null);
  const detectedLanguage = useMemo(
    () => detectEditorLanguage(filename, value),
    [filename, value],
  );
  const languageChoice =
    languageOverride?.filename === filename
      ? languageOverride.language
      : "auto";
  const language =
    languageChoice === "auto" ? detectedLanguage : languageChoice;
  const isDark =
    editorConfig.theme === "oneDark" ||
    (editorConfig.theme !== "light" && dark);
  const lineBreak = value.includes("\r\n") ? "\r\n" : "\n";

  const updateConfig = (patch: Partial<EditorConfig>) => {
    const next = { ...editorConfig, ...patch };
    setEditorConfig(next);
    try {
      saveEditorConfig(next);
      dispatchEditorConfigChanged();
    } catch {
      notify.error(t("codeEditor.settingsSaveFailed"));
    }
  };

  useEffect(() => {
    const handler = () => setEditorConfig(loadEditorConfig());
    window.addEventListener(EDITOR_CONFIG_CHANGED_EVENT, handler);
    return () =>
      window.removeEventListener(EDITOR_CONFIG_CHANGED_EVENT, handler);
  }, []);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // History and the EditorView live for the whole mount. Reconfiguring options
  // or a lazily loaded parser must not reset edits, selection, scroll, or undo.
  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          highlightSpecialChars(),
          history(),
          editorTypography,
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          rectangularSelection(),
          crosshairCursor(),
          highlightSelectionMatches(),
          search({
            top: true,
            createPanel: (panelView) => {
              const dom = document.createElement("div");
              return {
                dom,
                top: true,
                mount: () => setSearchHost({ dom, view: panelView }),
                destroy: () => setSearchHost(null),
              };
            },
          }),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
            // Opening search is routed through the command registry. Keep
            // match navigation while allowing opening bindings to be disabled.
            ...searchKeymap.filter(binding => binding.run !== openSearchPanel && binding.run !== gotoLine),
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            setEditorState(update.state);
            if (
              update.transactions.some(
                (transaction) =>
                  transaction.docChanged &&
                  !transaction.annotation(externalValueChange),
              )
            ) {
              onChangeRef.current?.(update.state.sliceDoc());
            }
          }),
          compartments.options.of([]),
          compartments.language.of([]),
        ],
      }),
    });
    if (autoFocus && document.hasFocus()) view.focus();
    viewRef.current = view;
    setEditorView(view);
    setEditorState(view.state);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // `value` is only the initial document here; external updates are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compartments]);

  useEffect(() => {
    if (autoFocus && document.hasFocus()) editorView?.focus();
  }, [autoFocus, editorView]);

  useEffect(() => {
    const options: Extension[] = [
      EditorState.tabSize.of(editorConfig.tabSize),
      indentUnit.of(" ".repeat(editorConfig.tabSize)),
      EditorState.lineSeparator.of(lineBreak),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({
        "aria-label": t("codeEditor.content"),
      }),
    ];
    if (editorConfig.lineNumbers)
      options.push(lineNumbers(), highlightActiveLineGutter());
    if (editorConfig.highlightActiveLine) options.push(highlightActiveLine());
    if (editorConfig.foldGutter) options.push(foldGutter());
    if (editorConfig.bracketMatching || editorConfig.matchBrackets)
      options.push(bracketMatching());
    if (editorConfig.wordWrap) options.push(EditorView.lineWrapping);
    options.push(isDark ? oneDark : lightTheme);
    viewRef.current?.dispatch({
      effects: compartments.options.reconfigure(options),
    });
  }, [compartments, editorConfig, readOnly, isDark, lineBreak, t]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    // Clear the previous file's parser immediately while the next chunk loads.
    view.dispatch({ effects: compartments.language.reconfigure([]) });
    void loadEditorLanguage(language)
      .then((extension) => {
        if (!cancelled)
          view.dispatch({
            effects: compartments.language.reconfigure(extension),
          });
      })
      .catch(() => {
        if (!cancelled) notify.error(t("codeEditor.languageLoadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [compartments, filename, language, t]);

  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.sliceDoc() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: [
          externalValueChange.of(true),
          Transaction.addToHistory.of(false),
        ],
      });
    }
  }, [value]);

  return (
    <div
      className={`code-editor h-full min-h-0 flex flex-col overflow-hidden ${className}`}
      data-editor-theme={isDark ? "dark" : "light"}
      data-shortcut-scope="editor"
    >
      <EditorToolbar
        view={editorView}
        state={editorState}
        config={editorConfig}
        onConfigChange={updateConfig}
        dark={isDark}
      />
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden"
        style={{
          fontSize: `${editorConfig.fontSize}px`,
          fontFamily: editorConfig.fontFamily,
        }}
      />
      <EditorStatusBar
        view={editorView}
        state={editorState}
        config={editorConfig}
        onConfigChange={updateConfig}
        dark={isDark}
        languageChoice={languageChoice}
        detectedLanguage={detectedLanguage}
        onLanguageChange={(id) =>
          setLanguageOverride({ filename, language: id })
        }
        goToLineOpen={goToLineOpen}
        onGoToLineOpenChange={setGoToLineOpen}
      />
      {searchHost &&
        editorState &&
        createPortal(
          <EditorSearchPanel view={searchHost.view} state={editorState} replaceRequest={replaceRequest} />,
          searchHost.dom,
        )}
    </div>
  );
}
