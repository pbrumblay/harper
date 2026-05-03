'use strict';
const envMngr = require('../environment/environmentManager.js');
const terms = require('../../utility/hdbTerms.js');
const { RecordEncoder } = require('../../resources/RecordEncoder.js');
envMngr.initSync();

const LMDB_CACHING = envMngr.get(terms.CONFIG_PARAMS.STORAGE_CACHING) !== false;

/**
 * Defines how a DBI will be created/opened
 */
class OpenDBIObject {
	/**
	 * @param {Boolean} dupSort - if the dbi allows duplicate keys
	 * @param {Boolean} [isPrimary] - if the dbi is the primary dbi
	 */
	constructor(dupSort, isPrimary = false) {
		/** @type {boolean} */
		this.dupSort = dupSort === true;
		/** @type {"string" | "json" | "binary" | "msgpack" | "ordered-binary"} */
		this.encoding = dupSort ? 'ordered-binary' : 'msgpack';
		/** @type {boolean} */
		this.useVersions = isPrimary;
		/** @type {Symbol} */
		this.sharedStructuresKey = Symbol.for('structures');
		/** @type {any} */
		this.compression = undefined;
		if (isPrimary) {
			this.cache = LMDB_CACHING && { validated: true };
			this.randomAccessStructure = true;
			this.freezeData = true;
			this.encoder = { Encoder: RecordEncoder };
		}
	}
}

exports.OpenDBIObject = OpenDBIObject;
