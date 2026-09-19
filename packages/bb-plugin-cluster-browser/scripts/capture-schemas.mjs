// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = await createConnection({ browser: { isolated: true }, imageResponses: 'allow' });
await server.connect(serverTransport);
const client = new Client({ name: 'cluster-browser-schema-capture', version: '0.1.0' });
await client.connect(clientTransport);
const names = ['browser_navigate','browser_snapshot','browser_click','browser_fill_form','browser_press_key','browser_wait_for','browser_take_screenshot','browser_console_messages','browser_network_requests','browser_close'];
const { tools } = await client.listTools();
const selected = Object.fromEntries(names.map(name => {
 const tool = tools.find(tool => tool.name === name);
 if (!tool) throw new Error(`Missing ${name}`);
 return [name, {description: tool.description, inputSchema: tool.inputSchema}];
}));
await writeFile(new URL('../upstream-tools.json', import.meta.url), JSON.stringify({version: JSON.parse(await readFile(new URL('../node_modules/@playwright/mcp/package.json', import.meta.url), 'utf8')).version, server: client.getServerVersion(), tools: selected}, null, 2)+'\n');
await client.close();
await server.close();
