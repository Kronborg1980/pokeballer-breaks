/* Local fixtures only: the test never contacts YouTube or production. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname,'..');
const feed = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:videoId>abc123DEF_-</yt:videoId><title>Live Pokemon break</title></entry><entry><yt:videoId>xyz789ABC_-</yt:videoId><title>Latest hunt</title></entry></feed>`;
(async()=>{
 const server=http.createServer(async(req,res)=>{
  const file=path.resolve(root,'.'+new URL(req.url,'http://local').pathname);
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  try {const body=await fs.readFile(file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(body);}catch{res.writeHead(404).end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let browser;
 try {
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const mode of ['valid','unavailable','invalid','empty']){
   const context=await browser.newContext({viewport:{width:390,height:844}});
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.origin===origin)return route.continue();
    if(u.pathname==='/api/youtube')return route.fulfill({status:mode==='unavailable'?503:200,contentType:'application/xml',body:mode==='valid'?feed:mode==='empty'?'<feed/>':'not xml',headers:{'Access-Control-Allow-Origin':'*'}});
    if(u.pathname==='/api/items')return route.fulfill({json:[],headers:{'Access-Control-Allow-Origin':'*'}});
    if(u.pathname==='/api/settings')return route.fulfill({json:{theme:'crystal',paymentMode:'streamlabs'},headers:{'Access-Control-Allow-Origin':'*'}});
    return route.abort();
   });
   await page.goto(origin+'/index.html');
   if(mode==='valid'){
    await page.waitForSelector('#yt-container .yt-click-to-play');
    assert.equal(await page.locator('#yt-container .yt-click-to-play').count(),2);
    assert.equal(await page.locator('#yt-container iframe').count(),0);
    assert.match(await page.locator('#yt-container .yt-click-to-play img').first().getAttribute('src'),/abc123DEF_-/);
    await page.locator('#yt-container .yt-click-to-play').first().click();
    assert.match(await page.locator('#yt-container iframe').getAttribute('src'),/embed\/abc123DEF_-/);
   }else{
    await page.waitForSelector('#yt-container iframe');
    const frames=page.locator('#yt-container iframe');
    assert.equal(await frames.count(),2);
    for(const [i,list] of ['UULVdFYy9uChCNAWbvVhTYwHaQ','UULFdFYy9uChCNAWbvVhTYwHaQ'].entries()){
     const frame=frames.nth(i),src=await frame.getAttribute('src');
     assert.equal(new URL(src).searchParams.get('list'),list);
     assert.equal(new URL(src).searchParams.get('autoplay'),'0');
     assert.equal(await frame.getAttribute('loading'),'lazy');
    }
    assert.equal(await page.locator('#yt-container .yt-open-btn').count(),2);
    assert.equal(await page.getByText('REFRESH LATEST PREVIEWS',{exact:true}).count(),0);
    await page.setViewportSize({width:1440,height:1000});
    const [first,second]=await Promise.all([frames.nth(0).boundingBox(),frames.nth(1).boundingBox()]);
    assert.ok(second.x>first.x,'Desktop previews must occupy separate columns');
    assert.ok(Math.abs(second.y-first.y)<2,'Desktop previews must align');

   }
   assert.deepEqual(errors,[]);console.log('PASS video preview:',mode);await context.close();
  }
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
