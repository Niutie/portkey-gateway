import { ProviderAPIConfig } from '../types';

const AnthropicAPIConfig: ProviderAPIConfig = {
  getBaseURL: () => 'https://api.anthropic.com/v1',

  headers: ({ providerOptions, fn, gatewayRequestBody }) => {
    const apiKey =
      providerOptions.apiKey || providerOptions.anthropicApiKey || '';
    const headers: Record<string, string> = {};

    // UAG: OAuth token 使用 Bearer 认证，API Key 使用 X-API-Key 认证
    if (providerOptions.authType === 'oauth_token') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
      headers['X-API-Key'] = apiKey;
    }

    // Accept anthropic_beta and anthropic_version in body to support enviroments which cannot send it in headers.
    const betaHeader =
      providerOptions?.['anthropicBeta'] ??
      gatewayRequestBody?.['anthropic_beta'] ??
      'messages-2023-12-15';
    const version =
      providerOptions?.['anthropicVersion'] ??
      gatewayRequestBody?.['anthropic_version'] ??
      '2023-06-01';

    headers['anthropic-beta'] = betaHeader;
    headers['anthropic-version'] = version;
    return headers;
  },
  getEndpoint: ({ fn }) => {
    switch (fn) {
      case 'complete':
        return '/complete';
      case 'chatComplete':
        return '/messages';
      case 'messages':
        return '/messages';
      case 'messagesCountTokens':
        return '/messages/count_tokens';
      default:
        return '';
    }
  },
};

export default AnthropicAPIConfig;
