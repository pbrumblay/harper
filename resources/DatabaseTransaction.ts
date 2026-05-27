import { cleanupUnusedBlobs } from './blob.ts';
import { Transaction as LMDBTransaction } from 'lmdb';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility.ts';
import { ServerError } from '../utility/errors/hdbError.ts';
import * as harperLogger from '../utility/logging/harper_logger.ts';
import type { Context, Id } from './ResourceInterface.ts';
import * as envMngr from '../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import { convertToMS } from '../utility/common_utils.ts';
import { when } from '../utility/when.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { Transaction as RocksTransaction, type Store as RocksStore } from '@harperfast/rocksdb-js';
import type { RootDatabaseKind } from './databases.ts';
import type { Entry } from './RecordEncoder.ts';

const trackedTxns = new Set<DatabaseTransaction>();
const MAX_OUTSTANDING_TXN_DURATION = convertToMS(envMngr.get(CONFIG_PARAMS.STORAGE_MAXTRANSACTIONQUEUETIME)) || 45000; // Allow write transactions to be queued for up to 25 seconds before we start rejecting them
const DEBUG_LONG_TXNS = envMngr.get(CONFIG_PARAMS.STORAGE_DEBUGLONGTRANSACTIONS);
export const TRANSACTION_STATE = {
	CLOSED: 0, // the transaction has been committed or aborted and can no longer be used for writes (if read txn is active, it can be used for reads)
	OPEN: 1, // the transaction is open and can be used for reads and writes
	LINGERING: 2, // the transaction has completed a read, but can be used for immediate writes
};
const MAX_RETRIES = 40;
let outstandingCommit, outstandingCommitStart;
let confirmReplication;
export function replicationConfirmation(callback) {
	confirmReplication = callback;
}
let txnExpiration = envMngr.get(CONFIG_PARAMS.STORAGE_MAXTRANSACTIONOPENTIME) ?? 30000;

class StartedTransaction extends Error {}

type MaybePromise<T> = T | Promise<T>;

export type CommitOptions = {
	doneWriting?: boolean;
	timestamp?: number;
	retries?: number;
	flush?: boolean;
	transaction?: RocksTransaction;
};

type ReadTransaction = (LMDBTransaction | RocksTransaction) & {
	openTimer?: number;
	retryRisk?: number;
	isDone?: boolean;
	isCommitted?: boolean;
};

export type TransactionWrite = {
	key: Id;
	store: any; // using any here because of circular dependency and complex RootDatabaseKind
	invalidated?: boolean;
	entry?: Partial<Entry>;
	before?: () => void | Promise<void>;
	beforeIntermediate?: () => void | Promise<void>;
	commit?: (txnTime: number, existingEntry: Partial<Entry>, retry: boolean, transaction: any) => void;
	validate?: (txnTime: number) => void | false | Promise<void | false>;
	fullUpdate?: boolean;
	saved?: boolean;
	deferSave?: boolean;
	// Set in `save()` when validate is async (`@embed`) and the commit phase is deferred to
	// `commit()` Phase 3 — preserves `writes[]` order rather than embedder-resolution order
	// for multi-write @embed transactions.
	deferredCommit?: boolean;
	deferredTxnTime?: number;
	deferredTransaction?: any;
	nodeName?: string;
	nodeId?: number;
	promise?: Promise<any>;
	result?: any;
	// blobs that were pre-saved as part of this write; used to clean up files if the commit is skipped or aborted
	savedBlobs?: Blob[];
	// the commit handler's most recent decision: true means it took an early-return that left savedBlobs unreferenced.
	// reset at the top of each commit-handler invocation so retries see a fresh state.
	skipped?: boolean;
};

type RocksTransactionWithRetry = RocksTransaction & { isRetry?: boolean };

export class DatabaseTransaction implements Transaction {
	#context: Context;
	writes: TransactionWrite[] = []; // the set of writes to commit if the conditions are met
	completions: Promise<void>[] = []; // the set of outstanding async operations to complete
	db: RootDatabaseKind;
	transaction: RocksTransactionWithRetry;
	readTxn: ReadTransaction;
	readTxnRefCount: number;
	readTxnsUsed: number;
	timeout: number;
	validated = 0;
	timestamp = 0;
	retries = 0;
	declare next: DatabaseTransaction;
	declare stale: boolean;
	declare startedFrom?: {
		resourceName: string;
		method: string;
	};
	declare stackTraces?: StartedTransaction[];
	overloadChecked: boolean;
	open = TRANSACTION_STATE.OPEN;
	replicatedConfirmation: number;

