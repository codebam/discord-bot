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
		switch (b.type) {
			case 1:
				return new Response(JSON.stringify({ type: 1 }), { headers: { 'Content-Type': 'application/json' } });
			case 2:
				const command = b.data.name;
				switch (command) {
					case 'question':
						const args = b.data.options[0].value;
						const messages = [{ role: 'user', content: args }];
						// @ts-expect-error broken bindings
						const { response } = await env.AI.run('@cf/meta/llama-3.2-1b-instruct', { messages, max_tokens: 20 });
						return new Response(
							JSON.stringify({
								type: 4,
								data: { content: response },
							}),
							{ headers: { 'Content-Type': 'application/json' } },
						);
					case 'hello':
						return new Response(
							JSON.stringify({
								type: 4,
								data: { content: 'hello world' },
							}),
							{ headers: { 'Content-Type': 'application/json' } },
						);
					default:
						break;
				}
			default:
				return new Response('Unhandled interaction type', { status: 400 });
		}
	},
} satisfies ExportedHandler<Env>;
