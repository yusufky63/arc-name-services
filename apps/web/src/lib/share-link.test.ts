import { afterEach, describe, expect, it, vi } from "vitest";
import { copyBrowserText } from "./share-link";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyBrowserText", () => {
  it("uses the Clipboard API when the write is allowed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await copyBrowserText("https://names.example/name/alice");

    expect(writeText).toHaveBeenCalledWith("https://names.example/name/alice");
  });

  it("falls back to a selected textarea when an exposed Clipboard API rejects", async () => {
    class ElementMock {
      focus = vi.fn();
    }
    const previousFocus = new ElementMock();
    const input = {
      value: "",
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      focus: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
    };
    const append = vi.fn();
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("HTMLElement", ElementMock);
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error("permission denied")),
      },
    });
    vi.stubGlobal("document", {
      activeElement: previousFocus,
      createElement: vi.fn(() => input),
      body: { append },
      execCommand,
    });

    await copyBrowserText("https://names.example/name/alice");

    expect(input.value).toBe("https://names.example/name/alice");
    expect(input.setAttribute).toHaveBeenCalledWith("readonly", "");
    expect(append).toHaveBeenCalledWith(input);
    expect(input.focus).toHaveBeenCalledOnce();
    expect(input.select).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(input.remove).toHaveBeenCalledOnce();
    expect(previousFocus.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
