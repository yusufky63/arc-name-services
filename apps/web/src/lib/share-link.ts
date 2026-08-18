export async function copyBrowserText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Embedded browsers can expose Clipboard API while denying the write.
      // Continue with the selection-based fallback in that case.
    }
  }

  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.inset = "0 auto auto -9999px";
  input.style.opacity = "0";
  document.body.append(input);
  input.focus();
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  previousFocus?.focus({ preventScroll: true });
  if (!copied) throw new Error("Clipboard copy was rejected.");
}
