"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { BRAND } from "@/lib/brand";
import { cleanLabel, isPlausibleLabel } from "@/lib/names";
import { SearchIcon } from "./icons";

export function SearchForm({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmedValue, setConfirmedValue] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isPlausibleLabel(value)) {
      setError("Enter a valid name to continue.");
      return;
    }
    const label = cleanLabel(value);
    const typedLabel = value;
    if (typedLabel !== label && confirmedValue !== label) {
      setValue(label);
      setConfirmedValue(label);
      setError(`“${typedLabel}” becomes “${label}”. Check again to confirm.`);
      return;
    }
    setError(null);
    setConfirmedValue(null);
    router.push(`/name/${encodeURIComponent(label)}`);
  }

  return (
    <form className={`name-search${compact ? " name-search--compact" : ""}`} onSubmit={submit}>
      <label htmlFor={compact ? "compact-name-search" : "name-search"}>
        Find your name
      </label>
      <div className="name-search__control">
        <SearchIcon />
        <input
          id={compact ? "compact-name-search" : "name-search"}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setConfirmedValue(null);
          }}
          placeholder="yourname"
          autoComplete="off"
          spellCheck={false}
        />
        <span>{BRAND.suffix}</span>
        <button type="submit" aria-label="Check &amp; register">
          <span className="name-search__action-full">Check &amp; register</span>
          <span className="name-search__action-short">Check</span>
          <b aria-hidden="true">↗</b>
        </button>
      </div>
      {error ? <p className="name-search__error" role="alert">{error}</p> : null}
    </form>
  );
}
