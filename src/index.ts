import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { verifyKey } from 'discord-interactions';

// Define types for better code organization
type Params = { application_id: string; token: string; content: string };
type DiscordInteraction = {
	type: number;
	application_id: string;
	token: string;
	data?: {
		name: string;
		options?: Array<{ value: string }>;
	};
};

// Constants to improve readability and maintainability
const INTERACTION_TYPES = {
	PING: 1,
	APPLICATION_COMMAND: 2,
};

const RESPONSE_TYPES = {
	PONG: 1,
	DEFERRED_CHANNEL_MESSAGE: 5,
	CHANNEL_MESSAGE: 4,
};

// Move this to an environment variable for security
const PUBLIC_KEY = '0b5b1993b65944d7262e91adfea6da4133112a0d1071c2bf899f8b95d86da6af';

export class DiscordWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		await step.do(
			'edit discord message',
			{
				retries: {
					limit: 5,
					delay: 500,
					backoff: 'exponential',
				},
				timeout: '10 minutes',
			},
			async () => {
				const { application_id, token, content } = event.payload;
				const url = `https://discord.com/api/v10/webhooks/${application_id}/${token}/messages/@original`;

				const response = await fetch(url, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						content: content.slice(-2000), // Discord has a 2000 character limit
					}),
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`Discord API error (${response.status}): ${errorText}`);
				}

				return {
					status: response.status,
					content: event.payload.content,
				};
			},
		);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Verify the request is from Discord
		const signature = request.headers.get('X-Signature-Ed25519');
		const timestamp = request.headers.get('X-Signature-Timestamp');

		if (!signature || !timestamp) {
			return new Response('Missing signature headers', { status: 401 });
		}

		const body = await request.text();

		// Use environment variable for the public key in production
		const isValidRequest = await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY || PUBLIC_KEY);

		if (!isValidRequest) {
			return new Response('Invalid request signature', { status: 401 });
		}

		try {
			const interaction = JSON.parse(body) as DiscordInteraction;

			switch (interaction.type) {
				case INTERACTION_TYPES.PING:
					return jsonResponse({ type: RESPONSE_TYPES.PONG });

				case INTERACTION_TYPES.APPLICATION_COMMAND:
					return await handleCommand(interaction, env, ctx);

				default:
					return new Response('Unsupported interaction type', { status: 400 });
			}
		} catch (error) {
			console.error('Error processing request:', error);
			return new Response('Internal server error', { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

// Helper function for JSON responses
function jsonResponse(data: any): Response {
	return new Response(JSON.stringify(data), {
		headers: { 'Content-Type': 'application/json' },
	});
}

// Handle different commands
async function handleCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
	const command = interaction.data?.name;

	if (!command) {
		return new Response('Missing command data', { status: 400 });
	}

	switch (command) {
		case 'question':
			return handleQuestionCommand(interaction, env, ctx);

		case 'hello':
			return jsonResponse({
				type: RESPONSE_TYPES.CHANNEL_MESSAGE,
				data: { content: 'Hello world! 👋' },
			});

		default:
			return new Response(`Unknown command: ${command}`, { status: 400 });
	}
}

// Handle the question command
async function handleQuestionCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
	const userQuestion = interaction.data?.options?.[0]?.value;

	if (!userQuestion) {
		return jsonResponse({
			type: RESPONSE_TYPES.CHANNEL_MESSAGE,
			data: { content: 'Please provide a question!' },
		});
	}

	// Process AI response in the background
	ctx.waitUntil(
		(async () => {
			try {
				const messages = [
					{ role: 'system', content: 'Keep your response below 2000 characters.' },
					{ role: 'user', content: userQuestion },
				];

				const result = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', { messages });
				const response = 'response' in result ? String(result.response) : "Sorry, I couldn't process your question.";

				// Create workflow to update the message
				await env.WORKFLOW.create({
					id: crypto.randomUUID(),
					params: {
						application_id: interaction.application_id,
						token: interaction.token,
						content: response,
					},
				});
			} catch (error) {
				console.error('Error processing AI response:', error);

				// Update with error message if AI fails
				await env.WORKFLOW.create({
					id: crypto.randomUUID(),
					params: {
						application_id: interaction.application_id,
						token: interaction.token,
						content: 'Sorry, I encountered an error processing your question.',
					},
				});
			}
		})(),
	);

	// Immediately respond with "thinking" state
	return jsonResponse({ type: RESPONSE_TYPES.DEFERRED_CHANNEL_MESSAGE });
}
