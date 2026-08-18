import Link from "next/link";

export function Wordmark({ inverted = false }: { inverted?: boolean }) {
  return (
    <Link
      href="/"
      className={`wordmark${inverted ? " wordmark--inverted" : ""}`}
      aria-label="Contour home"
    >
      <svg viewBox="0 0 42 42" aria-hidden="true" className="wordmark__mark">
        <path d="M7 33V21C7 13.268 13.268 7 21 7s14 6.268 14 14v12" />
        <path d="M13 33V21a8 8 0 0 1 16 0v12" />
      </svg>
      <span>CONTOUR</span>
    </Link>
  );
}

