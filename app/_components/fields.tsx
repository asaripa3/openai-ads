"use client";

import type { ReactNode } from "react";
import type { Diagnostic } from "@/domain/diagnostics";

export function Problems({ items, onFix }: { items: Diagnostic[]; onFix?: (d: Diagnostic) => void }) {
  if (!items.length) return null;
  return (
    <>
      {items.map((d, i) => (
        <div className="problem" data-sev={d.severity} key={`${d.code}-${i}`}>
          <span className="ico">{d.severity === "blocker" ? "!" : d.severity === "warning" ? "!" : "i"}</span>
          <span>
            {d.message}
            {d.fix && d.fix.value !== undefined && onFix ? (
              <button type="button" className="fixbtn" onClick={() => onFix(d)}>
                {d.fix.summary}
              </button>
            ) : null}
          </span>
        </div>
      ))}
    </>
  );
}

export function Field({
  label,
  hint,
  children,
  problems = [],
  counter,
  onFix,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  problems?: Diagnostic[];
  counter?: ReactNode;
  onFix?: (d: Diagnostic) => void;
}) {
  return (
    <div className="field">
      <div className="label-row">
        <span className="field-label">{label}</span>
        {counter}
      </div>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
      <Problems items={problems} onFix={onFix} />
    </div>
  );
}

export function CharCount({ value, max }: { value: string; max: number }) {
  const state = value.length > max ? "over" : value.length > max * 0.85 ? "warn" : "ok";
  return (
    <span className="counter" data-state={state}>
      {value.length}/{max}
    </span>
  );
}

/** Space/comma/Enter separated tag entry. */
export function TagInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  return (
    <>
      <input
        className="control"
        placeholder={placeholder}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          const value = event.currentTarget.value.trim();
          if (!value) return;
          onChange([...values, value]);
          event.currentTarget.value = "";
        }}
      />
      {values.length ? (
        <div className="chips" style={{ marginTop: 8 }}>
          {values.map((value, i) => (
            <span className="chip chip-remove" key={`${value}-${i}`}>
              {value}
              <button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

export function ChipGroup<T extends string>({
  options,
  selected,
  onToggle,
}: {
  options: Array<{ value: T; label: string }>;
  selected: T[];
  onToggle: (value: T) => void;
}) {
  return (
    <div className="chips">
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className="chip"
          aria-pressed={selected.includes(option.value)}
          onClick={() => onToggle(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
