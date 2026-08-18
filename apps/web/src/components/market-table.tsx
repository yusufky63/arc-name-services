import Link from "next/link";
import { formatUnits } from "viem";
import { ArrowUpRightIcon } from "./icons";
import type { LiveMarketListing } from "@/lib/market-data";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function deadline(timestamp: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Number(timestamp) * 1_000));
}

/** Read-only table for listings returned by the verified Arc market API. */
export function MarketTable({ rows }: { rows: LiveMarketListing[] }) {
  const tones = ["paper", "ice", "sand"] as const;
  return (
    <div className="market-table">
      <div className="market-table__head" aria-hidden="true">
        <span>Name</span>
        <span>Price</span>
        <span>Seller</span>
        <span>Deadline</span>
        <span />
      </div>
      {rows.map((row, index) => (
        <Link
          href={`/name/${encodeURIComponent(row.label)}`}
          className={`market-row market-row--${tones[index % tones.length]}`}
          key={row.tokenId}
          aria-label={`Open listing: ${row.name}`}
        >
          <span className="market-row__index">{String(index + 1).padStart(2, "0")}</span>
          <strong>{row.name}</strong>
          <span>{formatUnits(BigInt(row.price), 6)} USDC</span>
          <code>{shortAddress(row.seller)}</code>
          <span>{deadline(row.validUntil)}</span>
          <ArrowUpRightIcon />
        </Link>
      ))}
    </div>
  );
}
