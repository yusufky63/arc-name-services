"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { shouldShowAdminNavigation } from "@/lib/navigation-access";
import { CloseIcon, MenuIcon } from "./icons";
import { WalletControl } from "./wallet-control";
import { useWalletManager } from "./wallet-manager";
import { Wordmark } from "./wordmark";

const productLinks = [
  { href: "/", label: "Search" },
  { href: "/market", label: "Market" },
  { href: "/me", label: "My names" },
] as const;

const adminLink = { href: "/admin", label: "Admin" } as const;
const developerLink = { href: "/developers", label: "Developers" } as const;

type SiteHeaderProps = {
  governanceAccount: string | null;
};

export function SiteHeader({ governanceAccount }: SiteHeaderProps) {
  const pathname = usePathname();
  const wallet = useWalletManager();
  const [open, setOpen] = useState(false);
  const links = [
    ...productLinks,
    ...(shouldShowAdminNavigation(wallet.account, governanceAccount)
      ? [adminLink]
      : []),
    developerLink,
  ];

  return (
    <header className="site-header">
      <div className="site-header__inner content-shell">
        <Wordmark inverted />
        <nav
          id="primary-navigation"
          className={`site-nav${open ? " site-nav--open" : ""}`}
          aria-label="Primary"
        >
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={
                pathname === link.href ||
                (link.href !== "/" && pathname.startsWith(`${link.href}/`))
                  ? "page"
                  : undefined
              }
              onClick={() => setOpen(false)}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="site-header__actions">
          <WalletControl />
          <button
            className="menu-button"
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="primary-navigation"
            aria-label={open ? "Close navigation" : "Open navigation"}
          >
            {open ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>
    </header>
  );
}
