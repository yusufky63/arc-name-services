import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function ArrowUpRightIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" {...props}>
      <path d="M7 17 17 7M8 7h9v9" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" {...props}>
      <circle cx="10.8" cy="10.8" r="6.8" stroke="currentColor" strokeWidth="1.8" />
      <path d="m16 16 4.2 4.2" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function WalletIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" {...props}>
      <path d="M4 7.5h14a2 2 0 0 1 2 2v9H6a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h11" stroke="currentColor" strokeWidth="1.7" />
      <path d="M15 12h5v4h-5a2 2 0 0 1 0-4Z" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" {...props}>
      <path d="M4 8h16M4 16h16" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" {...props}>
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

