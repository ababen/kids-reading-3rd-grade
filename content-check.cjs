const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const stories=vm.runInNewContext(fs.readFileSync('stories.js','utf8')+';stories');
assert.equal(stories.length,6);assert.equal(new Set(stories.map(s=>s.id)).size,stories.length);
for(const s of stories){assert.equal(s.qs.length,4);assert.equal(s.options.length,s.endings.length);for(const q of s.qs){assert.equal(q[2].length,3);assert.ok(Number.isInteger(q[3])&&q[3]>=0&&q[3]<q[2].length);assert.ok(s.paras[q[4]]);assert.ok(q[5].length>20);}}
console.log('6 passages, 24 answer keys, supporting paragraphs, and creative endings validated.');
