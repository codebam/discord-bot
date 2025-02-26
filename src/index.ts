import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { verifyKey } from 'discord-interactions';

interface Env {
	DISCORD_PUBLIC_KEY: string;
	AI: Ai;
	WORKFLOW: Workflow;
}

// Define types for better code organization
type Params = { application_id: string; token: string; content: string };
type DiscordInteraction = {
	type: number;
	application_id: string;
	token: string;
	data?: {
		name: string;
		options?: Array<{ name: string; value: string }>;
	};
	user?: {
		id: string;
		username: string;
	};
};

// Constants to improve readability and maintainability
const INTERACTION_TYPES = {
	PING: 1,
	APPLICATION_COMMAND: 2,
} as const;

const RESPONSE_TYPES = {
	PONG: 1,
	DEFERRED_CHANNEL_MESSAGE: 5,
	CHANNEL_MESSAGE: 4,
} as const;

// AI model constants
const AI_MODELS = {
	LLAMA: '@cf/meta/llama-3.2-11b-vision-instruct',
};

// Discord API constants
const DISCORD_API_BASE = 'https://discord.com/api/v10';
const MAX_DISCORD_MESSAGE_LENGTH = 2000;

/**
 * Workflow for handling Discord message updates
 */
export class DiscordWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		const result = await step.do(
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
				const url = `${DISCORD_API_BASE}/webhooks/${application_id}/${token}/messages/@original`;

				const response = await fetch(url, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						content: content.slice(0, MAX_DISCORD_MESSAGE_LENGTH),
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

		return result;
	}
}

/**
 * Helper function for JSON responses
 */
function jsonResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		headers: { 'Content-Type': 'application/json' },
	});
}

/**
 * Handle the question command
 */
async function handleQuestionCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
	const userQuestion = interaction.data?.options?.[0]?.value;

	if (!userQuestion) {
		return jsonResponse({
			type: RESPONSE_TYPES.CHANNEL_MESSAGE,
			data: { content: 'Please provide a question!' },
		});
	}

	// Process AI response in the background
	ctx.waitUntil(processAIResponse(interaction, userQuestion, env));

	// Immediately respond with "thinking" state
	return jsonResponse({ type: RESPONSE_TYPES.DEFERRED_CHANNEL_MESSAGE });
}

/**
 * Process AI response in the background
 */
async function processAIResponse(interaction: DiscordInteraction, userQuestion: string, env: Env): Promise<void> {
	try {
		const messages = [
			{ role: 'system', content: `You are a helpful assistant. Keep your response below ${MAX_DISCORD_MESSAGE_LENGTH} characters.` },
			{ role: 'user', content: userQuestion },
		];

		// Type assertion to handle the AI model
		const result = await env.AI.run(AI_MODELS.LLAMA as keyof AiModels, { messages });

		if (!result || typeof result !== 'object' || !('response' in result)) {
			throw new Error('Invalid AI response format');
		}

		// Create workflow to update the message
		await env.WORKFLOW.create({
			id: crypto.randomUUID(),
			params: {
				application_id: interaction.application_id,
				token: interaction.token,
				content: result.response || "Sorry, I couldn't generate a response.",
			},
		});
	} catch (error) {
		console.error('Error processing AI response:', error);

		// Handle errors by updating the message with an error notice
		await env.WORKFLOW.create({
			id: crypto.randomUUID(),
			params: {
				application_id: interaction.application_id,
				token: interaction.token,
				content: 'Sorry, I encountered an error while processing your question.',
			},
		});
	}
}

/**
 * Handle different commands
 */
async function handleCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
	const command = interaction.data?.name;

	if (!command) {
		return jsonResponse({
			type: RESPONSE_TYPES.CHANNEL_MESSAGE,
			data: { content: 'Missing command data' },
		});
	}

	try {
		switch (command) {
			case 'question':
				return handleQuestionCommand(interaction, env, ctx);

			case 'hello':
				return jsonResponse({
					type: RESPONSE_TYPES.CHANNEL_MESSAGE,
					data: {
						content: `Hello ${interaction.user?.username || 'there'}! 👋`,
						embeds: [
							{
								title: 'Discord Bot',
								description: 'I am your friendly AI-powered Discord bot!',
								color: 0x00ffff, // Cyan color
							},
						],
					},
				});

			default:
				return jsonResponse({
					type: RESPONSE_TYPES.CHANNEL_MESSAGE,
					data: { content: `Unknown command: ${command}` },
				});
		}
	} catch (error) {
		console.error(`Error handling command ${command}:`, error);
		return jsonResponse({
			type: RESPONSE_TYPES.CHANNEL_MESSAGE,
			data: { content: 'An error occurred while processing your command.' },
		});
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Only accept POST requests
		if (request.method !== 'POST') {
			return new Response('Method not allowed', { status: 405 });
		}

		// Verify the request is from Discord
		const signature = request.headers.get('X-Signature-Ed25519');
		const timestamp = request.headers.get('X-Signature-Timestamp');

		if (!signature || !timestamp) {
			return new Response('Missing signature headers', { status: 401 });
		}

		const body = await request.text();

		try {
			// Verify the request signature
			const isValidRequest = await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);

			if (!isValidRequest) {
				return new Response('Invalid request signature', { status: 401 });
			}

			const interaction = JSON.parse(body) as DiscordInteraction;

			switch (interaction.type) {
				case INTERACTION_TYPES.PING:
					return jsonResponse({ type: RESPONSE_TYPES.PONG });

				case INTERACTION_TYPES.APPLICATION_COMMAND:
					return await handleCommand(interaction, env, ctx);

				default:
					return new Response(`Unsupported interaction type: ${interaction.type}`, { status: 400 });
			}
		} catch (error) {
			console.error('Error processing request:', error);
			return new Response(`Internal server error: ${error instanceof Error ? error.message : String(error)}`, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
