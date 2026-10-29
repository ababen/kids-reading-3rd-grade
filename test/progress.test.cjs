const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const handler = require('../api/progress');
const stories = require('../stories');
const FamilySync = require('../cloud');
const fetchOriginal = global.fetch;
const urlOriginal = process.env.UPSTASH_REDIS_REST_URL;
const tokenOriginal = process.env.UPSTASH_REDIS_REST_TOKEN;
const kvUrlOriginal = process.env.KV_REST_API_URL;
const kvTokenOriginal = process.env.KV_REST_API_TOKEN;
beforeEach(() => {
  for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[key];
});
afterEach(() => {
  global.fetch = fetchOriginal;
  if (urlOriginal === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = urlOriginal;
  if (tokenOriginal === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = tokenOriginal;
  if (kvUrlOriginal === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = kvUrlOriginal;
  if (kvTokenOriginal === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = kvTokenOriginal;
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
test('Vercel Marketplace credentials work without renaming or mixing pairs', async () => {
  process.env.KV_REST_API_URL = 'https://marketplace.example';
  process.env.KV_REST_API_TOKEN = 'marketplace-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://incomplete.example';
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://marketplace.example');
    assert.equal(options.headers.Authorization, 'Bearer marketplace-secret');
    return { ok: true, json: async () => ({ result: [] }) };
  };
  assert.equal((await call()).code, 200);
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

test('reader additions and deletions keep progress tied to stable identities', () => {
  const c = client(), third = randomUUID(), fourth = randomUUID();
  c.apply(c.state.data, { type: 'add-reader', reader: third, name: 'Avery' });
  c.apply(c.state.data, { type: 'add-reader', reader: fourth, name: 'Sam' });
  const op = result(); op.reader = third;
  c.apply(c.state.data, op);
  c.apply(c.state.data, { type: 'delete-reader', reader: 0 });
  assert.deepEqual(c.state.data.readerIds, [1, third, fourth]);
  assert.equal(c.state.data.records[1][0].uid, op.record.uid);
  c.apply(c.state.data, { type: 'name', reader: third, name: 'Avery New' });
  assert.equal(c.state.data.names[1], 'Avery New');
  c.apply(c.state.data, { type: 'delete-reader', reader: third });
  c.apply(c.state.data, op);
  c.apply(c.state.data, { type: 'add-reader', reader: third, name: 'Stale device' });
  assert.deepEqual(c.state.data.names, ['Reader 2', 'Sam']);
  assert.ok(c.state.data.records.every(records => !records.length));
});

test('pending edits cannot revive a deleted reader after a sync response', async () => {
  const c = client(), op = result(); let calls = 0;
  c.state.pending.push({ type: 'name', reader: 1, name: 'Renamed' });
  c.request = async () => {
    const remote = { names: ['Reader 2'], records: [[]], readerIds: [1], deletedReaders: [0] };
    if (++calls === 1) c.state.pending.push(op);
    return remote;
  };
  await c.sync();
  assert.deepEqual(c.state.data.readerIds, [1]);
  assert.deepEqual(c.state.data.records, [[]]);
  assert.equal(c.state.pending.length, 0);
});

test('API restores variable-sized families and ignores records for deleted kids', async () => {
  configured(); const reader = randomUUID(), op = result(); op.reader = reader;
  global.fetch = async () => ({ ok: true, json: async () => ({ result: [
    'removed:0', '1', `name:${reader}`, 'Avery', `record:${op.record.uid}`, JSON.stringify(op),
    'record:legacy', JSON.stringify(result())
  ] }) });
  const response = await call();
  assert.equal(response.code, 200);
  assert.deepEqual(response.body.data.readerIds, [1, reader]);
  assert.deepEqual(response.body.data.names, ['Reader 2', 'Avery']);
  assert.equal(response.body.data.records[1][0].uid, op.record.uid);
  assert.deepEqual(response.body.data.deletedReaders, [0]);
  global.fetch = async () => ({ ok: true, json: async () => ({ result: ['removed:0', '1', 'removed:1', '1'] }) });
  assert.deepEqual((await call()).body.data.names, []);
});

test('API validates new profile operations and personalized story results', () => {
  const reader = randomUUID();
  assert.deepEqual(handler.validate([{ type: 'add-reader', reader, name: ' Avery ' }, { type: 'delete-reader', reader }]),
    [{ type: 'add-reader', reader, name: 'Avery' }, { type: 'delete-reader', reader }]);
  for (const bad of [{ type: 'add-reader', reader, name: ' ' }, { type: 'add-reader', reader: '__proto__', name: 'Avery' }, { type: 'delete-reader', reader: 2 }]) {
    assert.throws(() => handler.validate([bad]));
  }
  for (const theme of ['forest', 'space', 'mystery']) {
    const story = stories.generate(['Avery', 'Sam'], theme), op = result();
    op.reader = reader; op.record.id = story.id; op.record.title = story.title;
    op.record.answers = story.qs.map(q => ({ skill: q[0], first: true, attempts: 1, help: false }));
    assert.equal(handler.validate([op])[0].record.title, story.title);
    assert.ok(story.paras.join(' ').includes('Avery and Sam'));
    assert.equal(story.qs.length, 4);
    story.qs.forEach(q => { assert.ok(story.paras[q[4]]); assert.ok(q[2][q[3]]); });
  }
  assert.equal(stories.personalized('personal-unknown'), null);
});
