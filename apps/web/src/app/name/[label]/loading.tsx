export default function Loading() {
  return (
    <main id="main-content" className="route-loading" aria-live="polite">
      <div className="route-loading__content content-shell">
        <span>Reading live name state</span>
        <div aria-hidden="true" />
      </div>
    </main>
  );
}
