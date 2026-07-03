/**
 * Safe accessors for unknown catch values. `error` in a catch block can be
 * null/undefined or a non-object; direct casts like `(error as Error).message`
 * throw a TypeError on exactly the failures you're trying to report.
 */

export function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * errorMessage without octokit's trailing " - https://docs.github.com/..."
 * suffix. Splitting on the full " - https://" prefix (not " - ") keeps API
 * messages that themselves contain spaced hyphens intact.
 */
export function apiMessage(error: unknown): string {
  return errorMessage(error).split(' - https://')[0]!;
}
