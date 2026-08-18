import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main-content" className="error-page">
      <div className="error-page__content content-shell">
        <span>404 / OUTSIDE THE CONTOUR</span>
        <h1>This coordinate does not exist.</h1>
        <Link href="/">Return to search</Link>
      </div>
    </main>
  );
}
