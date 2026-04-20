/**
 * Provider tools parameter support guard test.
 *
 * Ensures mainstream providers that are known to support function-calling / tools
 * in their real API have the necessary config wiring in the gateway.
 *
 * Background: the gateway uses a whitelist-based parameter filter — any param NOT
 * declared in ProviderConfig is silently dropped. This test catches regressions and
 * missing declarations for providers whose API actually supports tools.
 */

// Mock env utilities that use top-level await (incompatible with Jest CJS mode)
jest.mock('../utils/env', () => ({
  Environment: () => ({}),
  getRuntimeKey: () => 'node',
}));

// ── Direct config imports ───────────────────────────────────────────────────
import { OpenAIChatCompleteConfig } from '../providers/openai/chatComplete';
import { AnthropicChatCompleteConfig } from '../providers/anthropic/chatComplete';
import { AzureOpenAIChatCompleteConfig } from '../providers/azure-openai/chatComplete';
import { BedrockConverseChatCompleteConfig } from '../providers/bedrock/chatComplete';
import { GoogleChatCompleteConfig } from '../providers/google/chatComplete';
import { VertexGoogleChatCompleteConfig } from '../providers/google-vertex-ai/chatComplete';
import { CohereChatCompleteConfig } from '../providers/cohere/chatComplete';
import { MistralAIChatCompleteConfig } from '../providers/mistral-ai/chatComplete';
import { FireworksAIChatCompleteConfig } from '../providers/fireworks-ai/chatComplete';
import { TogetherAIChatCompleteConfig } from '../providers/together-ai/chatComplete';
import { OpenrouterChatCompleteConfig } from '../providers/openrouter/chatComplete';
import { NovitaAIChatCompleteConfig } from '../providers/novita-ai/chatComplete';
import { DeepbricksChatCompleteConfig } from '../providers/deepbricks/chatComplete';
import { DeepSeekChatCompleteConfig } from '../providers/deepseek/chatComplete';
import { ZhipuChatCompleteConfig } from '../providers/zhipu/chatComplete';
import { MoonshotChatCompleteConfig } from '../providers/moonshot/chatComplete';
import { SiliconFlowChatCompleteConfig } from '../providers/siliconflow/chatComplete';
import { OllamaChatCompleteConfig } from '../providers/ollama/chatComplete';

// ── Index imports (providers using open-ai-base chatCompleteParams) ─────────
import GroqConfig from '../providers/groq';
import XAIConfig from '../providers/x-ai';
import { DashScopeConfig } from '../providers/dashscope';

// ─── Provider list ──────────────────────────────────────────────────────────
// When onboarding a new provider that supports tools, add it here.

interface ProviderToolsSpec {
  label: string;
  config: Record<string, any>;
  requireToolChoice?: boolean; // default true; set false if upstream lacks tool_choice
}

const PROVIDERS_REQUIRING_TOOLS: ProviderToolsSpec[] = [
  // ── International ──
  { label: 'OpenAI', config: OpenAIChatCompleteConfig },
  { label: 'Anthropic', config: AnthropicChatCompleteConfig },
  { label: 'Azure OpenAI', config: AzureOpenAIChatCompleteConfig },
  {
    label: 'AWS Bedrock (Converse)',
    config: BedrockConverseChatCompleteConfig,
    requireToolChoice: false,
  },
  { label: 'Google Gemini', config: GoogleChatCompleteConfig },
  { label: 'Google Vertex AI', config: VertexGoogleChatCompleteConfig },
  { label: 'Cohere', config: CohereChatCompleteConfig },
  { label: 'Mistral AI', config: MistralAIChatCompleteConfig },
  { label: 'Groq', config: GroqConfig.chatComplete },
  {
    label: 'Fireworks AI',
    config: FireworksAIChatCompleteConfig,
    requireToolChoice: false,
  },
  { label: 'Together AI', config: TogetherAIChatCompleteConfig },
  { label: 'OpenRouter', config: OpenrouterChatCompleteConfig },
  { label: 'xAI (Grok)', config: XAIConfig.chatComplete },
  { label: 'Novita AI', config: NovitaAIChatCompleteConfig },
  { label: 'Deepbricks', config: DeepbricksChatCompleteConfig },
  {
    label: 'Ollama',
    config: OllamaChatCompleteConfig,
    requireToolChoice: false,
  },

  // ── 国内 ──
  { label: 'DeepSeek', config: DeepSeekChatCompleteConfig },
  { label: '智谱 (Zhipu)', config: ZhipuChatCompleteConfig },
  { label: 'Moonshot (Kimi)', config: MoonshotChatCompleteConfig },
  { label: 'SiliconFlow', config: SiliconFlowChatCompleteConfig },
  { label: '阿里 DashScope', config: DashScopeConfig.chatComplete },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function configHasParam(
  config: Record<string, any>,
  paramName: string
): boolean {
  if (!config) return false;
  for (const key of Object.keys(config)) {
    const entry = config[key];
    if (!entry) continue;
    const entries = Array.isArray(entry) ? entry : [entry];
    for (const e of entries) {
      if (e.param === paramName || key === paramName) return true;
    }
  }
  return false;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Provider tools parameter support guard', () => {
  describe.each(PROVIDERS_REQUIRING_TOOLS)(
    '$label',
    ({ config, requireToolChoice }) => {
      it('declares "tools" parameter in ChatCompleteConfig', () => {
        expect(configHasParam(config, 'tools')).toBe(true);
      });

      if (requireToolChoice !== false) {
        it('declares "tool_choice" parameter in ChatCompleteConfig', () => {
          expect(configHasParam(config, 'tool_choice')).toBe(true);
        });
      }
    }
  );
});
