/**
 * CLI output helpers.
 * Structured data goes to stdout (JSON); human-readable logs go to stderr.
 */

export function toJson(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

export function toStderr(msg) {
  process.stderr.write(msg + '\n');
}
