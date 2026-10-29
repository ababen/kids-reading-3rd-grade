/* Local-first family sync. The family key is a private read/write credential. */
class FamilySync {
  constructor(initial, update) {
    this.update = update;
    this.status = 'Cloud saving is off. Progress is saved in this browser.';
    try { this.state = JSON.parse(localStorage.getItem('story-spark-cloud-v1')); } catch {}
    if (!this.state || !Array.isArray(this.state.pending) || !this.state.data) {
      this.state = { key: '', pending: [], data: initial };
    }
    this.state.data.records.forEach(records => records.forEach(r => { r.uid ||= crypto.randomUUID(); }));
    this.busy = false;
    window.addEventListener('online', () => this.sync());
    window.addEventListener('focus', () => this.sync());
    this.timer = setInterval(() => this.sync(), 30000);
  }
  persist() {
    try {
      localStorage.setItem('story-spark-cloud-v1', JSON.stringify(this.state));
      // Keep the original local export readable by previous app versions.
      localStorage.setItem('story-spark-v1', JSON.stringify(this.state.data));
      return true;
    } catch {
      this.status = 'This browser cannot save progress. Keep this page open and download a copy.';
      return false;
    }
  }
  apply(data, op) {
    if (op.type === 'name') data.names[op.reader] = op.name;
    if (op.type === 'result' && !data.records[op.reader].some(r => r.uid === op.record.uid)) data.records[op.reader].push(op.record);
    if (op.type === 'reset') data.records[op.reader] = data.records[op.reader].filter(r => !op.ids.includes(r.uid));
  }
  enqueue(op) {
    if (this.state.key) this.state.pending.push(op);
    const ok = this.persist();
    this.sync();
    return ok;
  }
  async request(key, operations) {
    const response = await fetch('/api/progress', {
      method: operations.length ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(operations.length ? { body: JSON.stringify({ operations }) } : {}),
      signal: AbortSignal.timeout(12000), cache: 'no-store'
    });
    if (!response.ok) throw Error(response.status === 503 ? 'Cloud saving is unavailable. Check the backend setup or try again later.' : 'Could not sync. Your changes will retry automatically.');
    const reply = await response.json();
    if (!reply.data || !Array.isArray(reply.data.names) || !Array.isArray(reply.data.records)) throw Error('Invalid cloud response.');
    return reply.data;
  }
  async sync() {
    if (!this.state.key || this.busy) return;
    this.busy = true;
    this.status = 'Saving to cloud…';
    this.notify();
    try {
      do {
        const sent = this.state.pending.slice(0, 50);
        const remote = await this.request(this.state.key, sent);
        this.state.pending.splice(0, sent.length);
        this.state.pending.forEach(op => this.apply(remote, op));
        const changed = JSON.stringify(this.state.data) !== JSON.stringify(remote);
        this.state.data = remote;
        const ok = this.persist();
        this.status = ok ? 'Saved to cloud. This device is up to date.' : this.status;
        this.update(remote, changed);
      } while (this.state.pending.length);
    } catch (error) {
      this.status = `${error.message} ${this.state.pending.length ? 'Changes are waiting on this device.' : ''}`;
    } finally {
      this.busy = false;
      this.notify();
    }
  }
  enable() {
    if (this.state.key) return;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    this.state.key = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    this.state.pending = this.state.data.names.map((name, reader) => ({ type: 'name', reader, name }));
    this.state.data.records.forEach((records, reader) => records.forEach(record => this.state.pending.push({ type: 'result', reader, record })));
    this.persist();
    this.sync();
  }
  async connect(key) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw Error('Enter the complete 64-character family key.');
    if (this.busy || this.state.pending.length) throw Error('Finish syncing this device before connecting another family.');
    this.busy = true;
    try {
      const previous = JSON.stringify(this.state.data);
      const remote = await this.request(key, []);
      if (this.state.pending.length || JSON.stringify(this.state.data) !== previous) throw Error('Progress changed while connecting. Try again after it is saved.');
      // An unknown key should not silently replace local results with an empty family.
      if (remote.records.every(r => !r.length) && remote.names[0] === 'Reader 1' && remote.names[1] === 'Reader 2') throw Error('No saved family found. Save progress on the first device, then copy its key.');
      this.state = { key, pending: [], data: remote };
      this.persist();
      this.update(remote);
      this.status = 'Connected. Saved family progress is loaded.';
    } finally { this.busy = false; this.notify(); }
  }
  notify() {
    const node = document.getElementById('sync-status');
    if (node) node.textContent = this.status;
  }
  panel() {
    return `<section class="paper"><h2>Save across devices</h2><p id="sync-status" role="status"></p>${this.state.key ? '<p>Keep your family key somewhere private. Anyone with it can read and change these two profiles. There is no email recovery.</p><button id="show-key">Show family key</button> <button id="sync-now">Sync now</button><input id="family-key" aria-label="Your private family key" readonly hidden style="width:100%;box-sizing:border-box;margin-top:12px;font:inherit">' : '<p>Enable cloud saving to back up these profiles and results.</p><button id="enable-sync">Enable cloud saving</button>'}<details style="margin-top:16px"><summary>Connect this device to an existing family</summary><p>This loads that family’s profiles in place of this device’s profiles. Download any local progress you want to keep first.</p><form id="connect-family"><label for="join-key">Family key from your other device</label><input id="join-key" type="password" autocomplete="off" spellcheck="false" minlength="64" maxlength="64" required style="width:100%;box-sizing:border-box;margin:12px 0;font:inherit"><button>Connect family</button></form></details></section>`;
  }
  bind(render) {
    this.notify();
    document.getElementById('enable-sync')?.addEventListener('click', () => { this.enable(); render(); });
    document.getElementById('sync-now')?.addEventListener('click', () => this.sync());
    document.getElementById('show-key')?.addEventListener('click', () => {
      const input = document.getElementById('family-key');
      input.value = this.state.key; input.hidden = !input.hidden;
      if (!input.hidden) { input.focus(); input.select(); }
    });
    document.getElementById('connect-family')?.addEventListener('submit', async event => {
      event.preventDefault();
      if (!confirm('Load the other family’s profiles on this device? Download local progress first if you want to keep it.')) return;
      const key = document.getElementById('join-key').value.trim();
      try { await this.connect(key); render(); }
      catch (error) { this.status = error.message; this.notify(); }
    });
  }
}
if (typeof module !== 'undefined') module.exports = FamilySync;
