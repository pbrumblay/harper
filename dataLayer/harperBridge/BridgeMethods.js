'use strict';

/**
 * BridgeMethods Class provides a framework for all HarperBridge method classes
 */

class BridgeMethods {
	/** @param {...an..._args */
	createSchema(..._args) {
		throw new Error('createSchema bridge method is not defined');
	}

	/** @param {...an..._args */
	dropSchema(..._args) {
		throw new Error('dropSchema bridge method is not defined');
	}

	/** @param {...an..._args */
	createTable(..._args) {
		throw new Error('createTable bridge method is not defined');
	}

	/** @param {...an..._args */
	dropTable(..._args) {
		throw new Error('dropTable bridge method is not defined');
	}

	/** @param {...an..._args */
	createRecords(..._args) {
		throw new Error('createRecords bridge method is not defined');
	}

	/** @param {...an..._args */
	updateRecords(..._args) {
		throw new Error('updateRecords bridge method is not defined');
	}

	/** @param {...an..._args */
	async upsertRecords(..._args) {
		throw new Error('upsertRecords bridge method is not defined');
	}

	/** @param {...an..._args */
	deleteRecords(..._args) {
		throw new Error('deleteRecords bridge method is not defined');
	}

	/** @param {...an..._args */
	createAttribute(..._args) {
		throw new Error('createAttribute bridge method is not defined');
	}

	/** @param {...an..._args */
	dropAttribute(..._args) {
		throw new Error('dropAttribute bridge method is not defined');
	}

	/** @param {...an..._args */
	searchByConditions(..._args) {
		throw new Error('searchByConditions bridge method is not defined');
	}

	/** @param {...an..._args */
	searchByHash(..._args) {
		throw new Error('searchByHash bridge method is not defined');
	}

	/** @param {...an..._args */
	searchByValue(..._args) {
		throw new Error('searchByValue bridge method is not defined');
	}

	/** @param {...an..._args */
	getDataByHash(..._args) {
		throw new Error('getDataByHash bridge method is not defined');
	}

	/** @param {...an..._args */
	async getDataByValue(..._args) {
		throw new Error('getDataByValue bridge method is not defined');
	}

	/** @param {...an..._args */
	async deleteRecordsBefore(..._args) {
		throw new Error('deleteRecordsBefore bridge method is not defined');
	}

	/** @param {...an..._args */
	async deleteAuditLogsBefore(..._args) {
		throw new Error('deleteAuditLogsBefore bridge method is not defined');
	}

	/** @param {...an..._args */
	async deleteTransactionLogsBefore(..._args) {
		throw new Error('deleteTransactionLogsBefore bridge method is not defined');
	}

	/** @param {...an..._args */
	async readAuditLog(..._args) {
		throw new Error('readAuditLog bridge method is not defined');
	}
}

module.exports = BridgeMethods;
