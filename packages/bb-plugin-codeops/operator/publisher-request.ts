// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { publisherRequest } from '../core/publication-client.ts';
const [socket,operation,file]=process.argv.slice(2);
if(!socket||!operation||!file) throw Error('Usage: publisher-request.ts /private/publisher.sock operation /private/request.json');
try {
 const bytes=await readFile(file);if(bytes.length>25*1024*1024) throw Error('Request too large');
 console.log(JSON.stringify(await publisherRequest(socket,operation,JSON.parse(bytes.toString('utf8')))));
} catch {console.error('Publisher request rejected or outcome unknown. Reconcile its durable record before retry.');process.exitCode=1;}
