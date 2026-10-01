/**
 * A problem with a brief is data, not an exception: the caller gets a list of
 * these alongside a best-effort plan. `path` is a JSON pointer into the brief, so
 * a form can render each one against the field that caused it.
 */

export type Severity = "blocker" | "warning" | "info";

export type Diagnostic = {
  /** Stable and safe to switch on. Add a new code rather than rewording one. */
  code: string;
  severity: Severity;
  /** JSON pointer into the brief, e.g. "/creatives/0/title". */
  path: string;
  message: string;
  /** Set when the fix is deterministic; `value` replaces whatever is at `path`. */
  fix?: { summary: string; value?: unknown };
  /** The spec constraint or platform behaviour behind this. */
  source?: string;
};

export function blocker(code: string, path: string, message: string, extra: Partial<Diagnostic> = {}): Diagnostic {
  return { code, severity: "blocker", path, message, ...extra };
}
export function warning(code: string, path: string, message: string, extra: Partial<Diagnostic> = {}): Diagnostic {
  return { code, severity: "warning", path, message, ...extra };
}
export function info(code: string, path: string, message: string, extra: Partial<Diagnostic> = {}): Diagnostic {
  return { code, severity: "info", path, message, ...extra };
}

export function hasBlockers(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "blocker");
}

export function summarize(diagnostics: Diagnostic[]) {
  return {
    blockers: diagnostics.filter((d) => d.severity === "blocker").length,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
    info: diagnostics.filter((d) => d.severity === "info").length,
  };
}

/** Stable ordering, so two compiles of one brief match byte for byte. */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const rank: Record<Severity, number> = { blocker: 0, warning: 1, info: 2 };
  return [...diagnostics].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path) || a.code.localeCompare(b.code),
  );
}
