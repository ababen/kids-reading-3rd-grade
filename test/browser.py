import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
families={}
fail=False
requests=[]
def route(r):
 global fail
 path=urlparse(r.request.url).path
 if path=='/api/progress':
  if fail:
   r.fulfill(status=503,json={'error':'Offline'});return
  key=r.request.headers.get('authorization','')
  d=families.setdefault(key,{'names':['Reader 1','Reader 2'],'records':[[],[]]})
  ops=(r.request.post_data_json or {}).get('operations',[]) if r.request.method=='POST' else []
  requests.extend(ops)
  for op in ops:
   who=op['reader']
   if op['type']=='name':d['names'][who]=op['name']
   if op['type']=='result' and not any(x['uid']==op['record']['uid'] for x in d['records'][who]):d['records'][who].append(op['record'])
   if op['type']=='reset':d['records'][who]=[x for x in d['records'][who] if x['uid'] not in op['ids']]
  r.fulfill(json={'data':d});return
 file=root/('index.html' if path=='/' else path.lstrip('/'))
 if not file.is_file():r.fulfill(status=404);return
 r.fulfill(path=str(file),content_type='text/javascript' if file.suffix=='.js' else 'text/css' if file.suffix=='.css' else 'text/html')
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 ctx=b.new_context();ctx.route('**/*',route)
 page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('https://story-spark.test/')
 page.locator('#parent').click()
 page.locator('#readername').fill('Avery');page.locator('#rename button').click()
 page.locator('#enable-sync').click()
 page.wait_for_function("document.getElementById('sync-status').textContent.includes('Saved to cloud')")
 page.locator('#show-key').click();key=page.locator('#family-key').input_value();assert len(key)==64
 page.locator('#home').click();page.locator('[data-start]').first.click();page.locator('#check').click()
 for i in range(4):
  answer=page.evaluate('active.qs[qi][3]')
  if i==0:page.locator('#hint').click()
  page.locator(f'[data-answer="{answer}"]').click();page.locator('#next').click()
 page.wait_for_function('cloud.state.pending.length===0')
 assert page.locator('h1').inner_text()=='Adventure complete!'
 assert page.evaluate('data.records[0].length')==1
 assert page.evaluate('data.records[0][0].answers[0].help')
 page.reload();assert page.evaluate('data.records[0].length')==1
 # Independent browser context can restore the saved family.
 c2=b.new_context();c2.route('**/*',route);p2=c2.new_page();p2.on('pageerror',lambda e:errors.append(str(e)))
 p2.goto('https://story-spark.test/');p2.locator('#parent').click()
 p2.locator('summary').click();p2.locator('#join-key').fill(key)
 p2.on('dialog',lambda dialog:dialog.accept());p2.locator('#connect-family button').click()
 p2.wait_for_function("data.names[0]==='Avery' && data.records[0].length===1")
 # Keep a failed upload locally, survive reload, then retry.
 fail=True
 page.locator('#parent').click();page.locator('#readername').fill('Avery Offline');page.locator('#rename button').click()
 page.wait_for_function('!cloud.busy && cloud.state.pending.length===1')
 page.reload();page.wait_for_function('!cloud.busy')
 assert page.evaluate('data.names[0]')=='Avery Offline'
 assert page.evaluate('cloud.state.pending.length')==1
 fail=False
 page.evaluate('cloud.sync()');page.wait_for_function('cloud.state.pending.length===0')
 p2.evaluate('cloud.sync()');p2.wait_for_function("data.names[0]==='Avery Offline'")
 p2.locator('#reset').click();p2.wait_for_function('cloud.state.pending.length===0')
 page.evaluate('cloud.sync()');page.wait_for_function('data.records[0].length===0')
 assert not errors,errors
 print('Browser QA passed: rename, cloud enable, completion/hints, reload, second-device restore, offline queue/retry, cross-device reset; no JavaScript errors.')
 b.close()
