export function NetworkBadge({ dark = false }: { dark?: boolean }) {
  return (
    <span className={`network-badge${dark ? " network-badge--dark" : ""}`}>
      <i aria-hidden="true" />
      Arc Testnet
    </span>
  );
}

