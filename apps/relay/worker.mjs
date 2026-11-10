export function createRelay({ fetch: transport = globalThis.fetch } = {}) {
  return {
    async email(message, env) {
      let limit;
      try {
        const target = env.RELAY_INGEST_URL;
        if (typeof target !== 'string' || !/^https:\/\//.test(target) || /[\s\\#?]/.test(target) || target.slice(8).split('/')[0].includes('@')) throw new Error();
        const url = new URL(target);
        if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/ingest' || url.search) throw new Error();
        if (typeof env.RELAY_INGEST_TOKEN !== 'string' || !/^[A-Za-z0-9_-]{40,256}$/.test(env.RELAY_INGEST_TOKEN)) throw new Error();
        const configured = env.MAX_BYTES === undefined ? '10485760' : env.MAX_BYTES;
        if (typeof configured !== 'string' || !/^[1-9][0-9]*$/.test(configured)) throw new Error();
        limit = Number(configured);
        if (!Number.isSafeInteger(limit) || limit > 26214400) throw new Error();
      } catch { throw new Error('Relay configuration invalid'); }
      let raw;
      try {
        const address = value => typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) && !/[\r\n]/.test(value);
        if (!address(message.to) || !(message.from === '' || address(message.from))) throw new Error();
        if (!Number.isSafeInteger(message.rawSize) || message.rawSize < 0 || message.rawSize > limit) throw new Error();
        const reader = message.raw.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array) || value.byteLength > limit - size) throw new Error();
            size += value.byteLength;
            if (value.byteLength) chunks.push(new Uint8Array(value));
          }
          if (size !== message.rawSize) throw new Error();
        } catch {
          try { await reader.cancel(); } catch { /* Keep the sanitized failure. */ }
          throw new Error();
        } finally { reader.releaseLock(); }
        raw = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
      } catch { throw new Error('Relay message invalid'); }
      try {
        const response = await transport(env.RELAY_INGEST_URL, {
          // workerd supports manual (not error); the strict 201 check below rejects redirects.
          method: 'POST', redirect: 'manual',
          headers: { authorization: 'Bearer ' + env.RELAY_INGEST_TOKEN,
            'content-type': 'message/rfc822', 'x-envelope-from': message.from, 'x-envelope-to': message.to },
          body: raw,
        });
        // Never parse/log an upstream response body (it may contain private data).
        try { await response.body?.cancel(); } catch { /* Status remains authoritative. */ }
        if (response.status !== 201) throw new Error();
      } catch { throw new Error('Relay delivery failed'); }
    },
  };
}

export default createRelay();
