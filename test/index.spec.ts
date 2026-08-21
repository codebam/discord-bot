import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Build a fully-typed env backed by mocked AI + Workflow bindings, plus the
 * private key needed to mint valid Discord request signatures.
 */
type CreateArgs = { id: string; params: { application_id: string; token: string; content: string } };

async function buildEnv(overrides: { aiRun?: () => Promise<unknown>; aiModel?: string } = {}) {
	const keypair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['verify', 'sign'])) as CryptoKeyPair;
	const rawPublic = new Uint8Array((await crypto.subtle.exportKey('raw', keypair.publicKey)) as ArrayBuffer);

	const create = vi.fn(async (_opts: CreateArgs) => ({}));
	const env = {
		DISCORD_PUBLIC_KEY: toHex(rawPublic),
		AI: { run: vi.fn(overrides.aiRun ?? (async () => ({ result: 'Hello from AI!' }))) },
		WORKFLOW: { create },
		...(overrides.aiModel ? { AI_MODEL: overrides.aiModel } : {}),
	};

	return { env, privateKey: keypair.privateKey };
}

/**
 * Mint a request signed the way Discord does: Ed25519 over `timestamp + body`.
 */
async function signedRequest(privateKey: CryptoKey, body: string, timestamp: string, overrides: HeadersInit = {}) {
	const encoder = new TextEncoder();
	const signed = new Uint8Array(encoder.encode(timestamp + body));
	const signature = toHex(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, signed)));

	return new IncomingRequest('https://discord.com/api/v10/interactions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Signature-Ed25519': signature,
			'X-Signature-Timestamp': timestamp,
			...overrides,
		},
		body,
	});
}

const now = () => String(Math.floor(Date.now() / 1000));

describe('discord-bot worker', () => {
	it('responds to a PING with a PONG', async () => {
		const { env, privateKey } = await buildEnv();
		const body = JSON.stringify({ type: 1 });
		const request = await signedRequest(privateKey, body, now());
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, env as never, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 1 });
	});

	it('rejects non-POST requests with 405', async () => {
		const { env } = await buildEnv();
		const request = new IncomingRequest('https://discord.com/api/v10/interactions', { method: 'GET' });
		const response = await worker.fetch(request, env as never, createExecutionContext());

		expect(response.status).toBe(405);
	});

	it('rejects requests missing signature headers with 401', async () => {
		const { env } = await buildEnv();
		const body = JSON.stringify({ type: 1 });
		const request = new IncomingRequest('https://discord.com/api/v10/interactions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
		});
		const response = await worker.fetch(request, env as never, createExecutionContext());

		expect(response.status).toBe(401);
	});

	it('rejects an invalid signature with 401', async () => {
		const { env } = await buildEnv();
		const { privateKey: otherKey } = await buildEnv();
		const realBody = JSON.stringify({ type: 1 });
		// Sign with a different key than the one the worker verifies against.
		const request = await signedRequest(otherKey, realBody, now());
		const response = await worker.fetch(request, env as never, createExecutionContext());

		expect(response.status).toBe(401);
	});

	it('rejects a stale (replayed) timestamp even with a valid signature', async () => {
		const { env, privateKey } = await buildEnv();
		const body = JSON.stringify({ type: 1 });
		const stale = String(Math.floor(Date.now() / 1000) - 3600);
		const request = await signedRequest(privateKey, body, stale);
		const response = await worker.fetch(request, env as never, createExecutionContext());

		expect(response.status).toBe(401);
	});

	it('llm command defers, then posts the AI text via the workflow', async () => {
		const { env, privateKey } = await buildEnv({ aiRun: async () => ({ result: 'two plus two is four' }) });
		const body = JSON.stringify({
			type: 2,
			application_id: '123',
			token: 'token',
			data: { name: 'llm', options: [{ name: 'question', value: 'what is 2+2?' }] },
		});
		const request = await signedRequest(privateKey, body, now());
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, env as never, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 5 });

		expect(env.AI.run).toHaveBeenCalledTimes(1);
		expect(env.WORKFLOW.create).toHaveBeenCalledWith(
			expect.objectContaining({ params: expect.objectContaining({ content: 'two plus two is four' }) }),
		);
	});

	it('llm command without a question returns an inline error message', async () => {
		const { env, privateKey } = await buildEnv();
		const body = JSON.stringify({
			type: 2,
			application_id: '123',
			token: 'token',
			data: { name: 'llm' },
		});
		const request = await signedRequest(privateKey, body, now());
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, env as never, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 4, data: { content: 'Please provide a question!' } });
		expect(env.WORKFLOW.create).not.toHaveBeenCalled();
	});

	it('unknown command returns "Unknown command"', async () => {
		const { env, privateKey } = await buildEnv();
		const body = JSON.stringify({
			type: 2,
			application_id: '123',
			token: 'token',
			data: { name: 'warp', options: [] },
		});
		const request = await signedRequest(privateKey, body, now());
		const response = await worker.fetch(request, env as never, createExecutionContext());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 4, data: { content: 'Unknown command: warp' } });
	});

	it('falls back to an error message if the AI returns no extractable text', async () => {
		const { env, privateKey } = await buildEnv({ aiRun: async () => ({}) });
		const body = JSON.stringify({
			type: 2,
			application_id: '123',
			token: 'token',
			data: { name: 'llm', options: [{ name: 'question', value: 'hi' }] },
		});
		const request = await signedRequest(privateKey, body, now());
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, env as never, ctx);
		await waitOnExecutionContext(ctx);

		expect(await response.json()).toEqual({ type: 5 });
		expect(env.WORKFLOW.create).toHaveBeenCalledWith(
			expect.objectContaining({
				params: expect.objectContaining({ content: 'Sorry, I encountered an error while processing your question.' }),
			}),
		);
	});
});
