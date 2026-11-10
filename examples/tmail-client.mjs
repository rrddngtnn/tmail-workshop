// Standalone Node 22+ client. Example:
// const client = new TMailClient('https://mail.example', process.env.TMAIL_TOKEN);
// let cursor = null;
// do {
//   const page = await client.listPage(cursor);
//   for (const message of page.messages) {
//     const raw = await client.getRaw(message.id); // Buffer; envelope is on message
//     // Process raw and message.envelope before saving page.cursor externally.
//   }
//   cursor = page.cursor;
// } while (cursor !== null);
// Cursor persistence, deduplication, retries, and durable processing are caller responsibilities.
// Use HTTPS outside trusted local testing. Raw responses are buffered in memory.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = value => value === null || typeof value === 'string';

export class TMailClient {
  #origin;
  #token;
  constructor(baseUrl, token) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new TypeError('Invalid base URL: use an HTTP(S) origin');
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new TypeError('Invalid token');
    this.#origin = url.origin;
    this.#token = token;
  }
  async #get(path, cursor = null) {
    const url = new URL(path, this.#origin);
    if (url.origin !== this.#origin) throw new TypeError('Invalid cross-origin URL');
    if (cursor !== null) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, { headers: { authorization: `Bearer ${this.#token}` }, redirect: 'error' });
    if (!response.ok) throw new Error(`TMail HTTP ${response.status}`);
    return response;
  }
  async listPage(cursor = null) {
    if (cursor !== null && (typeof cursor !== 'string' || !cursor)) throw new TypeError('Invalid cursor');
    const response = await this.#get('/v1/messages', cursor);
    const page = await response.json();
    if (!object(page) || !Array.isArray(page.messages) || !(page.cursor === null || (typeof page.cursor === 'string' && page.cursor.length > 0))) throw new TypeError('Invalid page');
    for (const message of page.messages) {
      if (!object(message) || typeof message.id !== 'string' || !UUID.test(message.id) || !object(message.envelope) || !['from', 'to', 'received'].every(key => Object.hasOwn(message.envelope, key) && nullableString(message.envelope[key]))) throw new TypeError('Invalid message');
      if (!Number.isSafeInteger(message.size) || message.size < 0) throw new TypeError('Invalid message size');
    }
    return page;
  }
  async getRaw(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new TypeError('Invalid message id');
    const response = await this.#get(`/v1/messages/${id}/raw`);
    if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'message/rfc822') throw new TypeError('Invalid raw content type');
    return Buffer.from(await response.arrayBuffer());
  }
}