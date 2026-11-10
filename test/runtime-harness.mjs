// Test-only entrypoint: exercise the email handler inside workerd, not Node.
import worker from '../worker.mjs';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/__test_email') return worker.fetch(request, env, ctx);
    const bytes = await request.arrayBuffer();
    let rejection;
    const message = {
      from: request.headers.get('x-test-from') || '',
      to: request.headers.get('x-test-to') || '',
      raw: new Response(bytes).body,
      rawSize: Number(request.headers.get('x-test-size') ?? bytes.byteLength),
      setReject(reason) { rejection = reason; },
    };
    try {
      await worker.email(message, env, ctx);
      return Response.json({ rejection: rejection ?? null });
    } catch {
      return new Response('email handler failed', { status: 500 });
    }
  },
};
