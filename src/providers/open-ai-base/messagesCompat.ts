/**
 * Anthropic Messages API → OpenAI Chat Completions cross-format compatibility.
 *
 * Allows OpenAI-compatible providers (OpenAI, DeepSeek, etc.) to accept
 * requests arriving via the /v1/messages (Anthropic) endpoint by transforming
 * the request to chat completions format and converting the response back
 * to the Anthropic Messages format.
 */
import {
  ANTHROPIC_CONTENT_BLOCK_START_EVENT,
  ANTHROPIC_CONTENT_BLOCK_STOP_EVENT,
  ANTHROPIC_MESSAGE_DELTA_EVENT,
  ANTHROPIC_MESSAGE_START_EVENT,
  ANTHROPIC_MESSAGE_STOP_EVENT,
} from '../anthropic-base/constants';
import {
  AnthropicMessageDeltaEvent,
  AnthropicMessageStartEvent,
} from '../anthropic-base/types';
import {
  ContentBlock,
  MessagesResponse,
  ANTHROPIC_STOP_REASON,
  Usage,
} from '../../types/messagesResponse';
import {
  RawContentBlockDeltaEvent,
  RawContentBlockStartEvent,
  RawContentBlockStopEvent,
} from '../../types/MessagesStreamResponse';
import { Params } from '../../types/requestBody';
import { ErrorResponse, ProviderConfig } from '../types';
import { OpenAIErrorResponseTransform } from '../openai/utils';
import { generateInvalidProviderResponseError } from '../utils';

// ---------------------------------------------------------------------------
// Request transformation helpers
// ---------------------------------------------------------------------------

/**
 * Convert Anthropic message content blocks to OpenAI format.
 * Also handles assistant messages with tool_use blocks → tool_calls.
 */
function transformAnthropicMessages(params: any): any[] {
  const messages: any[] = [];

  // Promote top-level `system` to a system message
  if (params.system) {
    if (typeof params.system === 'string') {
      messages.push({ role: 'system', content: params.system });
    } else if (Array.isArray(params.system)) {
      // Anthropic system can be an array of content blocks
      const text = params.system
        .map((b: any) => b.text ?? '')
        .filter(Boolean)
        .join('\n');
      if (text) messages.push({ role: 'system', content: text });
    }
  }

  for (const msg of params.messages ?? []) {
    if (msg.role === 'assistant') {
      messages.push(transformAssistantMessage(msg));
    } else if (msg.role === 'user') {
      // User messages may contain tool_result blocks
      const toolResults = extractToolResults(msg);
      if (toolResults.length > 0) {
        // Push each tool_result as a separate role:tool message
        for (const tr of toolResults) {
          messages.push(tr);
        }
        // Also push any remaining non-tool-result content as a user message
        const remaining = extractNonToolContent(msg);
        if (remaining) {
          messages.push({ role: 'user', content: remaining });
        }
      } else {
        messages.push({ role: 'user', content: flattenContent(msg.content) });
      }
    } else {
      // Pass through other roles (e.g. system in messages array)
      messages.push({ role: msg.role, content: flattenContent(msg.content) });
    }
  }

  return messages;
}

function transformAssistantMessage(msg: any): any {
  if (!Array.isArray(msg.content)) {
    return { role: 'assistant', content: msg.content ?? '' };
  }

  const toolCalls: any[] = [];
  const textParts: string[] = [];

  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments:
            typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input ?? {}),
        },
      });
    } else if (block.type === 'text') {
      textParts.push(block.text);
    }
    // Silently drop thinking, redacted_thinking, etc.
  }

  const result: any = { role: 'assistant' };
  result.content = textParts.join('') || null;
  if (toolCalls.length > 0) {
    result.tool_calls = toolCalls;
  }
  return result;
}

