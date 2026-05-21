'use strict';

const assert = require('node:assert/strict');
const { bootstrapModels } = require('#src/resources/models/bootstrap');
const {
	clearRegistry,
	resolveEmbedding,
	resolveGenerative,
	ModelBackendNotFoundError,
} = require('#src/resources/models/backendRegistry');

describe('bootstrapModels', () => {
	beforeEach(() => clearRegistry());

	it('is a no-op when rootConfig is undefined/null', () => {
		bootstrapModels(undefined);
		bootstrapModels(null);
		assert.throws(() => resolveEmbedding('default'), ModelBackendNotFoundError);
	});

	it('is a no-op when rootConfig.models is absent', () => {
		bootstrapModels({});
		assert.throws(() => resolveEmbedding('default'), ModelBackendNotFoundError);
	});

	it('registers an ollama embedding entry under its logical name', () => {
		bootstrapModels({
			models: {
				embedding: {
					fast: { backend: 'ollama', host: 'localhost:11434', model: 'nomic-embed-text' },
				},
			},
		});
		const backend = resolveEmbedding('fast');
		assert.strictEqual(backend.name, 'ollama');
	});

	it('registers an ollama generative entry under its logical name', () => {
		bootstrapModels({
			models: {
				generative: {
					default: { backend: 'ollama', host: 'localhost:11434', model: 'llama3.2' },
				},
			},
		});
		const backend = resolveGenerative('default');
		assert.strictEqual(backend.name, 'ollama');
	});

	it('skips entries with unknown backend without throwing', () => {
		bootstrapModels({
			models: {
				embedding: {
					default: { backend: 'magic-backend', model: 'm' },
				},
				generative: {
					default: { backend: 'ollama', model: 'm' },
				},
			},
		});
		// The ollama entry on generative still registered.
		assert.strictEqual(resolveGenerative('default').name, 'ollama');
		// The unknown-backend embedding entry was skipped, not registered.
		assert.throws(() => resolveEmbedding('default'), ModelBackendNotFoundError);
	});

	it('skips entries that are not objects', () => {
		bootstrapModels({
			models: {
				embedding: {
					bad: 'just a string',
					good: { backend: 'ollama', model: 'm' },
				},
			},
		});
		assert.strictEqual(resolveEmbedding('good').name, 'ollama');
		assert.throws(() => resolveEmbedding('bad'), ModelBackendNotFoundError);
	});

	it('skips entries missing a backend field', () => {
		bootstrapModels({ models: { embedding: { x: { model: 'm' } } } });
		assert.throws(() => resolveEmbedding('x'), ModelBackendNotFoundError);
	});

	it('registers multiple logical names independently', () => {
		bootstrapModels({
			models: {
				generative: {
					default: { backend: 'ollama', host: 'a:1', model: 'mA' },
					fast: { backend: 'ollama', host: 'b:2', model: 'mB' },
				},
			},
		});
		assert.strictEqual(resolveGenerative('default').name, 'ollama');
		assert.strictEqual(resolveGenerative('fast').name, 'ollama');
	});
});