	getReadTxn(): ReadTransaction {
		this.readTxnRefCount = (this.readTxnRefCount || 0) + 1;
		this.timeout = txnExpiration; // reset the timeout
		if (this.transaction) {
			if ((this.transaction as any).openTimer) (this.transaction as any).openTimer = 0;
			return this.transaction;
		}
		if (this.open !== TRANSACTION_STATE.OPEN) return; // can not start a new read transaction as there is no future commit that will take place, just have to allow the read to latest database state

		this.transaction = new RocksTransaction(this.db.store);

		if (this.timestamp) {
			this.transaction.setTimestamp(this.timestamp);
		}

		this.readTxnsUsed = 1;
		if (DEBUG_LONG_TXNS) {
			this.stackTraces = [new StartedTransaction()];
		}
		if ((this.transaction as any).openTimer) (this.transaction as any).openTimer = 0;
		trackedTxns.add(this);
		return this.transaction;
	}

	useReadTxn() {
		const readTxn = this.getReadTxn();
		if (DEBUG_LONG_TXNS) this.stackTraces.push(new StartedTransaction());
		this.readTxnsUsed++;
		return readTxn;
	}

	doneReadTxn() {
		if (!this.transaction) return;
		if (--this.readTxnsUsed === 0) {
			trackedTxns.delete(this);
			if (this.open === TRANSACTION_STATE.LINGERING) {
				// if we have lingering writes, we have to call commit to finish them
				this.commit();
			} else {
				this.transaction?.abort();
				this.transaction = null;
			}
		}
	}

	disregardReadTxn(): void {
		if (--this.readTxnRefCount === 0 && this.readTxnsUsed === 1) {
			this.doneReadTxn();
		}
	}

	checkOverloaded() {
		if (
			outstandingCommit &&
			!this.overloadChecked &&
			performance.now() - outstandingCommitStart > MAX_OUTSTANDING_TXN_DURATION
		) {
			throw new ServerError('Outstanding write transactions have too long of queue, please try again later', 503);
		}
		this.overloadChecked = true; // only check this once, don't interrupt ongoing transactions that have already made writes
	}

	addWrite(operation: TransactionWrite) {
		this.writes.push(operation);
		if (!operation.deferSave) {
			// Setting saved to false means to defer saving
			const saveResult: any = this.save(operation);
			if (saveResult?.then) {
				// When the transaction is already committed (immediateCommit path), save() returns
				// the commit promise. Propagate it so callers can await the actual write being
				// committed rather than resolving before it is durable.
				return saveResult.then(() => operation);
			}
		}
		return operation;
	}

