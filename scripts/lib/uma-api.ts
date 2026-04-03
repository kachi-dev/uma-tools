/**
 * Helpers for the uma.moe version API.
 */

export const UMA_MOE_VERSION_URL = 'https://uma.moe/api/ver';
const UMA_MOE_REQUEST_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'uma-tools-data-sync/1.0',
};
const MAX_FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

export interface GameVersionApiRecord {
  app_version: string;
  resource_version: string;
  updated_at: string;
}

export interface UmaApiResponse {
  current: GameVersionApiRecord;
  history: Array<GameVersionApiRecord>;
}

function isGameVersionRecord(value: unknown): value is GameVersionApiRecord {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).app_version === 'string' &&
      typeof (value as Record<string, unknown>).resource_version === 'string' &&
      typeof (value as Record<string, unknown>).updated_at === 'string',
  );
}

function isUmaApiResponse(value: unknown): value is UmaApiResponse {
  return Boolean(
    value &&
      typeof value === 'object' &&
      isGameVersionRecord((value as Record<string, unknown>).current) &&
      Array.isArray((value as Record<string, unknown>).history) &&
      ((value as Record<string, unknown>).history as Array<unknown>).every(isGameVersionRecord),
  );
}

function formatErrorWithCause(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) {
      return `${error.message} (cause: ${cause.message})`;
    }
    if (cause) {
      return `${error.message} (cause: ${String(cause)})`;
    }
    return error.message;
  }

  return String(error);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchCurrentResourceVersion(): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(UMA_MOE_VERSION_URL, {
        headers: UMA_MOE_REQUEST_HEADERS,
      });

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${response.statusText} while fetching latest version from ${UMA_MOE_VERSION_URL}`,
        );
      }

      const payload = (await response.json()) as unknown;
      if (!isUmaApiResponse(payload)) {
        throw new Error(`Unexpected response shape from ${UMA_MOE_VERSION_URL}`);
      }

      return payload.current.resource_version;
    } catch (error) {
      lastError = error;

      if (attempt < MAX_FETCH_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw new Error(
    `Failed to fetch current resource version after ${MAX_FETCH_ATTEMPTS} attempts: ${formatErrorWithCause(lastError)}`,
  );
}

export async function resolveResourceVersion(explicitVersion?: string): Promise<string> {
  if (explicitVersion && explicitVersion.trim().length > 0) {
    return explicitVersion.trim();
  }

  return fetchCurrentResourceVersion();
}
