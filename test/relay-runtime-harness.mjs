// Test-only HTTP entrypoint for the production email handler inside workerd.
import relay from '../apps/relay/worker.mjs';

export default {
  async fetch(request, env) {
    const bytes = await request.arrayBuffer();
    try {
      await relay.email({ from: '', to: 'Box@Example.Test', rawSize: bytes.byteLength,
        raw: new Response(bytes).body }, env);
      return new Response(null, { status: 204 });
    } catch (error) {
      return new Response(error.message, { status: 502 });
    }
  },
};