	save(operation: TransactionWrite, transaction?: RocksTransaction, reloadEntry = false) {
		let txnTime = this.timestamp;
		transaction ??= this.transaction;
		let immediateCommit = false;
		if (!transaction) {
			transaction = new RocksTransaction(operation.store.store as RocksStore);
			if (operation.store.rootStore !== this.db.rootStore) {
				harperLogger.warn?.('Created new transaction in save, but the store does match existing store', transaction.id);
			}
			if (this.open === TRANSACTION_STATE.OPEN) {
				this.transaction = transaction;
			} else {
				// if it is closed, we have to immediately commit, using our immediate transaction
				immediateCommit = true;
			}
			if (txnTime) {
				transaction.setTimestamp(txnTime);
			}
		} else {
		}
		if (this.retries > 0) {
			// This marks the Rocks transaction as a retry so we don't write the transaction log again
			(transaction as any).isRetry = true;
		}
		if (!txnTime) txnTime = this.timestamp = transaction.getTimestamp();
		if (reloadEntry || operation.entry === undefined) {
			operation.entry = operation.store.getEntry(operation.key, { transaction });
		}
		// Run `before` / `beforeIntermediate` only on the first save (the original code
		// scoped them inside the `if (!operation.saved)` block); on retry, only `commit`
		// re-fires. `runCommit` is always called.
		const runBeforeAndCommit = () => {
			let result: Promise<void> = operation.before?.() as Promise<void>;
			if (result?.then) this.completions.push(result);
			result = operation.beforeIntermediate?.() as Promise<void>;
			if (result?.then) this.completions.push(result);
			operation.commit(txnTime, operation.entry, this.retries > 0, transaction);
			if (immediateCommit) {
				return this.commit({ transaction }); // immediately commit if the harper transaction is closed
			}
		};
		if (!operation.saved) {
			operation.saved = true;
			// `validate` may be async (the `@embed` write-time hook returns a promise for the
			// embedder HTTP call and mutates `recordUpdate` in place). Two async-validate paths:
			//
			//   - `immediateCommit` (single-write addWrite-immediate path used by non-`deferSave`
			//     writes when no `this.transaction` is open): chain the full lifecycle inside
			//     the validate `.then` since there's no enclosing `commit()` iteration to
			//     orchestrate ordering.
			//   - typical `deferSave` path (`commit()` iterates `writes[]` and calls save on
			//     each): mark the write `deferredCommit` and defer `before` / `beforeIntermediate`
			//     / `commit` to `commit()` so the per-write commit phase runs in `writes[]` order,
			//     not in embedder-resolution order. Multiple async @embed writes in one txn (e.g.
			//     batch put, or cache-population sourceWrite + a user-write in the same txn)
			//     would otherwise commit out of submission order — same-key last-write-wins,
			//     audit order, and subscription event order all break.
			const validateResult: any = operation.validate?.(txnTime);
			if (validateResult?.then) {
				if (immediateCommit) {
					return validateResult.then(
						(res: any) => {
							if (res === false) {
								operation.commit = () => {};
								return this.commit({ transaction });
							}
							return runBeforeAndCommit();
						},
						(error: any) => {
							// Embedder rejected — release the read txn and clean up pre-saved blobs.
							this.abort();
							throw error;
						}
					);
				}
				operation.deferredCommit = true;
				operation.deferredTxnTime = txnTime;
				operation.deferredTransaction = transaction;
				return validateResult.then((res: any) => {
					if (res === false) {
						operation.commit = () => {};
						operation.deferredCommit = false;
					}
				});
			}
			if (validateResult === false) {
				operation.commit = () => {}; // noop if we try again
				return;
			}
			return runBeforeAndCommit();
		}
		// re-save (retry): only commit, do not re-fire before/beforeIntermediate
		operation.commit(txnTime, operation.entry, this.retries > 0, transaction);
		if (immediateCommit) {
			return this.commit({ transaction });
		}
	}

