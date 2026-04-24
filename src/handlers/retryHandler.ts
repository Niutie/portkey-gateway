import retry from 'async-retry';
import { MAX_RETRY_LIMIT_MS, POSSIBLE_RETRY_STATUS_HEADERS } from '../globals';

/**
 * A single entry in the router attempt log, tracking one retry attempt.
 */
export interface RouterAttemptEntry {
  provider: string;
  provider_type?: string;
  status: number;
  ok: boolean;
  duration_ms: number;
  is_retry: boolean;
  is_fallback: boolean;
  status_text?: string;
}

/**
 * The full attempt log structure serialized into x-router-attempt-log.
 */
export interface RouterAttemptLog {
  total: number;
  attempts: (RouterAttemptEntry | { _skip: number })[];
}

/**
 * Truncates attempt entries when > 10: keeps first 1 + skip marker + last 3.
 */
export function truncateAttemptLog(
  entries: RouterAttemptEntry[]
): (RouterAttemptEntry | { _skip: number })[] {
  if (entries.length <= 10) {
    return entries;
  }
  const skipped = entries.length - 4; // total - first 1 - last 3
  return [entries[0], { _skip: skipped }, ...entries.slice(-3)];
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number,
  requestHandler?: () => Promise<Response>
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const timeoutRequestOptions = {
    ...options,
    signal: controller.signal,
  };

  let response;

  try {
    if (requestHandler) {
      response = await requestHandler();
    } else {
      response = await fetch(url, timeoutRequestOptions);
    }
    clearTimeout(timeoutId);
  } catch (err: any) {
    if (err.name === 'AbortError') {
      response = new Response(
        JSON.stringify({
          error: {
            message: `Request exceeded the timeout sent in the request: ${timeout}ms`,
            type: 'timeout_error',
            param: null,
            code: null,
          },
        }),
        {
          headers: {
            'content-type': 'application/json',
          },
          status: 408,
        }
      );
    } else {
      throw err;
    }
  }

  return response;
}

/**
 * Tries making a fetch request a specified number of times until it succeeds.
 * If the response's status code is included in the statusCodesToRetry array,
 * the request is retried.
 *
 * @param {string} url - The URL to which the request is made.
 * @param {RequestInit} options - The options for the request, such as method, headers, and body.
 * @param {number} retryCount - The maximum number of times to retry the request.
 * @param {number[]} statusCodesToRetry - The HTTP status codes that should trigger a retry.
 * @returns {Promise<[Response, number | undefined]>} - The response from the request and the number of attempts it took to get a successful response.
 *                                                     If all attempts fail, the error message and status code are returned as a Response object, and the number of attempts is undefined.
 * @throws Will throw an error if the request fails after all retry attempts, with the error message and status code in the thrown error.
 */
