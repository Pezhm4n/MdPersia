import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeConversion, cancelActiveConversion } from './tauriBridge';
import { DEFAULT_CONVERT_OPTIONS } from './cliTranslator';
import type { ProgressEvent, QueueItem } from '../types';

const item = (id: string): QueueItem => ({ id, name: 'README.md', path: `C:/${id}/README.md`, sizeBytes: 1, sizeStr: '1 B', status: 'pending' });

test('progress identifies files by ID even when basenames match', async (context) => {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('data: {"type":"exit","code":0}\n\n');
  const events: ProgressEvent[] = [];
  await executeConversion([item('one'), item('two')], DEFAULT_CONVERT_OPTIONS, event => events.push(event), () => {});
  assert.deepEqual(events.filter(event => event.type === 'success').map(event => event.itemId), ['one', 'two']);
});

test('a disconnected stream never reports an unconfirmed conversion as success', async (context) => {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('data: {"type":"stdout","text":"working"}\n\n');
  const events: ProgressEvent[] = [];
  await executeConversion([item('one')], DEFAULT_CONVERT_OPTIONS, event => events.push(event), () => {});
  assert.equal(events.some(event => event.type === 'success'), false);
  assert.equal(events.some(event => event.type === 'error'), true);
});

test('a terminated process without an exit code is an error', async (context) => {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('data: {"type":"exit","code":null}\n\n');
  const events: ProgressEvent[] = [];
  await executeConversion([item('one')], DEFAULT_CONVERT_OPTIONS, event => events.push(event), () => {});
  assert.equal(events.some(event => event.type === 'success'), false);
  assert.equal(events.some(event => event.type === 'error'), true);
});

test('requesting stop never starts the next file and reports cancellation', async (context) => {
  const original = globalThis.fetch;
  context.after(() => { globalThis.fetch = original; });
  let requests = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/cancel-job')) return new Response('{"stopped":true}');
    requests++; void cancelActiveConversion();
    return new Response('data: {"type":"exit","code":0}\n\n');
  };
  const events: ProgressEvent[] = [];
  await executeConversion([item('one'), item('two')], DEFAULT_CONVERT_OPTIONS, event => events.push(event), () => {});
  assert.equal(requests, 1);
  assert.equal(events.some(event => event.type === 'cancelled'), true);
  assert.equal(events.some(event => event.type === 'done'), false);
});
