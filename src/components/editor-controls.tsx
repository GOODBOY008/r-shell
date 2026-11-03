import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { openSearchPanel, searchPanelOpen } from "@codemirror/search";
import {
  Check,
  ChevronDown,
  Code2,
  CornerDownLeft,
  ListOrdered,
  Minus,
  Plus,
  Redo2,
  Search,
  Settings2,
  Sparkles,
  Undo2,
  WrapText,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import type { EditorConfig } from "@/lib/editor-config";
import {
  EDITOR_LANGUAGE_IDS,
  type EditorLanguageId,
} from "@/lib/editor-languages";

type CommonProps = {
  view: EditorView | null;
  state: EditorState | null;
  config: EditorConfig;
  onConfigChange: (patch: Partial<EditorConfig>) => void;
  dark: boolean;
};

export function EditorToolbar({
  view,
  state,
  config,
  onConfigChange,
  dark,
}: CommonProps) {
  const { t } = useTranslation();
  return (
    <div
      className="editor-toolbar"
      role="toolbar"
      aria-label={t("codeEditor.toolbar")}
    >
      <div className="editor-tool-group">
        <button
          type="button"
          className="editor-tool"
          aria-label={t("codeEditor.undo")}
          title={`${t("codeEditor.undo")} (⌘/Ctrl+Z)`}
          disabled={!state || state.readOnly || !undoDepth(state)}
          onClick={() => {
            if (view) {
              undo(view);
              view.focus();
            }
          }}
        >
          <Undo2 />
        </button>
        <button
          type="button"
          className="editor-tool"
          aria-label={t("codeEditor.redo")}
          title={`${t("codeEditor.redo")} (⌘/Ctrl+Shift+Z)`}
          disabled={!state || state.readOnly || !redoDepth(state)}
          onClick={() => {
            if (view) {
              redo(view);
              view.focus();
            }
          }}
        >
          <Redo2 />
        </button>
      </div>
      <span className="editor-divider" />
      <button
        type="button"
        className="editor-tool editor-tool-label"
        aria-label={t("codeEditor.find")}
        title={`${t("codeEditor.find")} (⌘/Ctrl+F)`}
        aria-pressed={state ? searchPanelOpen(state) : false}
        onClick={() => {
          if (view) openSearchPanel(view);
        }}
      >
        <Search />
        <span>{t("codeEditor.find")}</span>
        <kbd>⌘/Ctrl F</kbd>
      </button>
      <div className="editor-toolbar-spacer" />
      <button
        type="button"
        className="editor-tool"
        aria-label={t("codeEditor.wordWrap")}
        title={t("codeEditor.wordWrap")}
        aria-pressed={config.wordWrap}
        onClick={() => onConfigChange({ wordWrap: !config.wordWrap })}
      >
        <WrapText />
      </button>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="editor-tool"
            aria-label={t("codeEditor.settings")}
            title={t("codeEditor.settings")}
          >
            <Settings2 />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="editor-popover editor-settings"
          data-editor-theme={dark ? "dark" : "light"}
          align="end"
          sideOffset={8}
        >
          <div className="editor-popover-heading">
            <Settings2 />
            <span>{t("codeEditor.settings")}</span>
          </div>
          <label className="editor-setting-row">
            <span>{t("codeEditor.theme")}</span>
            <select
              className="editor-input"
              aria-label={t("codeEditor.theme")}
              value={config.theme === "light" ? "light" : "oneDark"}
              onChange={(event) =>
                onConfigChange({ theme: event.target.value })
              }
            >
              <option value="oneDark">One Dark</option>
              <option value="light">{t("codeEditor.lightTheme")}</option>
            </select>
          </label>
          <div className="editor-setting-row">
            <span>{t("codeEditor.fontSize")}</span>
            <div className="editor-stepper">
              <button
                type="button"
                className="editor-tool"
                aria-label={t("codeEditor.decreaseFontSize")}
                disabled={config.fontSize <= 10}
                onClick={() =>
                  onConfigChange({
                    fontSize: Math.max(10, config.fontSize - 1),
                  })
                }
              >
                <Minus />
              </button>
              <output>{config.fontSize} px</output>
              <button
                type="button"
                className="editor-tool"
                aria-label={t("codeEditor.increaseFontSize")}
                disabled={config.fontSize >= 32}
                onClick={() =>
                  onConfigChange({
                    fontSize: Math.min(32, config.fontSize + 1),
                  })
                }
              >
                <Plus />
              </button>
            </div>
          </div>
          <label className="editor-setting-row">
            <span>{t("codeEditor.indentSize")}</span>
            <select
              className="editor-input"
              aria-label={t("codeEditor.indentSize")}
              value={config.tabSize}
              onChange={(event) =>
                onConfigChange({ tabSize: Number(event.target.value) })
              }
            >
              {[2, 4, 8].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <label className="editor-setting-row">
            <span className="editor-setting-label">
              <ListOrdered />
              {t("codeEditor.lineNumbers")}
            </span>
            <input
              type="checkbox"
              checked={config.lineNumbers}
              onChange={(event) =>
                onConfigChange({ lineNumbers: event.target.checked })
              }
            />
          </label>
          <label className="editor-setting-row">
            <span className="editor-setting-label">
              <WrapText />
              {t("codeEditor.wordWrap")}
            </span>
            <input
              type="checkbox"
              checked={config.wordWrap}
              onChange={(event) =>
                onConfigChange({ wordWrap: event.target.checked })
              }
            />
          </label>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function EditorStatusBar({
  view,
  state,
  config,
  dark,
  languageChoice,
  detectedLanguage,
  onLanguageChange,
  goToLineOpen,
  onGoToLineOpenChange,
}: CommonProps & {
  languageChoice: EditorLanguageId | "auto";
  detectedLanguage: EditorLanguageId;
  onLanguageChange: (id: EditorLanguageId | "auto") => void;
  goToLineOpen: boolean;
  onGoToLineOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [languageOpen, setLanguageOpen] = useState(false);
  const [lineInput, setLineInput] = useState("");
  const lineInputId = useId();
  const head = state?.selection.main.head ?? 0;
  const line = state?.doc.lineAt(head);
  const selected =
    state?.selection.ranges.reduce(
      (length, range) => length + range.to - range.from,
      0,
    ) ?? 0;
  const lineCount = state?.doc.lines ?? 1;
  const lineNumber = Number(lineInput);
  const validLine =
    /^\d+$/.test(lineInput) && lineNumber >= 1 && lineNumber <= lineCount;
  const theme = dark ? "dark" : "light";
  const languageLabel =
    languageChoice === "auto"
      ? t("codeEditor.automatic", {
          language: t(`codeEditor.languages.${detectedLanguage}`),
        })
      : t(`codeEditor.languages.${languageChoice}`);

  return (
    <div className="editor-statusbar" aria-label={t("codeEditor.statusBar")}>
      <div className="editor-status-left">
        <Popover open={goToLineOpen} onOpenChange={onGoToLineOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="editor-status-button"
              title={`${t("codeEditor.goToLine")} (⌘/Ctrl+Alt+G)`}
              aria-label={t("codeEditor.goToLine")}
              onClick={() => setLineInput(String(line?.number ?? 1))}
            >
              {t("codeEditor.cursorPosition", {
                line: line?.number ?? 1,
                column: head - (line?.from ?? 0) + 1,
              })}
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="editor-popover editor-goto"
            data-editor-theme={theme}
            align="start"
            side="top"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
            }}
            onEscapeKeyDown={() => view?.focus()}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!validLine || !view) return;
                const position = view.state.doc.line(lineNumber).from;
                view.dispatch({
                  selection: { anchor: position },
                  effects: EditorView.scrollIntoView(position, { y: "center" }),
                });
                onGoToLineOpenChange(false);
                view.focus();
              }}
            >
              <label className="editor-popover-heading" htmlFor={lineInputId}>
                {t("codeEditor.goToLine")}
              </label>
              <div className="editor-goto-row">
                <input
                  id={lineInputId}
                  className="editor-input"
                  aria-label={t("codeEditor.lineNumber")}
                  inputMode="numeric"
                  value={lineInput}
                  onChange={(event) => setLineInput(event.target.value)}
                  placeholder={`1–${lineCount}`}
                />
                <button
                  type="submit"
                  className="editor-text-button"
                  disabled={!validLine}
                >
                  <CornerDownLeft />
                  {t("codeEditor.go")}
                </button>
              </div>
              <p className="editor-help">
                {t("codeEditor.lineRange", { max: lineCount })}
              </p>
            </form>
          </PopoverContent>
        </Popover>
        <span className="editor-status-detail">
          {selected
            ? t("codeEditor.selected", { length: selected })
            : t("codeEditor.lineCount", { count: lineCount })}
        </span>
      </div>
      <div className="editor-status-right">
        {state?.readOnly && (
          <span className="editor-readonly">{t("codeEditor.readOnly")}</span>
        )}
        <span className="editor-status-detail">UTF-8</span>
        <span
          className="editor-status-detail"
          title={t("codeEditor.lineEndings")}
        >
          {state?.lineBreak === "\r\n" ? "CRLF" : "LF"}
        </span>
        <span className="editor-status-indent">
          {t("codeEditor.spaces", { size: config.tabSize })}
        </span>
        <Popover open={languageOpen} onOpenChange={setLanguageOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              role="combobox"
              aria-expanded={languageOpen}
              aria-label={t("codeEditor.language")}
              className="editor-status-button editor-language-trigger"
              title={languageLabel}
            >
              {languageChoice === "auto" ? <Sparkles /> : <Code2 />}
              <span>{languageLabel}</span>
              <ChevronDown />
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="editor-popover editor-language-menu"
            data-editor-theme={theme}
            align="end"
            side="top"
            sideOffset={6}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
            }}
            onEscapeKeyDown={() => view?.focus()}
          >
            <Command loop>
              <CommandInput
                placeholder={t("codeEditor.searchLanguages")}
                aria-label={t("codeEditor.searchLanguages")}
              />
              <CommandList>
                <CommandEmpty>{t("codeEditor.noLanguages")}</CommandEmpty>
                <CommandGroup>
                  <CommandItem
                    value="auto"
                    keywords={[t("codeEditor.autoDetect")]}
                    onSelect={() => {
                      onLanguageChange("auto");
                      setLanguageOpen(false);
                      view?.focus();
                    }}
                  >
                    <Sparkles />
                    <span>
                      {t("codeEditor.autoDetect")}
                      <small>
                        {t(`codeEditor.languages.${detectedLanguage}`)}
                      </small>
                    </span>
                    {languageChoice === "auto" && <Check className="ml-auto" />}
                  </CommandItem>
                  {EDITOR_LANGUAGE_IDS.map((id) => (
                    <CommandItem
                      key={id}
                      value={id}
                      keywords={[t(`codeEditor.languages.${id}`)]}
                      onSelect={() => {
                        onLanguageChange(id);
                        setLanguageOpen(false);
                        view?.focus();
                      }}
                    >
                      <span className="editor-language-check">
                        {languageChoice === id && <Check />}
                      </span>
                      {t(`codeEditor.languages.${id}`)}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
