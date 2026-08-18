"use client";

import {
  type FocusEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PRODUCT_DEFAULTS } from "@/lib/brand";
import { durationNavigationTarget } from "./registration-duration";

export function RegistrationDurationSelect({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  const options = useMemo(
    () =>
      Array.from(
        {
          length:
            PRODUCT_DEFAULTS.maxRegistrationYears -
            PRODUCT_DEFAULTS.minRegistrationYears +
            1,
        },
        (_, index) => PRODUCT_DEFAULTS.minRegistrationYears + index,
      ),
    [],
  );
  const selectedIndex = Math.max(options.indexOf(value), 0);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);

  const displayedOpen = open && !disabled;

  useEffect(() => {
    if (displayedOpen) listboxRef.current?.focus();
  }, [displayedOpen]);

  function openListbox(index = selectedIndex) {
    if (disabled) return;
    setActiveIndex(index);
    setOpen(true);
  }

  function selectIndex(index: number) {
    const nextValue = options[index];
    if (nextValue === undefined) return;
    onChange(nextValue);
    setActiveIndex(index);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      openListbox(
        durationNavigationTarget(selectedIndex, event.key, options.length),
      );
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openListbox();
    }
  }

  function handleListboxKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      const navigationKey = event.key;
      setActiveIndex((current) =>
        durationNavigationTarget(current, navigationKey, options.length),
      );
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectIndex(activeIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (/^[1-9]$/.test(event.key)) {
      const typedValue = Number(event.key);
      const typedIndex = options.indexOf(typedValue);
      if (typedIndex >= 0) {
        event.preventDefault();
        setActiveIndex(typedIndex);
      }
    }
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !rootRef.current?.contains(nextTarget)) {
      setOpen(false);
    }
  }

  return (
    <div className="registration-duration" ref={rootRef} onBlur={handleBlur}>
      <button
        ref={triggerRef}
        id="registration-years"
        className="registration-duration__trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={displayedOpen}
        aria-controls="registration-years-options"
        disabled={disabled}
        onClick={() => (displayedOpen ? setOpen(false) : openListbox())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="registration-duration__value">
          {value} {value === 1 ? "year" : "years"}
        </span>
        <span className="registration-duration__chevron" aria-hidden="true">
          {displayedOpen ? "\u2191" : "\u2193"}
        </span>
      </button>
      {displayedOpen ? (
        <div
          ref={listboxRef}
          id="registration-years-options"
          className="registration-duration__options"
          role="listbox"
          tabIndex={-1}
          aria-labelledby="registration-years-label"
          aria-activedescendant={`registration-years-option-${options[activeIndex]}`}
          onKeyDown={handleListboxKeyDown}
        >
          {options.map((option, index) => {
            const selected = option === value;
            return (
              <button
                id={`registration-years-option-${option}`}
                className={`registration-duration__option${
                  selected ? " registration-duration__option--selected" : ""
                }`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={selected}
                data-active={index === activeIndex}
                key={option}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectIndex(index)}
              >
                <span>{option} {option === 1 ? "year" : "years"}</span>
                {selected ? <span aria-hidden="true">{"\u2713"}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
