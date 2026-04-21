/**
 * Tests for normalizeToolParameters — ensures tool parameter schemas are
 * always valid JSON Schema for strict providers like DeepSeek.
 */

jest.mock('../utils/env', () => ({
  Environment: () => ({}),
  getRuntimeKey: () => 'node',
}));

import { normalizeToolParameters } from '../providers/utils';

describe('normalizeToolParameters', () => {
  it('normalizes empty parameters {} to { type: "object", properties: {} }', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'getCurrentDate',
          description: 'Get date',
          parameters: {},
        },
      },
    ];
    const result = normalizeToolParameters(tools);
    expect(result![0].function.parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('adds missing properties field when type is present', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'fn',
          description: 'd',
          parameters: { type: 'object' },
        },
      },
    ];
    const result = normalizeToolParameters(tools);
    expect(result![0].function.parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('preserves a complete schema unchanged', () => {
    const schema = {
      type: 'object',
      properties: { date: { type: 'string' } },
      required: ['date'],
    };
    const tools = [
      {
        type: 'function',
        function: { name: 'fn', description: 'd', parameters: { ...schema } },
      },
    ];
    const result = normalizeToolParameters(tools);
    expect(result![0].function.parameters).toEqual(schema);
  });

  it('fixes required field when it is {} instead of array', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'fn',
          description: 'd',
          parameters: { type: 'object', properties: {}, required: {} },
        },
      },
    ];
    const result = normalizeToolParameters(tools);
    expect(result![0].function.parameters.required).toEqual([]);
  });

  it('normalizes null/undefined parameters to default schema', () => {
    const tools = [
      {
        type: 'function',
        function: { name: 'fn', description: 'd', parameters: null },
      },
      {
        type: 'function',
        function: { name: 'fn2', description: 'd2', parameters: undefined },
      },
    ];
    const result = normalizeToolParameters(tools);
    expect(result![0].function.parameters).toEqual({
      type: 'object',
      properties: {},
    });
    expect(result![1].function.parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('normalizes Anthropic-format tools with input_schema', () => {
    const tools = [{ name: 'fn', description: 'd', input_schema: {} }];
    const result = normalizeToolParameters(tools);
    expect(result![0].input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('normalizes Anthropic-format tools missing input_schema entirely', () => {
    const tools = [{ name: 'fn', description: 'd' }];
    const result = normalizeToolParameters(tools);
    expect(result![0].input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('does not mutate the original schema object', () => {
    const original = { type: 'object' };
    const tools = [
      {
        type: 'function',
        function: { name: 'fn', description: 'd', parameters: original },
      },
    ];
    normalizeToolParameters(tools);
    expect(original).toEqual({ type: 'object' });
  });

  it('returns undefined for non-array input', () => {
    expect(normalizeToolParameters(undefined)).toBeUndefined();
    expect(normalizeToolParameters(null)).toBeUndefined();
  });
});
