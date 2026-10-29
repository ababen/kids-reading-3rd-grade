const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const handler = require('../api/progress');
const stories = require('../stories');
const FamilySync = require('../cloud');
const fetchOriginal = global.fetch;
const urlOriginal = process.env.UPSTASH_REDIS_REST_URL;
const tokenOriginal = process.env.UPSTASH_REDIS_REST_TOKEN;
afterEach(() => {
  global.fetch = fetchOriginal;
  if (urlOriginal === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = urlOriginal;
  if (tokenOriginal === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = tokenOriginal;
});
const blank = () => ({ names: ['Reader 1', 'Reader 2'], records: [[], []] });
const result = () => ({ type: 'result', reader: 0, record: { uid: randomUUID(), id: stories[0].id, date: new Date().toISOString(), answers: stories[0].qs.map(q => ({ skill: q[0], first: true, attempts: 1, help: false })) } });
async function call(method = 'GET', body, key = 'a'.repeat(64)) {
  const req = { method, body, headers: { authorization: key ? `Bearer ${key}` : '', 'content-type': 'application/json' } };
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, json(value) { this.body = value; return this; } };
  await handler(req, res); return res;
}
function configured() { process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example'; process.env.UPSTASH_REDIS_REST_TOKEN = 'server-secret'; }
test('requests require a private family credential and supported method', async () => {
  global.fetch = () => assert.fail('must not reach database');
  assert.equal((await call('GET', undefined, '')).code, 401);
  assert.equal((await call('GET', undefined, 'short')).code, 401);
  assert.equal((await call('DELETE')).code, 405);
});
test('unconfigured backend returns an actionable unavailable response', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  assert.equal((await call()).code, 503);
});
test('invalid results are rejected before database access', async () => {
  configured(); global.fetch = () => assert.fail('must not reach database');
  for (const mutate of [op => op.reader = 2, op => op.record.id = 'missing', op => op.record.answers.pop(), op => op.record.answers[0].first = false, op => op.record.uid = 'predictable']) {
    const op = result(); mutate(op);
    assert.equal((await call('POST', { operations: [op] })).code, 400);
  }
  assert.equal((await call('POST', { operations: Array(51).fill(result()) })).code, 400);
});
test('valid operations use an atomic database script with a hashed family namespace', async () => {
  configured(); const op = result(); let command;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://redis.example');
    assert.equal(options.headers.Authorization, 'Bearer server-secret');
    command = JSON.parse(options.body);
    return { ok: true, json: async () => ({ result: ['name:0', 'Alex', `record:${op.record.uid}`, JSON.stringify(op)] }) };
  };
  const response = await call('POST', { operations: [op] });
  assert.equal(response.code, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(command[0], 'EVAL'); assert.equal(command[2], 2);
  assert.ok(!command[3].includes('a'.repeat(64)));
  assert.deepEqual(JSON.parse(command[5]), [op]);
  assert.equal(response.body.data.names[0], 'Alex');
  assert.equal(response.body.data.records[0][0].uid, op.record.uid);
});
test('database failure and rate limiting never report success', async () => {
  configured(); global.fetch = async () => ({ ok: true, json: async () => ({ result: ['RATE_LIMIT'] }) });
  const limited = await call(); assert.equal(limited.code, 429); assert.equal(limited.headers['Retry-After'], '60');
  global.fetch = async () => ({ ok: false });
  assert.equal((await call()).code, 503);
});
function client() {
  const c = Object.create(FamilySync.prototype);
  c.state = { key: 'a'.repeat(64), pending: [], data: blank() };
  c.update = () => {}; c.notify = () => {}; c.persist = () => true;
  return c;
}
test('offline results remain pending and successful retry acknowledges them', async () => {
  const c = client(), op = result();
  c.apply(c.state.data, op); c.state.pending.push(op);
  c.request = async () => { throw Error('Offline'); };
  await c.sync();
  assert.equal(c.state.pending.length, 1); assert.equal(c.state.data.records[0].length, 1);
  const remote = blank(); remote.records[0].push(op.record);
  c.request = async () => remote;
  await c.sync();
  assert.equal(c.state.pending.length, 0); assert.deepEqual(c.state.data, remote);
});
test('a result completed during an upload survives the server response', async () => {
  const c = client(), first = result(), second = result(); let calls = 0;
  c.state.pending.push(first); c.apply(c.state.data, first);
  c.request = async () => {
    const data = blank(); data.records[0].push(first.record);
    if (++calls === 1) { c.state.pending.push(second); c.apply(c.state.data, second); }
    else data.records[0].push(second.record);
    return data;
  };
  await c.sync();
  assert.equal(calls, 2); assert.equal(c.state.pending.length, 0); assert.equal(c.state.data.records[0].length, 2);
});
test('connecting another family fails safely while local edits are pending', async () => {
  const c = client(); c.state.pending.push(result());
  await assert.rejects(c.connect('b'.repeat(64)), /Finish syncing/);
  assert.equal(c.state.key, 'a'.repeat(64));
});
