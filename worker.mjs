async function mailboxPrefix(address) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address.toLowerCase()));
  return `mailboxes/${Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('')}/messages/`;
}

function maxBytes(env) {
  const value = env.MAX_BYTES === undefined ? '10485760' : env.MAX_BYTES;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error('Invalid MAX_BYTES');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 26214400) throw new Error('Invalid MAX_BYTES');
  return limit;
}

function mailboxTokens(env) {
  const boxes = JSON.parse(env.MAILBOX_TOKENS);
  if (!boxes || Array.isArray(boxes) || typeof boxes !== 'object' || !Object.keys(boxes).length) throw new Error('Invalid MAILBOX_TOKENS');
  const tokens = new Set();
  for (const [address, token] of Object.entries(boxes)) {
    if (!/^[^@\s]+@[^@\s]+$/.test(address) || address !== address.toLowerCase() || typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,}$/.test(token) || tokens.has(token) || token === env.API_TOKEN) throw new Error('Invalid MAILBOX_TOKENS');
    tokens.add(token);
  }
  return boxes;
}

export default {
  async scheduled(controller, env) {
    if (env.RETENTION_DAYS === undefined) return { enabled: false };
    for (const [name, value, maximum] of [
      ['RETENTION_DAYS', env.RETENTION_DAYS, 3650],
      ['RETENTION_MAX_DELETES', env.RETENTION_MAX_DELETES === undefined ? '100' : env.RETENTION_MAX_DELETES, 1000],
    ]) {
      if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new Error(`Invalid ${name}`);
    }
    if (env.RETENTION_DELETE_ENABLED !== undefined && !['true', 'false'].includes(env.RETENTION_DELETE_ENABLED)) throw new Error('Invalid RETENTION_DELETE_ENABLED');
    const dryRun = env.RETENTION_DELETE_ENABLED !== 'true';
    const cutoff = Date.now() - Number(env.RETENTION_DAYS) * 86400000;
    const limit = Number(env.RETENTION_MAX_DELETES === undefined ? '100' : env.RETENTION_MAX_DELETES);
    const stateKey = 'retention/state-v1.json';
    const saved = await env.MAIL.get(stateKey);
    let state = saved ? await saved.json() : null;
    if (saved && (!state || !['messages/', 'mailboxes/'].includes(state.root) || typeof state.dryRun !== 'boolean' || !(state.cursor === null || (typeof state.cursor === 'string' && state.cursor.length > 0 && state.cursor.length <= 8192)))) throw new Error('Invalid retention state');
    if (!state || state.dryRun !== dryRun) state = { root: 'messages/', cursor: null, dryRun };
    const result = await env.MAIL.list({ prefix: state.root, limit, ...(state.cursor ? { cursor: state.cursor } : {}) });
    if (!Array.isArray(result.objects) || typeof result.truncated !== 'boolean' || (result.truncated && (typeof result.cursor !== 'string' || !result.cursor.length || result.cursor.length > 8192))) throw new Error('Invalid retention page');
    let candidates = 0, deleted = 0;
    for (const object of result.objects.slice(0, limit)) {
      if (!/^(?:messages\/[^/]+|mailboxes\/[a-f0-9]{64}\/messages\/[^/]+)$/.test(object.key) || !object.key.startsWith(state.root) || !(object.uploaded instanceof Date) || !Number.isFinite(object.uploaded.getTime()) || object.uploaded.getTime() >= cutoff) continue;
      candidates++;
      if (!dryRun) { await env.MAIL.delete(object.key); deleted++; }
    }
    const next = { root: result.truncated ? state.root : state.root === 'messages/' ? 'mailboxes/' : 'messages/', cursor: result.truncated ? result.cursor : null, dryRun };
    await env.MAIL.put(stateKey, JSON.stringify(next));
    const summary = { enabled: true, dryRun, candidates, deleted };
    console.log('retention', JSON.stringify(summary));
    return summary;
  },
  async email(message, env) {
    try {
      if (env.MAILBOX_TOKENS !== undefined) mailboxTokens(env);
      // Optional JSON array of active, lowercase envelope addresses. An empty array
      // rejects all recipients; omission preserves legacy delivery behavior.
      if (env.ACTIVE_MAILBOXES !== undefined) {
        if (typeof env.ACTIVE_MAILBOXES !== 'string') throw new Error('Invalid ACTIVE_MAILBOXES');
        const active = JSON.parse(env.ACTIVE_MAILBOXES);
        if (!Array.isArray(active) || active.some(address => typeof address !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(address) || address !== address.toLowerCase()) || new Set(active).size !== active.length) throw new Error('Invalid ACTIVE_MAILBOXES');
        if (typeof message.to !== 'string' || !active.includes(message.to.toLowerCase())) { message.setReject('Recipient not accepted'); return; }
      }
      const limit = maxBytes(env);
      if (!Number.isSafeInteger(message.rawSize) || message.rawSize < 0) throw new Error('Invalid raw size');
      if (message.rawSize > limit) { message.setReject('Message exceeds configured size limit'); return; }
      const reader = message.raw.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array)) throw new TypeError('Invalid raw stream chunk');
          if (value.byteLength > limit - size) {
            try { await reader.cancel(); } catch { /* Rejection still takes precedence. */ }
            message.setReject('Message exceeds configured size limit');
            return;
          }
          size += value.byteLength;
          chunks.push(new Uint8Array(value));
        }
      } finally {
        reader.releaseLock();
      }
      if (size !== message.rawSize) throw new Error('Raw size mismatch');
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const raw = bytes.buffer;
      const prefix = env.MAILBOX_TOKENS === undefined ? 'messages/' : await mailboxPrefix(message.to);
      const stored = await env.MAIL.put(`${prefix}${crypto.randomUUID()}`, raw, { customMetadata: { from: message.from, to: message.to, received: new Date().toISOString() } });
      if (stored === null) throw new Error('Storage returned no object');
    } catch (error) {
      console.error('inbound storage failure');
      throw error;
    }
  },
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const versioned = path === '/v1' || path.startsWith('/v1/');
    let response;
    try {
      response = await this.fetchInternal(request, env);
    } catch (error) {
      if (!versioned) throw error;
      response = new Response('Service unavailable', { status: 503 });
    }
    if (versioned) response.headers.set('cache-control', 'no-store');
    return response;
  },
  async fetchInternal(request, env) {
    if (env.MAILBOX_TOKENS !== undefined) {
      let boxes;
      try { boxes = mailboxTokens(env); } catch { return new Response('Service unavailable', { status: 503 }); }
      const supplied = request.headers.get('authorization') || '';
      const actual = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(supplied)));
      let mailbox;
      for (const [address, token] of Object.entries(boxes)) {
        const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`Bearer ${token}`)));
        let diff = 0;
        for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
        if (diff === 0) mailbox = address;
      }
      if (mailbox) {
        const prefix = await mailboxPrefix(mailbox);
        if (request.method === 'GET' && new URL(request.url).pathname === '/v1/messages') {
          const cursor = new URL(request.url).searchParams.get('cursor');
          const result = await env.MAIL.list({ prefix, limit: 100, include: ['customMetadata'], ...(cursor ? { cursor } : {}) });
          return Response.json({ messages: result.objects.map(o => ({ id: o.key.slice(prefix.length), size: o.size, envelope: { from: o.customMetadata?.from ?? null, to: o.customMetadata?.to ?? null, received: o.customMetadata?.received ?? null } })), cursor: result.truncated ? result.cursor : null }, { headers: { 'cache-control': 'no-store' } });
        }
        const rawMessage = /^\/v1\/messages\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/raw$/.exec(new URL(request.url).pathname);
        if (request.method === 'GET' && rawMessage) {
          const object = await env.MAIL.get(prefix + rawMessage[1]);
          if (!object) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
          return new Response(object.body, { headers: { 'content-type': 'message/rfc822', 'content-disposition': 'attachment; filename="message.eml"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
        }
        if (request.method === 'GET' && new URL(request.url).pathname === '/messages') {
          const cursor = new URL(request.url).searchParams.get('cursor');
          const result = await env.MAIL.list({ prefix, limit: 100, include: ['customMetadata'], ...(cursor ? { cursor } : {}) });
          return Response.json({ messages: result.objects.map(o => ({ ...o.customMetadata, id: o.key.slice(prefix.length), size: o.size })), cursor: result.truncated ? result.cursor : null }, { headers: { 'cache-control': 'no-store' } });
        }
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && /^\/messages\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(path)) {
          const object = await env.MAIL.get(prefix + path.slice(10));
          if (!object) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
          return new Response(object.body, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="message.eml"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
        }
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      }
      if (!env.API_TOKEN) return new Response('Unauthorized', { status: 401 });
    }
    if (typeof env.API_TOKEN !== 'string' || !/^[A-Za-z0-9_-]{40,}$/.test(env.API_TOKEN)) return new Response('Service unavailable', { status: 503 });
    const expected = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`Bearer ${env.API_TOKEN}`));
    const actual = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('authorization') || ''));
    const a = new Uint8Array(expected), b = new Uint8Array(actual);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    if (diff !== 0) return new Response('Unauthorized', { status: 401 });
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/admin/messages' && env.MAILBOX_TOKENS !== undefined) {
      const mailbox = url.searchParams.get('mailbox');
      if (!mailbox || !/^[^@\s]+@[^@\s]+$/.test(mailbox)) return new Response('Bad request', { status: 400, headers: { 'cache-control': 'no-store' } });
      const prefix = await mailboxPrefix(mailbox);
      const cursor = url.searchParams.get('cursor');
      const result = await env.MAIL.list({ prefix, limit: 100, include: ['customMetadata'], ...(cursor ? { cursor } : {}) });
      return Response.json({ messages: result.objects.map(o => ({ ...o.customMetadata, id: o.key.slice(prefix.length), size: o.size })), cursor: result.truncated ? result.cursor : null }, { headers: { 'cache-control': 'no-store' } });
    }
    const adminMessage = /^\/admin\/messages\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(url.pathname);
    if (request.method === 'GET' && adminMessage && env.MAILBOX_TOKENS !== undefined) {
      const mailbox = url.searchParams.get('mailbox');
      if (!mailbox || !/^[^@\s]+@[^@\s]+$/.test(mailbox)) return new Response('Bad request', { status: 400, headers: { 'cache-control': 'no-store' } });
      const object = await env.MAIL.get(await mailboxPrefix(mailbox) + adminMessage[1]);
      if (!object) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      return new Response(object.body, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="message.eml"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    }
    if (request.method === 'GET' && new URL(request.url).pathname === '/messages') {
      const cursor = new URL(request.url).searchParams.get('cursor');
      const result = await env.MAIL.list({ prefix: 'messages/', limit: 100, include: ['customMetadata'], ...(cursor ? { cursor } : {}) });
      return Response.json({ messages: result.objects.map(o => ({ id: o.key.slice(9), size: o.size, ...o.customMetadata })), cursor: result.truncated ? result.cursor : null }, { headers: { 'cache-control': 'no-store' } });
    }
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && /^\/messages\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(path)) {
      const object = await env.MAIL.get(path.slice(1));
      if (!object) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      return new Response(object.body, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="message.eml"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    }
    return new Response('Not found', { status: 404 });
  },
};
