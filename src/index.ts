import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { verifyKey } from 'discord-interactions';

type Params = { application_id: string; token: string; content: string };

export class DiscordWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		await step.do(
			'edit our discord message',
			{
				retries: {
					limit: 5,
					delay: '3 second',
					backoff: 'exponential',
				},
				timeout: '15 minutes',
			},
			async () => {
				const response = await fetch(
					`https://discord.com/api/v10/webhooks/${event.payload.application_id}/${event.payload.token}/messages/@original`,
					{
						method: 'PATCH',
						body: JSON.stringify({
							content: event.payload.content,
						}),
						headers: { 'Content-Type': 'application/json' },
					},
				);
				if (response.status === 400) {
					throw new Error(`status 400, content: "${event.payload.content}"`);
				}
				return { status: response.status, content: event.payload.content };
			},
		);
	}
}

function wrapPromise<T>(func: promiseFunc<T>, time = 1000) {
	return new Promise((resolve, reject) => {
		return setTimeout(() => {
			func(resolve, reject).catch((e: unknown) => {
				console.log(e);
			});
		}, time);
	});
}

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
						const messages = [
							{ role: 'system', content: 'keep your response below 2000 characters.' },
							{ role: 'user', content: args },
						];
						ctx.waitUntil(
							(async () => {
								const response = (await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', { messages })).response;
								await env.WORKFLOW.create({
									id: crypto.randomUUID(),
									params: {
										application_id: b.application_id,
										token: b.token,
										content: response,
									},
								});
							})(),
						);
						return new Response(JSON.stringify({ type: 5 }), { headers: { 'Content-Type': 'application/json' } });
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
