// SPDX-License-Identifier: Apache-2.0
// Operator-only browser fixture against an already running temporary bb instance.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const require=createRequire(new URL('../../services/codeops-acceptance-runner/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const [configPath]=process.argv.slice(2);
assert.ok(configPath,'Usage: node infra/scripts/qualify-bb-codeops-panel.mjs <panel-fixture.json>');
const config=JSON.parse(await readFile(configPath,'utf8'));
const captured=JSON.parse(await readFile(config.nativeEvidencePath,'utf8'));
assert.equal(captured.run.stage,'Publish');
assert.equal(captured.run.condition,'NeedsAttention');
assert.match(captured.candidate.head,/^[a-f0-9]{40}$/);
assert.equal(new URL(config.panelUrl).protocol,'https:','Use the operator-approved authenticated bb origin');
// Never rewrite/relax browser or worker sandbox flags here.
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext(config.storageStatePath?{storageState:config.storageStatePath}:{});
  const page=await context.newPage();
  await mkdir(config.outputDirectory,{recursive:false,mode:0o700});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    await page.goto(config.panelUrl,{waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:'CodeOps',exact:true}).waitFor({state:'visible'});
    const card=page.locator('article').filter({has:page.getByRole('heading',{name:captured.run.brief.outcome,exact:true})});
    await card.waitFor({state:'visible'});
    assert.match(await card.innerText(),/Publish.*NeedsAttention/);
    assert.ok((await card.innerText()).includes(captured.candidate.head));
    // The bb shell can clip overflow without increasing document.scrollWidth.
    // Check both element bounds and actual text fragments against the card.
    assert.ok(await card.evaluate(element=>{
      const bounds=element.getBoundingClientRect(),tolerance=1;
      if(bounds.left < -tolerance || bounds.right > window.innerWidth+tolerance) return false;
      return [...element.querySelectorAll('h2, code')].every(child=>{
        const box=child.getBoundingClientRect();
        if(child.scrollWidth > child.clientWidth+tolerance || box.left < bounds.left-tolerance || box.right > bounds.right+tolerance) return false;
        const text=document.createRange();text.selectNodeContents(child);
        return [...text.getClientRects()].every(rect=>rect.left >= box.left-tolerance && rect.right <= box.right+tolerance);
      });
    }),'Outcome and candidate text must fit inside the visible card without clipping');
    await card.getByRole('button',{name:'Evidence',exact:true}).click();
    await page.getByRole('heading',{name:`Run ${captured.run.id}`,exact:true}).waitFor({state:'visible'});
    const detail=JSON.parse(await page.locator('section pre').innerText());
    assert.deepEqual(detail.candidate,captured.candidate);
    assert.deepEqual(detail.checks,captured.run.checks);
    assert.deepEqual(detail.review,captured.run.review);
    await page.getByRole('button',{name:'Controlling thread',exact:true}).waitFor({state:'visible'});
    assert.equal(await page.getByRole('button',{name:/^(worker|reviewer) · attempt /}).count(),2);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Panel must fit viewport');
    await page.screenshot({path:join(config.outputDirectory,`panel-${viewport.width}.png`),fullPage:true});
  }
  await writeFile(join(config.outputDirectory,'panel.json'),JSON.stringify({runId:captured.run.id,candidate:captured.candidate,
    viewports:[1440,390],result:'passed'},null,2)+'\n',{flag:'wx',mode:0o600});
} finally {await browser.close();}