	/**
	 * Resolves with information on the timestamp and success of the commit
	 */
	commit(options: CommitOptions = {}): MaybePromise<CommitResolution> {
		let transaction = options.transaction ?? this.transaction; // we need to preserve this transaction as we might to resurrect it if we have to retry
		for (let i = 0; i < this.writes.length; i++) {
			let operation = this.writes[i];
			if (!operation || (this.retries === 0 && operation.saved)) continue;
			const saveResult: any = this.save(operation, transaction, i < this.validated);
			// If `save` returned a promise (async validate, e.g., the `@embed` hook),
			// fold it into the txn completions so the commit awaits before closing.
			if (saveResult?.then) this.completions.push(saveResult);
		}
		this.validated = this.writes.length;
		const completions = this.completions;
		if (completions.length > 0) this.completions = []; // reset
		// `closeTxn` is the original commit-completion logic, extracted so the in-order
		// Phase 3 (deferred commits for async-validate writes) can run BEFORE it.
		const closeTxn = (): MaybePromise<CommitResolution> => {
			if (this.writes.length > this.validated) {
				// check just in case we got any more transactions while we were waiting, if so just recursively continue to finish the additional writes now
				return this.commit(options);
			}
			this.open = TRANSACTION_STATE.CLOSED;
			let commitResolution: MaybePromise<void>;
			if (--this.readTxnsUsed > 0) {
				// we still have outstanding iterators using the transaction, we can't just commit/abort it, we will still
				// need to use it
				if (this.writes.length > 0) {
					// if there are outstanding writes, we have to call commit later to finish them
					this.open = TRANSACTION_STATE.LINGERING;
					/* TODO: This is not really the intended behavior though, we want to immediately commit writes, but continue to use
					 * the transaction, as there is likely existing references to the transaction in other parts of the codebase,
					 * particularly in the query iterator */
				}
				/*
				commitResolution =
					this.writes.length > 0
						? transaction?.commit({ renewAfterCommit: true }) // Try to use RocksDB's CommitAndTryCreateSnapshot
			: // don't abort, we still have outstanding reads to complete
							null;
				*/
			} else {
				// no more reads need to be performed, just commit/abort based if there are any writes
				trackedTxns.delete(this);
				this.transaction = null; // clear transaction so any further operations operate immediately
				if (transaction) {
					this.writes = this.writes.filter((write) => write); // filter out removed entries
					if (this.writes.length > 0) {
						commitResolution = transaction.commit();
					} else {
						try {
							commitResolution = transaction.abort();
						} catch {
							// The transaction has uncommitted writes that were already cleared from
							// this.writes by a concurrent immediate-commit path (e.g. writes made with
							// an explicitly-reused closed transaction). Those writes are handled by the
							// concurrent commit, so there is nothing left to do here.
						}
					}
				}
			}

			if (commitResolution) {
				if (!outstandingCommit) {
					outstandingCommit = commitResolution;
					outstandingCommitStart = performance.now();
					outstandingCommit
						// if `commitResolution` rejects with and `ERR_BUSY` error, the retry logic
						// will correct course, but the reject will still be propagated on the
						// `outstandingCommit` promise and needs to be caught and silenced
						.catch(() => {})
						.finally(() => {
							outstandingCommit = null;
						});
				}
				const completions = [];
				return commitResolution.then(
					() => {
						(transaction as any).onCommit?.();
						if (this.next) {
							completions.push(this.next.commit(options));
						}
						if (options?.flush) {
							completions.push(this.writes[0].store.flushed);
						}
						if (this.replicatedConfirmation) {
							// if we want to wait for replication confirmation, we need to track the transaction times
							// and when replication notifications come in, we count the number of confirms until we reach the desired number
							const databaseName = this.writes[0].store.rootStore.databaseName;
							const lastWrite = this.writes[this.writes.length - 1];
							if (confirmReplication && lastWrite) {
								completions.push(
									confirmReplication(
										databaseName,
										(lastWrite.store.getEntry(lastWrite.key) as any).version,
										this.replicatedConfirmation
									)
								);
							}
						}
						// commit succeeded; clean up files for any writes whose commit-handler took an early-return.
						// deferred until here so a retry that *would* have referenced the blob can flip skipped back to false first.
						for (const write of this.writes) {
							if (write?.skipped && write?.savedBlobs) cleanupUnusedBlobs(write.savedBlobs);
						}
						// now reset transactions tracking; this transaction be reused and committed again
						this.writes = [];
						if (this.#context?.resourceCache) this.#context.resourceCache = null;
						this.next = null;
						let txnTime = this.timestamp;
						this.timestamp = 0; // reset the timestamp as well
						return Promise.all(completions).then(() => {
							return {
								txnTime,
							};
						});
					},
					(error) => {
						if (error.code === 'ERR_BUSY') {
							// if the transaction failed due to concurrent changes, we need to retry. First record this as an increased risk of contention/retry
							// for future transactions
							this.retries++;
							harperLogger.debug?.('retrying', transaction.id, this.retries);
							if (this.retries > 2) {
								if (this.retries > MAX_RETRIES) {
									throw new ServerError(
										`After ${MAX_RETRIES} retries, unable to commit transaction, transaction is in conflict with ongoing writes`
									);
								}
								// start delaying, back off to try to space out transactions and avoid excessive conflicts
								return delay(this.retries * this.retries).then(() => this.commit({ transaction }));
							}
							return this.commit({ transaction }); // try again
						} else throw error;
					}
				);
			}
			for (const write of this.writes) {
				if (write?.skipped && write?.savedBlobs) cleanupUnusedBlobs(write.savedBlobs);
			}
			this.writes = [];
			if (this.#context?.resourceCache) this.#context.resourceCache = null;
			const txnResolution: CommitResolution = {
				txnTime: this.timestamp,
			};
			if (this.next) {
				// now run any other transactions
				options.timestamp = this.timestamp;
				const nextResolution = this.next?.commit(options);
				if ((nextResolution as any)?.then)
					return (nextResolution as any)?.then((nextResolution) => ({
						txnTime: this.timestamp,
						next: nextResolution,
					}));
				txnResolution.next = nextResolution as any;
			}
			return txnResolution;
		};
		return when(
			completions.length > 0 ? Promise.all(completions) : null,
			() => {
				// Phase 3 — in-order before/beforeIntermediate/commit for any writes whose
				// validate was async (`deferredCommit` set in save()). All validates have
				// settled by here (Phase 2 = Promise.all(completions) above), so each write's
				// recordUpdate has been mutated by its embedder. We iterate writes[] in order
				// so RocksDB sees writes in submission order, not embedder-resolution order.
				// Any before/beforeIntermediate promises raised here go to this.completions
				// and are awaited by Phase 4 before the txn closes.
				let phase3From = -1;
				for (const op of this.writes) {
					if (!op?.deferredCommit) continue;
					if (phase3From < 0) phase3From = this.completions.length;
					op.deferredCommit = false;
					let result: Promise<void> = op.before?.() as Promise<void>;
					if (result?.then) this.completions.push(result);
					result = op.beforeIntermediate?.() as Promise<void>;
					if (result?.then) this.completions.push(result);
					op.commit!(op.deferredTxnTime!, op.entry, this.retries > 0, op.deferredTransaction);
				}
				if (phase3From >= 0 && this.completions.length > phase3From) {
					// Phase 4 — await before/beforeIntermediate promises raised during Phase 3
					const phase3 = this.completions;
					this.completions = [];
					return when(Promise.all(phase3), closeTxn) as MaybePromise<CommitResolution>;
				}
				return closeTxn();
			},
			(error) => {
				// Validate failed (e.g., the `@embed` embedder rejected). Abort the txn so the
				// read txn is released and any pre-saved blobs are cleaned up before the error
				// propagates to the caller.
				this.abort();
				throw error;
			}
		) as MaybePromise<CommitResolution>;
	}
	abort(): void {
		while (this.readTxnsUsed > 0) this.doneReadTxn(); // release the read snapshot when we abort, we assume we don't need it
		this.open = TRANSACTION_STATE.CLOSED;
		for (const write of this.writes) {
			if (write?.savedBlobs) cleanupUnusedBlobs(write.savedBlobs);
		}
		// reset the transaction
		this.writes = [];
		if (this.#context?.resourceCache) this.#context.resourceCache = null;
	}
	directCommitSync(): void {
		trackedTxns.delete(this);
		this.transaction?.commitSync();
	}
	getContext() {
		return this.#context;
	}
	setContext(context) {
		this.#context = context;
	}
}
export interface CommitResolution {
	txnTime: number;
	next?: CommitResolution;
}
export interface Transaction {
	commit(options): MaybePromise<CommitResolution>;
	abort?(): any;
}

export class ImmediateTransaction extends DatabaseTransaction {
	isCommitting = false;
	constructor(db: RootDatabaseKind) {
		super();
		this.db = db;
	}
	save(...args: any[]): any {
		const transaction = args[0];
		if (this.isCommitting) {
			// if we are in the commit, do the save and force a reload so we get a read within the transaction
			super.save(transaction, null as any, true);
		} else {
			this.isCommitting = true;
			return when(this.commit(), () => {
				this.isCommitting = false;
			});
		}
	}

	declare _timestamp: number;
	// @ts-expect-error accessor overriding property
	get timestamp() {
		return this._timestamp || (this._timestamp = getNextMonotonicTime());
	}
	set timestamp(value: number) {
		this._timestamp = value;
	}
	getReadTxn(): any {
		return; // no transaction means read latest
	}
}

let timer;

function startMonitoringTxns() {
	timer = setInterval(function () {
		for (const txn of trackedTxns) {
			if (txn.timeout <= 0) {
				const url = (txn.getContext() as any)?.url;
				harperLogger.error(
					`Transaction was open too long and has been committed, from table: ${
						(txn.db as any)?.name + (url ? ' path: ' + url : '')
					}`,
					...(txn.startedFrom ? [`was started from ${txn.startedFrom.resourceName}.${txn.startedFrom.method}`] : []),
					...(DEBUG_LONG_TXNS ? ['starting stack trace', txn.stackTraces] : [])
				);
				// reset the transaction
				try {
					const result = txn.commit();
					if ((result as any)?.then) {
						(result as any).catch((error) => {
							harperLogger.debug?.(`Error committing timed out transaction: ${error.message}`);
						});
					}
				} catch (error) {
					harperLogger.debug?.(`Error committing timed out transaction: ${error.message}`);
				}
				txn.timeout = txnExpiration;
			} else {
				txn.timeout -= txnExpiration;
			}
		}
	}, txnExpiration).unref();
}

startMonitoringTxns();

export function setTxnExpiration(ms) {
	clearInterval(timer);
	txnExpiration = ms;
	startMonitoringTxns();
	return trackedTxns;
}
