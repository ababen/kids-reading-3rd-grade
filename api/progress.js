const { createHash } = require('node:crypto');
const stories = require('../stories.js');

const blank = () => ({ names: ['Reader 1', 'Reader 2'], records: [[], []] });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// One atomic update: duplicate uploads are harmless, and a reset's tombstones
// prevent an offline device from restoring results that were already removed.
const script = `
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('EXPIRE', KEYS[2], 60) end
if count > 120 then return {'RATE_LIMIT'} end
local ops = cjson.decode(ARGV[1])
for _, op in ipairs(ops) do
  if op.type == 'name' then
    redis.call('HSET', KEYS[1], 'name:' .. op.reader, op.name)
  elseif op.type == 'result' then
    local id = op.record.uid
    if redis.call('HEXISTS', KEYS[1], 'deleted:' .. id) == 0 then
      redis.call('HSETNX', KEYS[1], 'record:' .. id, cjson.encode(op))
    end
  elseif op.type == 'reset' then
    for _, id in ipairs(op.ids) do
      local value = redis.call('HGET', KEYS[1], 'record:' .. id)
      if not value or cjson.decode(value).reader == op.reader then
        redis.call('HDEL', KEYS[1], 'record:' .. id)
        redis.call('HSET', KEYS[1], 'deleted:' .. id, '1')
      end
    end
  end
end
return redis.call('HGETALL', KEYS[1])
`;

function validate(ops) {
  if (!Array.isArray(ops) || ops.length > 50) throw Error('Send up to 50 operations.');
  return ops.map(op => {
    if (!op || ![0, 1].includes(op.reader)) throw Error('Invalid reader.');
    const { type, reader } = op;
    if (type === 'name' && typeof op.name === 'string' && op.name.trim().length > 0 && op.name.trim().length <= 24) {
      return { type, reader, name: op.name.trim() };
    }
    if (type === 'reset' && Array.isArray(op.ids) && op.ids.length <= 500 && op.ids.every(id => typeof id === 'string' && uuid.test(id))) {
      return { type, reader, ids: op.ids };
    }
    if (type !== 'result' || !op.record) throw Error('Invalid operation.');
    const r = op.record, story = stories.find(s => s.id === r.id);
    if (!uuid.test(r.uid) || !story || typeof r.date !== 'string' || !Number.isFinite(Date.parse(r.date)) || !Array.isArray(r.answers) || r.answers.length !== 4) throw Error('Invalid result.');
    const answers = r.answers.map((a, i) => {
      if (!a || a.skill !== story.qs[i][0] || !Number.isInteger(a.attempts) || a.attempts < 1 || a.attempts > 3 || typeof a.help !== 'boolean' || a.first !== (a.attempts === 1 && !a.help) || (a.attempts > 1 && !a.help)) throw Error('Invalid answer.');
      return { skill: a.skill, attempts: a.attempts, help: a.help, first: a.first };
    });
    return { type, reader, record: { uid: r.uid, id: r.id, date: new Date(r.date).toISOString(), answers } };
  });
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const match = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ error: 'A valid family key is required.' });
  // Vercel's Upstash integration can expose the REST pair with KV_* names.
  // Select a complete pair so credentials from different stores are never mixed.
  const explicit = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN;
  const url = explicit ? process.env.UPSTASH_REDIS_REST_URL : process.env.KV_REST_API_URL;
  const token = explicit ? process.env.UPSTASH_REDIS_REST_TOKEN : process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(503).json({ error: 'Cloud saving is not configured yet.' });
  let ops = [];
  if (req.method === 'POST') {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'Use application/json.' });
    try {
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!body || Buffer.byteLength(body) > 65536) return res.status(413).json({ error: 'Request too large.' });
      ops = validate(JSON.parse(body).operations);
    } catch {
      return res.status(400).json({ error: 'Invalid progress data.' });
    }
  }
  const family = createHash('sha256').update(match[1]).digest('hex');
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EVAL', script, 2, `story-spark:${family}`, `story-spark:${family}:rate`, JSON.stringify(ops)]),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw Error('Database unavailable');
    const reply = await response.json();
    if (reply.error || !Array.isArray(reply.result)) throw Error('Invalid database response');
    if (reply.result[0] === 'RATE_LIMIT') {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Please try again in a minute.' });
    }
    const data = blank();
    for (let i = 0; i < reply.result.length; i += 2) {
      const field = reply.result[i], value = reply.result[i + 1];
      if (field === 'name:0' || field === 'name:1') data.names[Number(field.slice(-1))] = value;
      if (field.startsWith('record:')) {
        const op = JSON.parse(value);
        data.records[op.reader].push(op.record);
      }
    }
    data.records.forEach(records => records.sort((a, b) => a.date.localeCompare(b.date) || a.uid.localeCompare(b.uid)));
    return res.status(200).json({ data });
  } catch {
    // Never log authorization headers, profile names, or reading records.
    console.error('Progress database request failed');
    return res.status(503).json({ error: 'Cloud saving is temporarily unavailable.' });
  }
}

module.exports = handler;
module.exports.validate = validate;
module.exports.script = script;
