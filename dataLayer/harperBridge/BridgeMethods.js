'use strict';

/**
 * BridgeMethods Class provides a framework for all HarperBridge method classes
 */

class BridgeMethods {
	/** @param {...any} args */
	createSchema(...args) {
		throw new Error('createSchema bridge method is not defined');
	}

	/** @param {...any} args */
	dropSchema(...args) {
		throw new Error('dropSchema bridge method is not defined');
	}

	/** @param {...any} args */
	createTable(...args) {
		throw new Error('createTable bridge method is not defined');
	}

	/** @param {...any} args */
	dropTable(...args) {
		throw new Error('dropTable bridge method is not defined');
	}

	/** @param {...any} args */
	createRecords(...args) {
		throw new Error('createRecords bridge method is not defined');
	}

	/** @param {...any} args */
	updateRecords(...args) {
		throw new Error('updateRecords bridge method is not defined');
	}

	/** @param {...any} args */
	async upsertRecords(...args) {
		throw new Error('upsertRecords bridge method is not defined');
	}

	/** @param {...any} args */
	deleteRecords(...args) {
		throw new Error('deleteRecords bridge method is not defined');
	}

	/** @param {...any} args */
	createAttribute(...args) {
		throw new Error('createAttribute bridge method is not defined');
	}

	/** @param {...any} args */
	dropAttribute(...args) {
		throw new Error('dropAttribute bridge method is not defined');
	}

	/** @param {...any} args */
	searchByConditions(...args) {
		throw new Error('searchByConditions bridge method is not defined');
	}

	/** @param {...any} args */
	searchByHash(...args) {
		throw new Error('searchByHash bridge method is not defined');
	}

	/** @param {...any} args */
	searchByValue(...args) {
		throw new Error('searchByValue bridge method is not defined');
	}

	/** @param {...any} args */
	getDataByHash(...args) {
		throw new Error('getDataByHash bridge method is not defined');
	}

	/** @param {...any} args */
	async getDataByValue(...args) {
		throw new Error('getDataByValue bridge method is not defined');
	}

	/** @param {...any} args */
	async deleteRecordsBefore(...args) {
		throw new Error('deleteRecordsBefore bridge method is not defined');
	}

	/** @param {...any} args */
	async deleteAuditLogsBefore(...args) {
		throw new Error('deleteAuditLogsBefore bridge method is not defined');
	}

	/** @param {...any} args */
	async deleteTransactionLogsBefore(...args) {
		throw new Error('deleteTransactionLogsBefore bridge method is not defined');
	}

	/** @param {...any} args */
	async readAuditLog(...args) {
		throw new Error('readAuditLog bridge method is not defined');
	}
}

module.exports = BridgeMethods;
