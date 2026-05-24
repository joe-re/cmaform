/**
 * Terraform-style ANSI palette and small helpers used across plan output
 * (stdout) and error messages (stderr).
 *
 *   green  — create / additions
 *   yellow — update / warnings / notes
 *   red    — destroy / delete / errors
 *   dim    — secondary info (reasons, collapsed context)
 *   bold   — label emphasis (`WARN:`, `error:`, etc.)
 *
 * Colors are gated by `process.stdout.isTTY` / `process.stderr.isTTY` so that
 * piped or redirected output stays clean of escape sequences.
 */
export const ANSI = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
} as const;

export type AnsiCode = keyof typeof ANSI;

function wrap(codes: AnsiCode[], text: string): string {
  return codes.map(c => ANSI[c]).join('') + text + ANSI.reset;
}

// ---------------- stdout (plan output) ----------------

export function colorize(code: AnsiCode, text: string): string {
  if (!process.stdout.isTTY) return text;
  return wrap([code], text);
}

export function colorizeMany(codes: AnsiCode[], text: string): string {
  if (!process.stdout.isTTY) return text;
  return wrap(codes, text);
}

// ---------------- stderr (error messages) ----------------

function styleErr(codes: AnsiCode[], text: string): string {
  if (!process.stderr.isTTY) return text;
  return wrap(codes, text);
}

/**
 * Format the headline of an error message destined for stderr.
 * Renders `error: <message>` with a bold-red label and red body.
 */
export function formatErrorHeadline(message: string): string {
  return styleErr(['bold', 'red'], 'error:') + ' ' + styleErr(['red'], message);
}

/**
 * Format an indented detail / bullet line under an error headline.
 */
export function formatErrorDetail(text: string): string {
  return styleErr(['red'], text);
}
