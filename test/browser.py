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
  d=families.setdefault(key,{'names':['Reader 1','Reader 2'],'records':[[],[]],'readerIds':[0,1],'deletedReaders':[]})
  ops=(r.request.post_data_json or {}).get('operations',[]) if r.request.method=='POST' else []
  requests.extend(ops)
  for op in ops:
   reader=op['reader']
   if op['type']=='delete-reader':
    if reader not in d['deletedReaders']:d['deletedReaders'].append(reader)
    if reader in d['readerIds']:
     i=d['readerIds'].index(reader)
     for field in ['readerIds','names','records']:d[field].pop(i)
    continue
   if reader in d['deletedReaders']:continue
   if op['type']=='add-reader' and reader not in d['readerIds']:
    d['readerIds'].append(reader);d['names'].append(op['name']);d['records'].append([])
   if reader not in d['readerIds']:continue
   who=d['readerIds'].index(reader)
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
 # Variable-size families: add a third kid, personalize a story, and retain results.
 page.locator('#parent').click()
 page.locator('#kid-name').fill('Sam <spark>');page.locator('#add-kid button').click()
 page.wait_for_function('cloud.state.pending.length===0 && data.names.length===3')
 new_id=page.evaluate('data.readerIds[who]')
 page.reload();assert page.evaluate('data.names.length')==3
 page.locator('#home').click();page.locator('[data-reader="2"]').click();page.locator('#personalize').click()
 for checkbox in page.locator('[name="cast"]').all():checkbox.uncheck()
 page.locator('#story-builder button').click()
 assert page.locator('#builder-error').inner_text()=='Choose at least one kid for your story.'
 for checkbox in page.locator('[name="cast"]').all():checkbox.check()
 page.locator('#story-theme').select_option('mystery')
 page.locator('#story-builder button').click()
 assert 'Sam <spark>' in page.locator('h1').inner_text()
 assert page.locator('spark').count()==0
 assert 'Sam <spark>' in page.locator('.story').inner_text()
 page.locator('#check').click()
 for i in range(4):
  answer=page.evaluate('active.qs[qi][3]')
  page.locator(f'[data-answer="{answer}"]').click();page.locator('#next').click()
 page.wait_for_function('cloud.state.pending.length===0')
 assert page.evaluate('data.records[who][0].id')=='personal-mystery'
 page.locator('[data-ending]').first.click()
 assert 'Sam <spark>' in page.locator('#ending').inner_text()
 p2.evaluate('cloud.sync()');p2.wait_for_function('data.names.length===3')
 assert p2.evaluate('data.readerIds.includes('+json.dumps(new_id)+')')
 # Cancel deletion first, then delete a sibling without moving the new kid's progress.
 page.locator('#parent').click()
 def dismiss_delete(dialog):dialog.dismiss()
 page.on('dialog',dismiss_delete)
 page.locator('[data-delete="0"]').click()
 assert page.evaluate('data.names.length')==3
 # Replace the dismiss handler for subsequent confirmed deletions.
 page.remove_listener('dialog',dismiss_delete)
 page.on('dialog',lambda dialog:dialog.accept())
 page.locator('[data-delete="0"]').click()
 page.wait_for_function('cloud.state.pending.length===0 && data.names.length===2')
 assert page.evaluate('data.readerIds[who]')==new_id
 assert page.evaluate('data.records[who][0].id')=='personal-mystery'
 page.reload();assert page.evaluate('data.names.length')==2
 p2.evaluate('cloud.sync()');p2.wait_for_function('data.names.length===2')
 # Delete every remaining kid and recover from the empty family state.
 page.locator('#parent').click()
 while page.evaluate('data.names.length'):
  page.locator('[data-delete="0"]').click()
  page.wait_for_function('cloud.state.pending.length===0')
 assert page.locator('h2',has_text='Ready for a new reader').is_visible()
 page.reload();assert page.locator('#add-kid').is_visible()
 page.locator('#kid-name').fill('New explorer');page.locator('#add-kid button').click()
 page.wait_for_function('cloud.state.pending.length===0 && data.names.length===1')
 assert page.evaluate('data.records[0].length')==0
 assert 'Built by Marketing Bull' in page.locator('footer').inner_text()
 assert not errors,errors
 print('Browser QA passed: rename, cloud enable, completion/hints, reload, second-device restore, offline queue/retry, cross-device reset, add/delete kids, personalized story and questions, HTML-safe names, deletion cancellation, sibling progress isolation, empty-family recovery, footer; no JavaScript errors.')
 b.close()
