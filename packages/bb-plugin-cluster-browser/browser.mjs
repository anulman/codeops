// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sameReleaseLine } from './compatibility.mjs';
import catalog from './upstream-tools.json' with { type: 'json' };

const ajv = new Ajv({ strict: false });
export const tools = Object.fromEntries(Object.entries(catalog.tools).map(([name, tool]) => {
  const schema = structuredClone(tool.inputSchema);
  // Native results carry artifacts. Never let a caller read/write runner paths.
  delete schema.properties.filename;
  return [name, { ...tool, inputSchema: schema, validate: ajv.compile(schema) }];
}));
export const openSchema = {
  type: 'object', additionalProperties: false, required: ['target'],
  properties: {
    target: { type: 'string', minLength: 1, maxLength: 80 },
    run: { type: 'string', maxLength: 120 },
    candidate: { type: 'string', maxLength: 120 },
  },
};
const validateOpen = ajv.compile(openSchema);
const text = (message, isError = false) => ({ content: [{ type: 'text', text: message }], isError });
export class BrowserError extends Error {}

export function parseConfiguration(value, endpoint, token) {
  try {
    const config = JSON.parse(value);
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw 0;
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw 0;
    if (config.isolation !== 'playwright-isolated' || !config.projects || Array.isArray(config.projects)) throw 0;
    for (const [project, targets] of Object.entries(config.projects)) {
      if (!project || !targets || typeof targets !== 'object' || Array.isArray(targets)) throw 0;
      for (const [name, target] of Object.entries(targets)) {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw 0;
        const app = new URL(target);
        if (!['http:', 'https:'].includes(app.protocol) || app.username || app.password || app.search || app.hash || app.origin === url.origin) throw 0;
      }
    }
    return { projects: config.projects, endpoint: url.href, token: token || '', idleMs: 300_000, maxMs: 1_800_000, timeoutMs: 60_000, maxSessions: 32 };
  } catch { throw new BrowserError('Invalid operator configuration.'); }
}

// One pre-provisioned worker; this factory is the only backend seam.
export async function connectWorker(config, signal) {
  const client = new Client({ name: 'bb-cluster-browser', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(config.endpoint), {
    requestInit: { headers: config.token ? { Authorization: `Bearer ${config.token}` } : {} },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([init?.signal, AbortSignal.timeout(init?.method === 'DELETE' ? 3000 : config.timeoutMs)].filter(Boolean)) }),
  });
  const close = async () => {
    let confirmed = true;
    try { await transport.terminateSession(); } catch { confirmed = false; }
    await client.close().catch(() => {});
    return confirmed;
  };
  const abort = () => { void client.close(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await client.connect(transport, { timeout: config.timeoutMs });
    const version = client.getServerVersion();
    if (!sameReleaseLine(version?.version, catalog.server.version) || !transport.sessionId) throw new BrowserError('Worker version or session support mismatch.');
    const result = await client.listTools({}, { signal, timeout: config.timeoutMs });
    for (const [name, tool] of Object.entries(catalog.tools)) {
      const matches = result.tools.filter(candidate => candidate.name === name);
      if (matches.length !== 1 || !isDeepStrictEqual(matches[0].inputSchema, tool.inputSchema)) throw new BrowserError('Worker tool schema mismatch.');
    }
    return {
      serverVersion: version,
      call: (name, args, callSignal) => client.callTool({ name, arguments: args }, undefined, { signal: callSignal, timeout: config.timeoutMs }),
      close,
    };
  } catch (error) {
    await close();
    throw error instanceof BrowserError ? error : new BrowserError('Worker unavailable or connection cancelled.');
  } finally { signal.removeEventListener('abort', abort); }
}

