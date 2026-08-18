"use client";

import { useState } from "react";
import { copyBrowserText } from "@/lib/share-link";

type ShareState = "idle" | "copied" | "shared" | "error";

function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

export function NameShareActions({
  fullName,
  namePath,
}: {
  fullName: string;
  namePath: string;
}) {
  const [state, setState] = useState<ShareState>("idle");

  async function copyNameLink() {
    try {
      await copyBrowserText(absoluteUrl(namePath));
      setState("copied");
    } catch {
      setState("error");
    }
  }

  async function shareName() {
    const url = absoluteUrl(namePath);
    if (typeof navigator.share !== "function") {
      await copyNameLink();
      return;
    }

    try {
      await navigator.share({
        title: fullName,
        text: `View ${fullName} on Contour.`,
        url,
      });
      setState("shared");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setState("idle");
        return;
      }
      try {
        await copyBrowserText(url);
        setState("copied");
      } catch {
        setState("error");
      }
    }
  }

  const message =
    state === "shared"
      ? "Share sheet opened."
      : state === "copied"
        ? "Name link copied."
        : state === "error"
          ? "The link could not be copied."
          : "";

  return (
    <div className="name-share-actions">
      <button type="button" onClick={shareName} aria-label={`Share ${fullName}`}>
        Share name
      </button>
      <button type="button" onClick={copyNameLink} aria-label={`Copy link to ${fullName}`}>
        Copy link
      </button>
      <span className="name-share-actions__status" role="status" aria-live="polite">
        {message}
      </span>
    </div>
  );
}
