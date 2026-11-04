import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  SearchQuery,
  getSearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  closeSearchPanel,
} from "@codemirror/search";
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  ChevronRight,
  Regex,
  WholeWord,
  X,
} from "lucide-react";

export function EditorSearchPanel({
  view,
  state,
  replaceRequest = 0,
}: {
  view: EditorView;
  state: EditorState;
  replaceRequest?: number;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [showReplace, setShowReplace] = useState(false);
  useEffect(() => { if (replaceRequest > 0) setShowReplace(true); }, [replaceRequest]);
  const query = getSearchQuery(state);
  const invalid = !!query.search && !query.valid;
  const results = useMemo(() => {
    const matches: Array<{ from: number; to: number }> = [];
    if (query.valid) {
      const cursor = query.getCursor(state.doc);
      for (let next = cursor.next(); !next.done; next = cursor.next()) {
        if (matches.length === 1000) return { matches, capped: true };
        matches.push(next.value);
      }
    }
    return { matches, capped: false };
  }, [query, state.doc]);
  const current =
    results.matches.findIndex(
      (match) =>
        match.from === state.selection.main.from &&
        match.to === state.selection.main.to,
    ) + 1;
  const total = `${results.matches.length}${results.capped ? "+" : ""}`;
  const resultText = invalid
    ? t("codeEditor.search.invalidRegex")
    : !query.search
      ? t("codeEditor.search.hint")
      : results.matches.length === 0
        ? t("codeEditor.search.noResults")
        : current
          ? t("codeEditor.search.position", { current, total })
          : t("codeEditor.search.results", { total });

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const update = (
    patch: Partial<
      Pick<
        SearchQuery,
        "search" | "replace" | "caseSensitive" | "regexp" | "wholeWord"
      >
    >,
  ) => {
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: query.search,
          replace: query.replace,
          caseSensitive: query.caseSensitive,
          regexp: query.regexp,
          wholeWord: query.wholeWord,
          ...patch,
        }),
      ),
    });
  };
  const close = () => {
    closeSearchPanel(view);
    view.focus();
  };

  return (
    <div
      className="editor-search"
      role="search"
      aria-label={t("codeEditor.search.title")}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          event.stopPropagation();
          if (query.valid) (event.shiftKey ? findPrevious : findNext)(view);
        }
      }}
    >
      <div className="editor-search-row">
        {!state.readOnly && (
          <button
            type="button"
            className="editor-tool"
            aria-label={t("codeEditor.search.toggleReplace")}
            aria-expanded={showReplace}
            onClick={() => setShowReplace(!showReplace)}
          >
            <ChevronRight className={showReplace ? "rotate-90" : ""} />
          </button>
        )}
        <div className="editor-search-field">
          <input
            ref={inputRef}
            main-field="true"
            aria-label={t("codeEditor.search.find")}
            aria-invalid={invalid}
            placeholder={t("codeEditor.search.find")}
            value={query.search}
            onChange={(event) => update({ search: event.target.value })}
            spellCheck={false}
          />
          {(
            [
              ["caseSensitive", CaseSensitive, "matchCase"],
              ["wholeWord", WholeWord, "wholeWord"],
              ["regexp", Regex, "regex"],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              type="button"
              className="editor-tool"
              aria-label={t(`codeEditor.search.${label}`)}
              title={t(`codeEditor.search.${label}`)}
              aria-pressed={query[key]}
              onClick={() => update({ [key]: !query[key] })}
            >
              <Icon />
            </button>
          ))}
        </div>
        <div className="editor-search-navigation">
          <button
            type="button"
            className="editor-tool"
            title={t("codeEditor.search.previous")}
            aria-label={t("codeEditor.search.previous")}
            disabled={!results.matches.length}
            onClick={() => findPrevious(view)}
          >
            <ArrowUp />
          </button>
          <button
            type="button"
            className="editor-tool"
            title={t("codeEditor.search.next")}
            aria-label={t("codeEditor.search.next")}
            disabled={!results.matches.length}
            onClick={() => findNext(view)}
          >
            <ArrowDown />
          </button>
          <button
            type="button"
            className="editor-tool"
            title={t("codeEditor.search.close")}
            aria-label={t("codeEditor.search.close")}
            onClick={close}
          >
            <X />
          </button>
        </div>
      </div>
      {showReplace && !state.readOnly && (
        <div className="editor-replace-row">
          <input
            className="editor-input"
            aria-label={t("codeEditor.search.replaceWith")}
            placeholder={t("codeEditor.search.replaceWith")}
            value={query.replace}
            onChange={(event) => update({ replace: event.target.value })}
            spellCheck={false}
          />
          <button
            type="button"
            className="editor-text-button"
            disabled={!results.matches.length}
            onClick={() => replaceNext(view)}
          >
            {t("codeEditor.search.replace")}
          </button>
          <button
            type="button"
            className="editor-text-button"
            disabled={!results.matches.length}
            onClick={() => replaceAll(view)}
          >
            {t("codeEditor.search.replaceAll")}
          </button>
        </div>
      )}
      <div
        className={`editor-search-result ${invalid ? "is-error" : ""}`}
        role="status"
        aria-live="polite"
      >
        {resultText}
      </div>
    </div>
  );
}
