'use strict';

const assert = require('node:assert/strict');
const { setupTestDBPath } = require('../../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');

// Parse-level behavior of the `@embed` directive: auto-HNSW attach and the
// loud-fail when paired with a conflicting (non-HNSW) explicit index.
describe('@embed directive parsing', () => {
	before(() => setupTestDBPath());

	it('auto-attaches an HNSW index when @embed has no explicit @indexed', async () => {
		await loadGQLSchema(`type EmbedAuto @table {
			id: ID @primaryKey
			content: String
			embedding: [Float] @embed(source: "content", model: "default")
		}`);
		const attr = tables.EmbedAuto.attributes.find((a) => a.name === 'embedding');
		assert.equal(attr.indexed?.type, 'HNSW', 'embedding should be auto-HNSW-indexed');
	});

	it('accepts @embed with an explicit HNSW @indexed', async () => {
		await assert.doesNotReject(
			loadGQLSchema(`type EmbedHnsw @table {
				id: ID @primaryKey
				content: String
				embedding: [Float] @embed(source: "content", model: "default") @indexed(type: "HNSW")
			}`)
		);
	});

	it('rejects @embed on a non-array (scalar) attribute type (loud-fail, 400)', async () => {
		await assert.rejects(
			loadGQLSchema(`type EmbedScalar @table {
				id: ID @primaryKey
				content: String
				embedding: String @embed(source: "content", model: "default")
			}`),
			(err) => {
				assert.equal(err.statusCode, 400, 'should be a client error');
				assert.match(err.message, /array/, 'message should name the array-type requirement');
				return true;
			}
		);
	});

	it('rejects @embed combined with a non-HNSW @indexed (loud-fail, 400)', async () => {
		await assert.rejects(
			loadGQLSchema(`type EmbedBtree @table {
				id: ID @primaryKey
				content: String
				embedding: [Float] @embed(source: "content", model: "default") @indexed(type: "BTREE")
			}`),
			(err) => {
				assert.equal(err.statusCode, 400, 'should be a client error');
				assert.match(err.message, /HNSW/, 'message should name the HNSW requirement');
				return true;
			}
		);
	});
});
