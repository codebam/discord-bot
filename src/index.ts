import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { verifyKey } from 'discord-interactions';

interface Env {
	DISCORD_PUBLIC_KEY: string;
	AI: Ai;
	WORKFLOW: Workflow;
	/** Optional override for the Workers AI model id. Falls back to DEFAULT_AI_MODEL. */
	AI_MODEL?: string;
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

// Default AI model; override at runtime via the AI_MODEL env var (see wrangler.toml).
const DEFAULT_AI_MODEL = '@cf/qwen/qwen3.8-27b';

// Allow this much drift (seconds) between Discord's timestamp header and our clock
// before treating the request as a replay.
const SIGNATURE_TIMESTAMP_TOLERANCE_SECONDS = 60;

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
				const { application_id, token, content: rawContent } = event.payload;
				const url = `${DISCORD_API_BASE}/webhooks/${application_id}/${token}/messages/@original`;

				const finalMessage = extractAiText(rawContent);

				if (!finalMessage) {
					throw new Error('No content found in the AI payload to send to Discord.');
				}

				const response = await fetch(url, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						content: finalMessage.slice(0, MAX_DISCORD_MESSAGE_LENGTH),
					}),
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`Discord API error (${response.status}): ${errorText}`);
				}

				return {
					status: response.status,
					content: finalMessage,
				};
			},
		);

		return result;
	}
}

/**
 * Normalize the various Workers AI response shapes into a single string.
 *
 * Covers the OpenAI-style `choices[...]` format as well as the legacy `result`,
 * `completion`, and `response` payloads, so callers don't repeat this logic.
 */
function extractAiText(raw: unknown): string {
	if (typeof raw === 'string') {
		return raw;
	}

	if (!raw || typeof raw !== 'object') {
		return '';
	}

	const payload = raw as Record<string, unknown>;
	const choice = Array.isArray(payload.choices) ? (payload.choices[0] as Record<string, unknown>) : undefined;
	const message = (choice?.message as Record<string, unknown> | undefined) ?? undefined;

	return (
		(message?.content as string) ??
		(choice?.text as string) ??
		(payload.result as string) ??
		(payload.completion as string) ??
		(payload.response as string) ??
		''
	);
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
 * Handle the llm command
 */
async function handleLlmCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
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

		const model = (env.AI_MODEL || DEFAULT_AI_MODEL) as keyof AiModels;

		// The AI call
		const result = await env.AI.run(model, { messages });

		const aiText = extractAiText(result);

		if (!aiText) {
			console.error('Invalid AI response structure:', JSON.stringify(result));
			throw new Error('Invalid AI response format');
		}

		// Create workflow to update the message
		await env.WORKFLOW.create({
			id: crypto.randomUUID(),
			params: {
				application_id: interaction.application_id,
				token: interaction.token,
				content: aiText,
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
			case 'llm':
				return handleLlmCommand(interaction, env, ctx);

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

		// Reject stale requests to mitigate replay attacks. `verifyKey` signs
		// `timestamp + body` but never checks the timestamp's age itself.
		const requestTimestamp = Math.trunc(Date.now() / 1000);
		const providedTimestamp = Number(timestamp);
		if (!Number.isInteger(providedTimestamp) || Math.abs(requestTimestamp - providedTimestamp) > SIGNATURE_TIMESTAMP_TOLERANCE_SECONDS) {
			return new Response('Request timestamp is outside the allowed window', { status: 401 });
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
			// Log the real error; return a generic body so internals aren't leaked.
			console.error('Error processing request:', error);
			return new Response('Internal server error', { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
