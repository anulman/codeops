// SPDX-License-Identifier: Apache-2.0
// Run only beside the disposable browser runner, never against production.
import { createServer } from 'node:http';
const page = `<!doctype html><title>Cluster Browser fixture</title>
<h1>CLUSTER_BROWSER_DISPOSABLE_FIXTURE</h1>
<label>Value <input id="value"></label><button id="save">Save</button>
<p id="stored"></p><p id="cookie"></p>
<script>
function show(){document.querySelector('#stored').textContent='Stored: '+(localStorage.getItem('value')||'empty');document.querySelector('#cookie').textContent='Cookie: '+(document.cookie||'empty');}
document.querySelector('#save').onclick=()=>{const value=document.querySelector('#value').value;localStorage.setItem('value',value);document.cookie='value='+encodeURIComponent(value)+'; SameSite=Strict; path=/';show();};
show();console.error('fixture diagnostic');fetch('/fixture-failure');
</script>`;
const server = createServer((req,res)=>{
 if(req.url==='/fixture-failure'){res.writeHead(503).end('fixture failure');return;}
 res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'}).end(page);
});
server.listen(4173,'127.0.0.1',()=>console.log('Disposable fixture listening on loopback port 4173.'));
