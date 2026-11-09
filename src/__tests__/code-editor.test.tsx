import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { EditorView } from "@codemirror/view";
import { language as languageFacet } from "@codemirror/language";
import { indentMore, undo } from "@codemirror/commands";
import type { Extension } from "@codemirror/state";
import { CodeEditor } from "../components/code-editor";
import {
  DEFAULT_EDITOR_CONFIG,
  dispatchEditorConfigChanged,
  saveEditorConfig,
} from "@/lib/editor-config";
import * as languages from "@/lib/editor-languages";
import { notify } from "@/lib/notifications";

vi.mock("@/lib/notifications", () => ({ notify: { error: vi.fn() } }));

beforeAll(() => {
  // CodeMirror measures text selections; jsdom supplies no layout geometry.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  HTMLElement.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
  vi.restoreAllMocks();
});

function viewIn(container: HTMLElement): EditorView {
  return EditorView.findFromDOM(
    container.querySelector(".cm-editor") as HTMLElement,
  )!;
}

function ControlledEditor({
  filename = "script.sh",
  onChange = (_value: string) => {},
}) {
  const [value, setValue] = useState('# comment\necho "hello"\n');
  return (
    <CodeEditor
      filename={filename}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

async function chooseLanguage(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Language" }));
  fireEvent.click(await screen.findByRole("option", { name, exact: true }));
}

describe("CodeEditor", () => {
  it("finds, replaces, and undoes changes through the visible editor tools", async () => {
    const original = "alpha alpha\nALPHA beta";
    const { container } = render(
      <CodeEditor filename="test.txt" value={original} />,
    );
    const view = viewIn(container);
    fireEvent.click(screen.getByRole("button", { name: "Find", exact: true }));
    const find = await screen.findByRole("textbox", { name: "Find in file" });
    fireEvent.change(find, { target: { value: "alpha" } });
    expect(screen.getByText("Matches: 3")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    expect(screen.getByText("Matches: 2")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Toggle replace" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Replace with" }), {
      target: { value: "gamma" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    expect(view.state.sliceDoc()).toBe("gamma gamma\nALPHA beta");
    fireEvent.click(screen.getByRole("button", { name: "Undo", exact: true }));
    expect(view.state.sliceDoc()).toBe(original);
    fireEvent.keyDown(find, { key: "Escape" });
    expect(screen.queryByRole("search")).toBeNull();
    expect(view.hasFocus).toBe(true);
  });

  it("reports invalid regex and no matches without changing the document", async () => {
    const { container } = render(<CodeEditor value="alpha" />);
    fireEvent.click(screen.getByRole("button", { name: "Find", exact: true }));
    const find = await screen.findByRole("textbox", { name: "Find in file" });
    fireEvent.change(find, { target: { value: "[" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Use regular expression" }),
    );
    expect(screen.getByText("Invalid regular expression")).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Next match" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(find, { target: { value: "unmatched" } });
    expect(screen.getByText("No matches")).toBeDefined();
    expect(viewIn(container).state.sliceDoc()).toBe("alpha");
  });

  it("navigates to a line and rejects out-of-range input", async () => {
    const { container } = render(<CodeEditor value={"one\ntwo\nthree"} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Go to line" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Line number" }), {
      target: { value: "4" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Go",
          exact: true,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Line number" }), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go", exact: true }));
    expect(viewIn(container).state.selection.main.head).toBe(4);
    expect(screen.getByRole("button", { name: "Go to line" }).textContent).toBe(
      "Ln 2, Col 1",
    );
  });

  it("applies quick settings in place and uses the configured indentation width", async () => {
    const { container } = render(<CodeEditor value="hello" />);
    await act(async () => {});
    const view = viewIn(container);
    fireEvent.click(screen.getByRole("button", { name: "Editor options" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase font size" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Indent width" }), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Color theme" }), {
      target: { value: "light" },
    });
    expect(viewIn(container)).toBe(view);
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);
    expect(
      JSON.parse(localStorage.getItem("rshell-editor-config")!).fontSize,
    ).toBe(15);
    act(() => {
      indentMore(view);
    });
    expect(view.state.sliceDoc()).toBe("    hello");
  });

  it("keeps toolbar font sizes from 29 through 32px after settings reload and remount", async () => {
    localStorage.setItem("rshell-editor-config", JSON.stringify({ ...DEFAULT_EDITOR_CONFIG, fontSize: 28 }));
    const { container, unmount } = render(<CodeEditor value="hello" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Editor options" }));
    const increase = screen.getByRole("button", { name: "Increase font size" });
    for (const fontSize of [29, 30, 31, 32]) {
      fireEvent.click(increase);
      expect(viewIn(container).dom.parentElement!.style.fontSize).toBe(`${fontSize}px`);
      expect(JSON.parse(localStorage.getItem("rshell-editor-config")!).fontSize).toBe(fontSize);
    }
    expect(increase).toHaveProperty("disabled", true);
    unmount();
    const reopened = render(<CodeEditor value="hello" />);
    await act(async () => {});
    expect(viewIn(reopened.container).dom.parentElement!.style.fontSize).toBe("32px");
  });

  it("preserves CRLF when the user edits a Windows file", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <CodeEditor value={"one\r\ntwo\r\n"} onChange={onChange} />,
    );
    await act(async () => {});
    const view = viewIn(container);
    expect(screen.getByText("CRLF")).toBeDefined();
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "new " } });
    });
    expect(onChange).toHaveBeenLastCalledWith("new one\r\ntwo\r\n");
  });

  it("renders real syntax highlighting in both dark and light themes", async () => {
    const { container } = render(<ControlledEditor />);
    const view = viewIn(container);
    await waitFor(() =>
      expect(view.state.facet(languageFacet)?.name).toBe("shell"),
    );
    await waitFor(() =>
      expect(container.querySelector(".cm-line span")).not.toBeNull(),
    );
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
    expect(
      screen.getByRole("combobox", { name: "Language" }).textContent,
    ).toContain("Auto (Shell)");

    document.documentElement.classList.add("dark");
    act(() => {
      saveEditorConfig({ ...DEFAULT_EDITOR_CONFIG, theme: "light" });
      dispatchEditorConfigChanged();
    });
    expect(viewIn(container)).toBe(view);
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);
    expect(getComputedStyle(view.dom).backgroundColor).toBe(
      "rgb(255, 255, 255)",
    );
    expect(getComputedStyle(view.dom).color).toBe("rgb(36, 41, 46)");
    await waitFor(() =>
      expect(container.querySelector(".cm-line span")).not.toBeNull(),
    );
  });

  it("keeps edits, selection, and undo when language or settings change", async () => {
    const onChange = vi.fn();
    const { container } = render(<ControlledEditor onChange={onChange} />);
    const view = viewIn(container);
    await waitFor(() =>
      expect(view.state.facet(languageFacet)?.name).toBe("shell"),
    );
    const original = view.state.doc.toString();
    act(() => {
      view.dispatch({
        changes: { from: 0, insert: "# unsaved\n" },
        selection: { anchor: 12 },
      });
    });
    const edited = view.state.doc.toString();
    expect(onChange).toHaveBeenLastCalledWith(edited);

    await chooseLanguage("Python");
    await waitFor(() =>
      expect(view.state.facet(languageFacet)?.name).toBe("python"),
    );
    act(() => {
      saveEditorConfig({
        ...DEFAULT_EDITOR_CONFIG,
        theme: "light",
        wordWrap: false,
        lineNumbers: false,
        tabSize: 4,
      });
      dispatchEditorConfigChanged();
    });
    expect(viewIn(container)).toBe(view);
    expect(view.state.doc.toString()).toBe(edited);
    expect(view.state.selection.main.anchor).toBe(12);
    expect(view.state.tabSize).toBe(4);
    act(() => {
      expect(undo(view)).toBe(true);
    });
    expect(view.state.doc.toString()).toBe(original);
  });

  it("allows plain text and manual overrides, then detects a different file automatically", async () => {
    const { container, rerender } = render(
      <ControlledEditor filename="app.conf" />,
    );
    const view = viewIn(container);
    await waitFor(() =>
      expect(view.state.facet(languageFacet)?.name).toBe("properties"),
    );
    await chooseLanguage("Nginx");
    await waitFor(() =>
      expect(view.state.facet(languageFacet)?.name).toBe("nginx"),
    );
    await chooseLanguage("Plain text");
    await waitFor(() => expect(view.state.facet(languageFacet)).toBeNull());
    expect(container.querySelector(".cm-line span")).toBeNull();

    rerender(<ControlledEditor filename="app.py" />);
    expect(
      screen.getByRole("combobox", { name: "Language" }).textContent,
    ).toContain("Auto (Python)");
    await waitFor(() =>
      expect(view.state.facet(languageFacet)?.name).toBe("python"),
    );
    expect(viewIn(container)).toBe(view);
  });

  it("syncs external values without reporting user edits and updates read-only mode in place", async () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <CodeEditor
        filename="a.json"
        value='{"old": true}'
        onChange={onChange}
      />,
    );
    const view = viewIn(container);
    rerender(
      <CodeEditor
        filename="a.json"
        value='{"new": true}'
        onChange={onChange}
        readOnly
      />,
    );
    expect(viewIn(container)).toBe(view);
    expect(view.state.doc.toString()).toBe('{"new": true}');
    expect(onChange).not.toHaveBeenCalled();
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
    rerender(
      <CodeEditor
        filename="a.json"
        value='{"new": true}'
        onChange={onChange}
      />,
    );
    expect(view.state.readOnly).toBe(false);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
  });

  it("ignores a slow parser load for a previously selected file", async () => {
    const shell = await languages.loadEditorLanguage("shell");
    const python = await languages.loadEditorLanguage("python");
    const resolvers = new Map<string, (extension: Extension) => void>();
    vi.spyOn(languages, "loadEditorLanguage").mockImplementation(
      (id) =>
        new Promise((resolve) => {
          resolvers.set(id, resolve);
        }),
    );
    const { container, rerender } = render(
      <CodeEditor filename="a.sh" value="echo ok" />,
    );
    const view = viewIn(container);
    rerender(<CodeEditor filename="b.py" value="print('ok')" />);
    await act(async () => {
      resolvers.get("python")!(python);
    });
    expect(view.state.facet(languageFacet)?.name).toBe("python");
    await act(async () => {
      resolvers.get("shell")!(shell);
    });
    expect(view.state.facet(languageFacet)?.name).toBe("python");
  });

  it("keeps the document editable when a parser fails to load", async () => {
    vi.spyOn(languages, "loadEditorLanguage").mockRejectedValueOnce(
      new Error("chunk failed"),
    );
    const onChange = vi.fn();
    const { container } = render(
      <CodeEditor filename="a.sh" value="echo ok" onChange={onChange} />,
    );
    const view = viewIn(container);
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(
        "Could not load syntax highlighting. You can continue editing.",
      ),
    );
    expect(view.state.facet(languageFacet)).toBeNull();
    act(() => {
      view.dispatch({ changes: { from: 7, insert: "\n" } });
    });
    expect(onChange).toHaveBeenLastCalledWith("echo ok\n");
  });
});
