import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DirectoryTree } from "../components/directory-tree";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

function makeLoader(
  map: Record<string, string[]>,
): (path: string) => Promise<string[]> {
  return (path: string) => Promise.resolve(map[path] ?? []);
}

describe("DirectoryTree", () => {
  const defaultLoader = makeLoader({
    "/": ["home", "tmp"],
    "/home": ["user"],
    "/tmp": [],
  });

  it("lazy-loads and caches directory children on expand", async () => {
    const loader = vi.fn().mockImplementation(defaultLoader);

    render(
      <DirectoryTree
        loadDirectory={loader}
        currentPath="/"
        onNavigate={() => {}}
      />,
    );

    await waitFor(() => expect(loader).toHaveBeenCalledWith("/"));

    await screen.findByLabelText("Expand home");
    fireEvent.click(screen.getByLabelText("Expand home"));

    await waitFor(() => {
      const homeCalls = loader.mock.calls.filter((c) => c[0] === "/home");
      expect(homeCalls).toHaveLength(1);
    });

    // Second expand should NOT re-fetch (cache hit)
    fireEvent.click(screen.getByLabelText("Collapse home"));
    fireEvent.click(screen.getByLabelText("Expand home"));

    const homeCalls = loader.mock.calls.filter((c) => c[0] === "/home");
    expect(homeCalls).toHaveLength(1);
  });

  it("clicking a row triggers navigation", async () => {
    const onNavigate = vi.fn();

    render(
      <DirectoryTree
        loadDirectory={defaultLoader}
        currentPath="/"
        onNavigate={onNavigate}
      />,
    );

    await screen.findByLabelText("Navigate to /home");

    fireEvent.click(screen.getByLabelText("Navigate to /home"));
    expect(onNavigate).toHaveBeenCalledWith("/home");
  });

  it("supports keyboard navigation and enter-to-navigate", async () => {
    const onNavigate = vi.fn();

    render(
      <DirectoryTree
        loadDirectory={defaultLoader}
        currentPath="/"
        onNavigate={onNavigate}
      />,
    );

    await screen.findByLabelText("Navigate to /home");

    const tree = screen.getByTestId("directory-tree");
    tree.focus();

    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "Enter" });

    expect(onNavigate).toHaveBeenCalledWith("/home");
  });

  beforeEach(() => vi.clearAllMocks());
});
