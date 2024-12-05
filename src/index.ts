import { verifyKey } from 'discord-interactions';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const signature = request.headers.get('X-Signature-Ed25519') as string;
		const timestamp = request.headers.get('X-Signature-Timestamp') as string;
		const body = await request.text();
		if (!(await verifyKey(body, signature, timestamp, '0b5b1993b65944d7262e91adfea6da4133112a0d1071c2bf899f8b95d86da6af'))) {
			return new Response('Invalid request signature', { status: 401 });
		}
		const b = JSON.parse(body);
		if (b.type === 1) {
			return new Response(JSON.stringify({ type: 1 }), { headers: { 'Content-Type': 'application/json' } });
		}
		return new Response('Unhandled interaction type', { status: 400 });
	},
} satisfies ExportedHandler<Env>;
