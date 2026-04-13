import { ProviderAPIConfig } from '../types';

const AnthropicAPIConfig: ProviderAPIConfig = {
  getBaseURL: () => 'https://api.anthropic.com/v1',

  headers: ({ c, providerOptions, fn, gatewayRequestBody }) => {
    const apiKey =
      providerOptions.apiKey || providerOptions.anthropicApiKey || '';
    const headers: Record<string, string> = {};

    // UAG: OAuth token 使用 Bearer 认证，API Key 使用 X-API-Key 认证
    const isOAuth = providerOptions.authType === 'oauth_token';
    if (isOAuth) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
      headers['X-API-Key'] = apiKey;
    }

    // UAG: 允许客户端请求头直接透传 anthropic-beta；OAuth 场景默认值切换为 oauth-2025-04-20
    // 优先级: providerOptions.anthropicBeta > 客户端请求头 > body.anthropic_beta > authType 默认值
    // Normalize empty-string to undefined so `??` falls through (a header sent as `anthropic-beta:` must not propagate as "")
    const rawClientBeta = c?.req?.header?.('anthropic-beta');
    const clientBeta =
      rawClientBeta && rawClientBeta.length > 0 ? rawClientBeta : undefined;
    const defaultBeta = isOAuth ? 'oauth-2025-04-20' : 'messages-2023-12-15';

    // Accept anthropic_beta and anthropic_version in body to support enviroments which cannot send it in headers.
    const betaHeader =
      providerOptions?.['anthropicBeta'] ??
      clientBeta ??
      gatewayRequestBody?.['anthropic_beta'] ??
      defaultBeta;
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
