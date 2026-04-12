import { Context } from 'hono';

const inMemoryCache: any = {};

const CACHE_STATUS = {
  HIT: 'HIT',
  SEMANTIC_HIT: 'SEMANTIC HIT',
  MISS: 'MISS',
  SEMANTIC_MISS: 'SEMANTIC MISS',
  REFRESH: 'REFRESH',
  DISABLED: 'DISABLED',
};

const getCacheKey = async (
  requestBody: any,
  url: string,
  namespace?: string
) => {
  const namespacePart = namespace ? `-ns:${namespace}` : '';
  const stringToHash = `${JSON.stringify(requestBody)}-${url}${namespacePart}`;
  const myText = new TextEncoder().encode(stringToHash);
  let cacheDigest = await crypto.subtle.digest(
    {
      name: 'SHA-256',
    },
    myText
  );
  return Array.from(new Uint8Array(cacheDigest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

// Cache Handling
export const getFromCache = async (
  env: any,
  requestHeaders: any,
  requestBody: any,
  url: string,
  organisationId: string,
  cacheMode: string,
  cacheMaxAge: number | null,
  namespace?: string
) => {
  if ('x-portkey-cache-force-refresh' in requestHeaders) {
    return [null, CACHE_STATUS.REFRESH, null];
  }
  try {
    const cacheKey = await getCacheKey(requestBody, url, namespace);

    if (cacheKey in inMemoryCache) {
      const cacheObject = inMemoryCache[cacheKey];
      if (cacheObject.maxAge && cacheObject.maxAge < Date.now()) {
        delete inMemoryCache[cacheKey];
        return [null, CACHE_STATUS.MISS, null];
      }
      return [cacheObject.responseBody, CACHE_STATUS.HIT, cacheKey];
    } else {
      return [null, CACHE_STATUS.MISS, null];
    }
  } catch (error) {
    console.error('getFromCache error: ', error);
    return [null, CACHE_STATUS.MISS, null];
  }
};

export const putInCache = async (
  env: any,
  requestHeaders: any,
  requestBody: any,
  responseBody: any,
  url: string,
  organisationId: string,
  cacheMode: string | null,
  cacheMaxAge: number | null,
  namespace?: string
) => {
  if (requestBody.stream) {
    // Does not support caching of streams
    return;
  }

  const cacheKey = await getCacheKey(requestBody, url, namespace);

  inMemoryCache[cacheKey] = {
    responseBody: JSON.stringify(responseBody),
    maxAge: cacheMaxAge,
  };
};

export const memoryCache = () => {
  return async (c: Context, next: any) => {
    const requestHeaders = c.req.header() || {};
    const namespace = requestHeaders['x-portkey-cache-namespace'] || undefined;

    // Wrap getFromCache to automatically pass namespace
    const getFromCacheWithNamespace = (
      env: any,
      reqHeaders: any,
      requestBody: any,
      url: string,
      organisationId: string,
      cacheMode: string,
      cacheMaxAge: number | null
    ) =>
      getFromCache(
        env,
        reqHeaders,
        requestBody,
        url,
        organisationId,
        cacheMode,
        cacheMaxAge,
        namespace
      );

    c.set('getFromCache', getFromCacheWithNamespace);

    await next();

    const allRequestOptions = c.get('requestOptions');

    if (
      allRequestOptions &&
      Array.isArray(allRequestOptions) &&
      allRequestOptions.length > 0 &&
      !allRequestOptions[0].requestParams.stream
    ) {
      // Find the last successful (2xx) attempt — fallback/retry may have
      // failed on earlier providers before reaching a healthy one.
      const successfulOption = allRequestOptions
        .slice()
        .reverse()
        .find(
          (opt: any) =>
            opt.response?.status >= 200 && opt.response?.status < 300
        );
      if (successfulOption && successfulOption.cacheMode === 'simple') {
        await putInCache(
          null,
          null,
          successfulOption.transformedRequest.body,
          await successfulOption.response.clone().json(),
          successfulOption.providerOptions.rubeusURL,
          '',
          null,
          new Date().getTime() +
            (successfulOption.cacheMaxAge
              ? successfulOption.cacheMaxAge * 1000
              : 24 * 60 * 60 * 1000),
          namespace
        );
      }
    }
  };
};
