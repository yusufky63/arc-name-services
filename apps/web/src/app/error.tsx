"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main-content" className="error-page">
      <div className="error-page__content content-shell">
        <span>SAFE FAILURE</span>
        <h1>The read surface stopped safely.</h1>
        <button type="button" onClick={reset}>Try again</button>
      </div>
    </main>
  );
}