function extractToolResults(msg: any): any[] {
  if (!Array.isArray(msg.content)) return [];
  const results: any[] = [];
  for (const block of msg.content) {
    if (block.type === 'tool_result') {
      let content = '';
      if (typeof block.content === 'string') {
        content = block.content;
      } else if (Array.isArray(block.content)) {
        content = block.content
          .map((b: any) => b.text ?? '')
          .filter(Boolean)
          .join('\n');
      }
      results.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content,
      });
    }
  }
  return results;
}

function extractNonToolContent(msg: any): string | null {
  if (!Array.isArray(msg.content)) return null;
  const parts = msg.content
    .filter((b: any) => b.type !== 'tool_result')
    .map((b: any) => {
      if (b.type === 'text') return b.text;
      if (typeof b === 'string') return b;
      return '';
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

/** Flatten Anthropic content (string or block array) to OpenAI string. */
function flattenContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (b.type === 'text') return b.text;
        if (typeof b === 'string') return b;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Convert Anthropic tools definition to OpenAI format.
 * Anthropic: { name, description, input_schema }
 * OpenAI:    { type: "function", function: { name, description, parameters } }
 */
function transformTools(params: any): any[] | undefined {
  if (!params.tools || !Array.isArray(params.tools)) return undefined;
  return params.tools.map((tool: any) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

/**
 * Convert Anthropic tool_choice to OpenAI format.
 * Anthropic: { type: "auto" } | { type: "any" } | { type: "tool", name: "X" }
 * OpenAI:    "auto" | "required" | { type: "function", function: { name: "X" } }
 */
function transformToolChoice(params: any): any {
  const tc = params.tool_choice;
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc; // pass-through if already simple
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && tc.name) {
    return { type: 'function', function: { name: tc.name } };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Request config (Anthropic Messages params → OpenAI Chat Completions params)
// ---------------------------------------------------------------------------

export const OpenAICompatMessagesConfig: ProviderConfig = {
  model: {
    param: 'model',
    required: true,
  },
  messages: {
    param: 'messages',
    required: true,
    transform: (params: any) => transformAnthropicMessages(params),
  },
  max_tokens: {
    param: 'max_tokens',
    required: true,
  },
  temperature: {
    param: 'temperature',
  },
  top_p: {
    param: 'top_p',
  },
  stream: {
    param: 'stream',
  },
  stop_sequences: {
    param: 'stop',
  },
  tools: {
    param: 'tools',
    transform: (params: any) => transformTools(params),
  },
  tool_choice: {
    param: 'tool_choice',
    transform: (params: any) => transformToolChoice(params),
  },
  // Fields below are silently dropped (not mapped to any output param)
  // by not being included here: top_k, metadata, thinking, container,
  // mcp_servers, service_tier
};

// ---------------------------------------------------------------------------
// Non-streaming response transformation
// ---------------------------------------------------------------------------

/** Map OpenAI finish_reason to Anthropic stop_reason. */
function mapStopReason(
  finishReason: string | null | undefined
): ANTHROPIC_STOP_REASON {
  switch (finishReason) {
    case 'stop':
      return ANTHROPIC_STOP_REASON.end_turn;
    case 'length':
      return ANTHROPIC_STOP_REASON.max_tokens;
    case 'tool_calls':
      return ANTHROPIC_STOP_REASON.tool_use;
    case 'content_filter':
      return ANTHROPIC_STOP_REASON.end_turn;
    default:
      return ANTHROPIC_STOP_REASON.end_turn;
  }
}

/** Build Anthropic content blocks from OpenAI choice message. */
function buildContentBlocks(message: any): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // Text content
  if (message.content) {
    blocks.push({ type: 'text', text: message.content });
  }

  // Tool calls
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input: unknown = {};
      try {
        input =
          typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
      } catch {
        input = tc.function.arguments;
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  // Ensure at least one block
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' });
  }

  return blocks;
}

export function openaiToAnthropicMessagesResponse(
  provider: string
): (
  response: any,
  responseStatus: number,
  responseHeaders: Headers,
  strictOpenAiCompliance: boolean,
  gatewayRequestUrl: string,
  gatewayRequest: Params
) => MessagesResponse | ErrorResponse {
  return (
    response,
    responseStatus,
    _responseHeaders,
    _strictOpenAiCompliance,
    _gatewayRequestUrl,
    gatewayRequest
  ) => {
    if (responseStatus !== 200 && 'error' in response) {
      return OpenAIErrorResponseTransform(response, provider);
    }

    if ('choices' in response && response.choices?.length > 0) {
      const choice = response.choices[0];
      const usage: Usage = {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      };

      return {
        id: response.id ?? 'portkey-' + crypto.randomUUID(),
        type: 'message',
        role: 'assistant',
        model: response.model ?? (gatewayRequest.model as string) ?? '',
        content: buildContentBlocks(choice.message),
        stop_reason: mapStopReason(choice.finish_reason),
        stop_sequence: null,
        usage,
      };
    }

    return generateInvalidProviderResponseError(response, provider);
  };
}

// ---------------------------------------------------------------------------
// Streaming response transformation
// ---------------------------------------------------------------------------

interface OpenAICompatStreamState {
  messageStartSent?: boolean;
  contentBlockStartSent?: boolean;
  endEventsSent?: boolean;
  contentBlockIndex: number;
  toolCallStates?: Record<
    number,
    { id: string; name: string; arguments: string }
  >;
  finishReason?: string | null;
}

export function openaiStreamToAnthropicMessagesStream(
  provider: string
): (
  responseChunk: string,
  fallbackId: string,
  streamState: Record<string, any>,
  strictOpenAiCompliance: boolean,
  gatewayRequest: Params
) => string | string[] {
  return (
    responseChunk,
    fallbackId,
    streamState: Record<string, any>,
    _strictOpenAiCompliance,
    gatewayRequest
  ) => {
    let chunk = responseChunk.trim();
    chunk = chunk.replace(/^data: /, '');
    chunk = chunk.trim();

    if (chunk === '[DONE]') {
      return '';
    }

    let parsedChunk: any;
    try {
      parsedChunk = JSON.parse(chunk);
    } catch {
      return '';
    }

    // Initialize stream state
    const state = streamState as unknown as OpenAICompatStreamState;
    if (state.contentBlockIndex === undefined) {
      state.contentBlockIndex = -1;
      state.toolCallStates = {};
    }

    const events: string[] = [];
    const choice = parsedChunk.choices?.[0];
    if (!choice) {
      // usage-only chunk at end (OpenAI with stream_options.include_usage)
      if (parsedChunk.usage && state.messageStartSent && !state.endEventsSent) {
        state.endEventsSent = true;
        events.push(...buildEndEvents(state, parsedChunk.usage));
      }
      return events.join('');
    }

    const delta = choice.delta ?? {};

    // 1) message_start (once, on first chunk)
    if (!state.messageStartSent) {
      state.messageStartSent = true;
      const startEvt: AnthropicMessageStartEvent = JSON.parse(
        ANTHROPIC_MESSAGE_START_EVENT
      );
      startEvt.message.id = parsedChunk.id || fallbackId;
      startEvt.message.model =
        parsedChunk.model || (gatewayRequest.model as string) || '';
      events.push(
        `event: message_start\ndata: ${JSON.stringify(startEvt)}\n\n`
      );
    }

    // 2) Text content delta
    if (delta.content != null && delta.content !== '') {
      if (!state.contentBlockStartSent) {
        state.contentBlockStartSent = true;
        state.contentBlockIndex = 0;
        const blockStart: RawContentBlockStartEvent = JSON.parse(
          ANTHROPIC_CONTENT_BLOCK_START_EVENT
        );
        blockStart.index = 0;
        blockStart.content_block = { type: 'text', text: '' };
        events.push(
          `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`
        );
      }

      const blockDelta: RawContentBlockDeltaEvent = {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: delta.content },
      };
      events.push(
        `event: content_block_delta\ndata: ${JSON.stringify(blockDelta)}\n\n`
      );
    }

    // 3) Tool call deltas
    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index ?? 0;
        if (!state.toolCallStates![tcIndex]) {
          // New tool call — close previous text block if open
          if (
            state.contentBlockStartSent &&
            state.contentBlockIndex < tcIndex + 1
          ) {
            const stopEvt: RawContentBlockStopEvent = JSON.parse(
              ANTHROPIC_CONTENT_BLOCK_STOP_EVENT
            );
            stopEvt.index = state.contentBlockIndex;
            events.push(
              `event: content_block_stop\ndata: ${JSON.stringify(stopEvt)}\n\n`
            );
          }

          state.toolCallStates![tcIndex] = {
            id: tc.id || '',
            name: tc.function?.name || '',
            arguments: '',
          };
          state.contentBlockIndex =
            (state.contentBlockStartSent ? 1 : 0) + tcIndex;

          const blockStart: RawContentBlockStartEvent = JSON.parse(
            ANTHROPIC_CONTENT_BLOCK_START_EVENT
          );
          blockStart.index = state.contentBlockIndex;
          blockStart.content_block = {
            type: 'tool_use',
            id: state.toolCallStates![tcIndex].id,
            name: state.toolCallStates![tcIndex].name,
            input: {},
          };
          events.push(
            `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`
          );
        }

        // Accumulate function name/id only on subsequent chunks
        // (first chunk already stored these during initialization above)
        else {
          if (tc.function?.name) {
            state.toolCallStates![tcIndex].name += tc.function.name;
          }
          if (tc.id) {
            state.toolCallStates![tcIndex].id = tc.id;
          }
        }

        // Input JSON delta
        if (tc.function?.arguments) {
          state.toolCallStates![tcIndex].arguments += tc.function.arguments;
          const blockDelta: RawContentBlockDeltaEvent = {
            type: 'content_block_delta',
            index: (state.contentBlockStartSent ? 1 : 0) + tcIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: tc.function.arguments,
            },
          };
          events.push(
            `event: content_block_delta\ndata: ${JSON.stringify(blockDelta)}\n\n`
          );
        }
      }
    }

    // 4) Finish — emit closing events
    if (choice.finish_reason && !state.endEventsSent) {
      state.finishReason = choice.finish_reason;
      state.endEventsSent = true;
      events.push(...buildEndEvents(state, parsedChunk.usage ?? undefined));
    }

    return events.join('');
  };
}

function buildEndEvents(state: OpenAICompatStreamState, usage?: any): string[] {
  const events: string[] = [];

  // Close last open content block
  if (state.contentBlockIndex >= 0) {
    const stopEvt: RawContentBlockStopEvent = JSON.parse(
      ANTHROPIC_CONTENT_BLOCK_STOP_EVENT
    );
    stopEvt.index = state.contentBlockIndex;
    events.push(
      `event: content_block_stop\ndata: ${JSON.stringify(stopEvt)}\n\n`
    );
  }

  // message_delta with stop_reason and usage
  const deltaEvt: AnthropicMessageDeltaEvent = JSON.parse(
    ANTHROPIC_MESSAGE_DELTA_EVENT
  );
  deltaEvt.delta.stop_reason =
    mapStopReason(state.finishReason) ?? ANTHROPIC_STOP_REASON.end_turn;
  if (usage) {
    deltaEvt.usage.input_tokens = usage.prompt_tokens ?? 0;
    deltaEvt.usage.output_tokens = usage.completion_tokens ?? 0;
  }
  events.push(`event: message_delta\ndata: ${JSON.stringify(deltaEvt)}\n\n`);

  // message_stop
  events.push(
    `event: message_stop\ndata: ${JSON.stringify(ANTHROPIC_MESSAGE_STOP_EVENT)}\n\n`
  );

  return events;
}
