"use client";

import React, { useEffect, useState } from "react";
import type { ProtocolStats } from "@/lib/protocol-read-model";

const BASELINE_STATS: ProtocolStats = {
  chainId: 5_042,
  totalRegistered: 0,
  totalListed: 0,
  uniqueOwners: 0,
  currency: "USDC",
  asOfBlock: "0",
};

export function ProtocolStatsRibbon({ readEnabled }: { readEnabled: boolean }) {
  const [stats, setStats] = useState<ProtocolStats>(BASELINE_STATS);

  useEffect(() => {
    if (!readEnabled) return;
    let mounted = true;

    async function loadStats() {
      try {
        const response = await fetch("/api/protocol/stats");
        if (!response.ok) return;
        const data = (await response.json()) as ProtocolStats;
        if (mounted) {
          setStats(data);
        }
      } catch {
        // Retain baseline numbers gracefully
      }
    }

    void loadStats();
    return () => {
      mounted = false;
    };
  }, [readEnabled]);

  if (!readEnabled) return null;

  return (
    <section className="protocol-stats-surface">
      <div className="protocol-stats content-shell">
        <div className="protocol-stats__grid">
          <div className="protocol-stat">
            <span className="protocol-stat__index">01 / TOTAL</span>
            <strong className="protocol-stat__value">
              {stats.totalRegistered.toString().padStart(2, "0")}
            </strong>
            <span className="protocol-stat__label">REGISTERED NAMES</span>
            <p className="protocol-stat__hint">Confirmed on Arc Mainnet</p>
          </div>
          <div className="protocol-stat">
            <span className="protocol-stat__index">02 / MARKET</span>
            <strong className="protocol-stat__value">
              {stats.totalListed.toString().padStart(2, "0")}
            </strong>
            <span className="protocol-stat__label">NAMES FOR SALE</span>
            <p className="protocol-stat__hint">Active marketplace listings</p>
          </div>
          <div className="protocol-stat">
            <span className="protocol-stat__index">03 / OWNERS</span>
            <strong className="protocol-stat__value">
              {stats.uniqueOwners.toString().padStart(2, "0")}
            </strong>
            <span className="protocol-stat__label">ACTIVE USERS</span>
            <p className="protocol-stat__hint">Unique identity holders</p>
          </div>
          <div className="protocol-stat">
            <span className="protocol-stat__index">04 / SETTLEMENT</span>
            <strong className="protocol-stat__value">100% USDC</strong>
            <span className="protocol-stat__label">INSTANT FINALITY</span>
            <p className="protocol-stat__hint">Native Arc transactions</p>
          </div>
        </div>
      </div>
    </section>
  );
}