export const retryRequest = async (
  url: string,
  options: RequestInit,
  retryCount: number,
  statusCodesToRetry: number[],
  timeout: number | null,
  requestHandler?: () => Promise<Response>,
  followProviderRetry?: boolean,
  provider?: string
): Promise<{
  response: Response;
  attempt: number | undefined;
  createdAt: Date;
  skip: boolean;
}> => {
  let lastResponse: Response | undefined;
  let lastAttempt: number | undefined;
  const start = new Date();
  let retrySkipped = false;
  const attemptEntries: RouterAttemptEntry[] = [];
  const providerName = provider ?? 'unknown';

  let remainingRetryTimeout = MAX_RETRY_LIMIT_MS;

  try {
    await retry(
      async (bail: any, attempt: number, rateLimiter: any) => {
        const attemptStart = Date.now();
        try {
          let response: Response;
          if (timeout) {
            response = await fetchWithTimeout(
              url,
              options,
              timeout,
              requestHandler
            );
          } else if (requestHandler) {
            response = await requestHandler();
          } else {
            response = await fetch(url, options);
          }
          if (statusCodesToRetry.includes(response.status)) {
            const errorObj: any = new Error(await response.text());
            errorObj.status = response.status;
            errorObj.statusText = response.statusText;
            errorObj.headers = Object.fromEntries(response.headers);
            errorObj._attemptStart = attemptStart;

            if (response.status === 429 && followProviderRetry) {
              // get retry header.
              const retryHeader = POSSIBLE_RETRY_STATUS_HEADERS.find(
                (header) => {
                  return response.headers.get(header);
                }
              );
              const retryAfterValue = response.headers.get(retryHeader ?? '');
              // continue, if no retry header is found.
              if (!retryAfterValue) {
                throw errorObj;
              }
              let retryAfter: number | undefined;
              // if the header is `retry-after` convert it to milliseconds.
              if (retryHeader === 'retry-after') {
                retryAfter = Number.parseInt(retryAfterValue.trim()) * 1000;
              } else {
                retryAfter = Number.parseInt(retryAfterValue.trim());
              }

              if (retryAfter && !Number.isNaN(retryAfter)) {
                // break the loop if the retryAfter is greater than the max retry limit
                if (
                  retryAfter >= MAX_RETRY_LIMIT_MS ||
                  retryAfter > remainingRetryTimeout
                ) {
                  retrySkipped = true;
                  rateLimiter._timeouts = [];
                  throw errorObj;
                }
                remainingRetryTimeout -= retryAfter;
                // will reset the current backoff timeout(s) to `0`.
                rateLimiter._timeouts = Array.from({
                  length: retryCount - attempt + 1,
                }).map(() => 0);

                throw await new Promise((resolve) => {
                  setTimeout(() => {
                    resolve(errorObj);
                  }, retryAfter);
                });
              } else {
                throw errorObj;
              }
            }

            throw errorObj;
          } else if (response.status >= 200 && response.status <= 204) {
            // Record the successful final attempt
            const duration = Date.now() - attemptStart;
            attemptEntries.push({
              provider: providerName,
              status: response.status,
              ok: true,
              duration_ms: duration,
              is_retry: attempt > 1,
              is_fallback: false,
              status_text: response.statusText || undefined,
            });
          } else {
            // All error codes that aren't retried need to be propogated up
            const errorObj: any = new Error(await response.clone().text());
            errorObj.status = response.status;
            errorObj.statusText = response.statusText;
            errorObj.headers = Object.fromEntries(response.headers);
            errorObj._attemptStart = attemptStart;
            bail(errorObj);
            return;
          }
          lastResponse = response;
        } catch (error: any) {
          // Attach attempt start time if not already present
          if (!error._attemptStart) {
            error._attemptStart = attemptStart;
          }
          if (attempt >= retryCount + 1) {
            bail(error);
            return;
          }
          throw error;
        }
      },
      {
        retries: retryCount,
        onRetry: (error: any, attempt: number) => {
          lastAttempt = attempt;
          // Record the failed attempt that triggered this retry
          const duration =
            Date.now() - (error._attemptStart ?? start.getTime());
          attemptEntries.push({
            provider: providerName,
            status: error.status ?? 0,
            ok: false,
            duration_ms: duration,
            is_retry: attempt > 1,
            is_fallback: false,
            status_text: error.statusText || undefined,
          });
        },
        randomize: false,
      }
    );
  } catch (error: any) {
    const failedAttemptStart = error._attemptStart ?? start.getTime();
    if (
      error instanceof TypeError &&
      error.cause instanceof Error &&
      error.cause?.name === 'ConnectTimeoutError'
    ) {
      console.error(
        'retryRequest ConnectTimeoutError error:',
        error.cause,
        error.message
      );
      // This error comes in case the host address is unreachable. Empty status code used to get returned
      // from here hence no retry logic used to get called.
      lastResponse = new Response(error.message, {
        status: 503,
      });
    } else if (!error.status || error instanceof TypeError) {
      console.error('retryRequest error:', error.cause, error.message);
      // The retry handler will always attach status code to the error object
      lastResponse = new Response(
        `Message: ${error.message} Cause: ${error.cause ?? 'NA'} Name: ${error.name}`,
        {
          status: 500,
        }
      );
    } else {
      lastResponse = new Response(error.message, {
        status: error.status,
        headers: error.headers,
      });
    }
    // Record the final failed attempt for bail/exhaustion paths.
    // onRetry only fires BEFORE the next attempt, so the last failed attempt
    // (bail or exhausted retries) is never captured there.
    if (lastResponse) {
      const isRetry = attemptEntries.length > 0;
      attemptEntries.push({
        provider: providerName,
        status: lastResponse.status,
        ok: false,
        duration_ms: Date.now() - failedAttemptStart,
        is_retry: isRetry,
        is_fallback: false,
        status_text: error.statusText || undefined,
      });
    }
  }

  // Inject unified attempt log header into the response
  if (lastResponse && attemptEntries.length > 0) {
    const attemptLog: RouterAttemptLog = {
      total: attemptEntries.length,
      attempts: truncateAttemptLog(attemptEntries),
    };
    const headers = new Headers(lastResponse.headers);
    headers.set('x-router-attempt-log', JSON.stringify(attemptLog));
    lastResponse = new Response(lastResponse.body, {
      status: lastResponse.status,
      statusText: lastResponse.statusText,
      headers,
    });
  }

  return {
    response: lastResponse as Response,
    attempt: lastAttempt,
    createdAt: start,
    skip: retrySkipped,
  };
};