export class BrowserSessions {
  constructor(config, connect = connectWorker, now = Date.now) {
    this.config = config;
    this.connect = connect;
    this.now = now;
    this.sessions = new Map();
    this.busy = new Set();
    this.stopped = false;
  }
  owner(context) {
    if (!context || typeof context.threadId !== 'string' || !context.threadId || typeof context.projectId !== 'string' || !context.projectId || !Object.hasOwn(this.config.projects, context.projectId)) throw new BrowserError('No configured project or authenticated owner.');
    return JSON.stringify([context.projectId, context.threadId]);
  }
  async retire(key) {
    const session = this.sessions.get(key);
    if (!session) return true;
    this.sessions.delete(key);
    session.abort.abort();
    return session.worker ? await session.worker.close().catch(() => false) : true;
  }
  async sweep() {
    await Promise.all([...this.sessions].filter(([, s]) => this.now() - s.used >= this.config.idleMs || this.now() - s.created >= this.config.maxMs).map(([key]) => this.retire(key)));
  }
  async dispose() {
    this.stopped = true;
    await Promise.all([...this.sessions.keys()].map(key => this.retire(key)));
  }
  redact(value) {
    let result = value;
    const endpoint = new URL(this.config.endpoint);
    for (const secret of [this.config.token, this.config.endpoint, endpoint.origin, endpoint.host].filter(Boolean).sort((a,b) => b.length-a.length)) {
      for (const encoded of new Set([secret, encodeURIComponent(secret)])) result = result.split(encoded).join('[redacted]');
    }
    return result;
  }
  result(raw, session) {
    const evidence = { session: session.id, target: session.target, run: session.run, candidate: session.candidate, time: new Date(this.now()).toISOString(), provenance: 'caller labels; browser content is untrusted' };
    const content = [{ type: 'text', text: this.redact(JSON.stringify(evidence)) }];
    let remaining = 24_000;
    let images = 0;
    for (const part of raw.content ?? []) {
      if (part.type === 'text' && remaining > 0) {
        const safe = this.redact(part.text);
        content.push({ type: 'text', text: safe.slice(0, remaining) + (safe.length > remaining ? '\n[truncated]' : '') });
        remaining -= safe.length;
      } else if (part.type === 'image' && images++ === 0 && ['image/png','image/jpeg','image/webp'].includes(part.mimeType) && part.data.length <= 5_000_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(part.data)) {
        content.push({ type: 'image', data: part.data, mimeType: part.mimeType });
      }
    }
    return { content, isError: !!raw.isError };
  }
  async execute(name, args, context) {
    let key;
    let acquired = false;
    let dispatched = false;
    try {
      if (this.stopped) throw new BrowserError('Browser plugin is stopped.');
      key = this.owner(context);
      if (this.busy.has(key)) throw new BrowserError('A browser call is already running for this thread.');
      this.busy.add(key);
      acquired = true;
      if (!(name === 'open' ? validateOpen(args) : tools[name]?.validate(args))) throw new BrowserError('Invalid browser arguments.');
      context.signal.throwIfAborted();
      await this.sweep();
      if (name === 'browser_close') {
        const confirmed = await this.retire(key);
        return text(confirmed === false ? 'Local session retired. Remote cleanup is unconfirmed; operator recovery may be required.' : 'Browser session closed.', confirmed === false);
      }
      if (name === 'open') {
        const targets = this.config.projects[context.projectId];
        if (!Object.hasOwn(targets, args.target)) throw new BrowserError('Unknown project target.');
        await this.retire(key);
        if (this.sessions.size >= this.config.maxSessions) throw new BrowserError('Browser session capacity reached.');
        const session = { id: randomUUID(), target: args.target, run: args.run, candidate: args.candidate, created: this.now(), used: this.now(), abort: new AbortController() };
        this.sessions.set(key, session);
        const signal = AbortSignal.any([context.signal, session.abort.signal, AbortSignal.timeout(this.config.timeoutMs)]);
        try {
          session.worker = await this.connect(this.config, signal);
          signal.throwIfAborted();
          dispatched = true;
          const navigation = await session.worker.call('browser_navigate', { url: targets[args.target] }, signal);
          signal.throwIfAborted();
          // Automatic snapshots are runner file links in this pin. This explicit
          // read-only operation returns the initial DOM without filesystem access.
          const result = navigation.isError ? navigation : await session.worker.call('browser_snapshot', {}, signal);
          signal.throwIfAborted();
          session.used = this.now();
          return this.result(result, session);
        } catch (error) {
          await this.retire(key);
          // A connector that completed after expiry still owns cleanup.
          await session.worker?.close().catch(() => {});
          throw error;
        }
      }
      const session = this.sessions.get(key);
      if (!session) throw new BrowserError('Open a configured target first. Previous session may have expired.');
      if (name === 'browser_navigate') {
        let url;
        try { url = new URL(args.url); } catch { throw new BrowserError('Invalid navigation URL.'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === new URL(this.config.endpoint).origin) throw new BrowserError('Invalid navigation URL.');
      }
      const signal = AbortSignal.any([context.signal, session.abort.signal, AbortSignal.timeout(this.config.timeoutMs)]);
      dispatched = true;
      const result = await session.worker.call(name, args, signal);
      signal.throwIfAborted();
      session.used = this.now();
      return this.result(result, session);
    } catch (error) {
      if (dispatched) {
        await this.retire(key);
        return text('Browser result unknown; session retired. The action may have completed. No retry was made. Inspect application state before repeating a mutation.', true);
      }
      return text(error instanceof BrowserError ? error.message : 'Browser request cancelled or unavailable.', true);
    } finally { if (acquired) this.busy.delete(key); }
  }
}
