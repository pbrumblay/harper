'use strict';

const assert = require('assert');
const rewire = require('rewire');
const getDatabases = require('#js/resources/databases');
const rw_getDatabases = rewire('#js/resources/databases');
const system_information = require('#js/utility/environment/systemInformation');
const rw_system_information = rewire('#js/utility/environment/systemInformation');
const env_mgr = require('#js/utility/environment/environmentManager');

const { SystemInformationRequest } = system_information;

const TableSizeObject = require('#js/dataLayer/harperBridge/lmdbBridge/lmdbUtility/TableSizeObject');

let rw_getHDBProcessInfo;

const PROCESS_INFO = {
	core: [
		{
			pid: 30980,
			parentPid: 1866,
			name: 'node',
			pcpu: 0,
			pcpuu: 0,
			pcpus: 0,
			pmem: 0.5,
			priority: 19,
			mem_vsz: 734698316,
			mem_rss: 85236,
			nice: 0,
			started: '2020-04-15 13:41:25',
			state: 'sleeping',
			tty: '',
			user: 'kyle',
			command: 'node',
			params: '/home/kyle/WebstormProjects/harperdb/server/operationsServer.js',
			path: '/usr/bin',
		},
		{
			pid: 30991,
			parentPid: 30980,
			name: 'node',
			pcpu: 0,
			pcpuu: 0,
			pcpus: 0,
			pmem: 0.5,
			priority: 19,
			mem_vsz: 630040924,
			mem_rss: 85304,
			nice: 0,
			started: '2020-04-15 13:41:25',
			state: 'sleeping',
			tty: '',
			user: 'kyle',
			command: 'node',
			params: '/home/kyle/WebstormProjects/harperdb/server/operationsServer.js',
			path: '/usr/bin',
		},
		{
			pid: 30997,
			parentPid: 30980,
			name: 'node',
			pcpu: 4.183266932270916,
			pcpuu: 2.589641434262948,
			pcpus: 1.593625498007968,
			pmem: 0.5,
			priority: 19,
			mem_vsz: 629976800,
			mem_rss: 92576,
			nice: 0,
			started: '2020-04-15 13:41:25',
			state: 'sleeping',
			tty: '',
			user: 'kyle',
			command: 'node',
			params: '/home/kyle/WebstormProjects/harperdb/server/operationsServer.js',
			path: '/usr/bin',
		},
	],
	clustering: [
		{
			pid: 31013,
			parentPid: 30980,
			name: 'node',
			pcpu: 0,
			pcpuu: 0,
			pcpus: 0,
			pmem: 0.2,
			priority: 19,
			mem_vsz: 606288,
			mem_rss: 40608,
			nice: 0,
			started: '2020-04-15 13:41:26',
			state: 'sleeping',
			tty: '',
			user: 'kyle',
			command: 'node',
			params: '/home/kyle/WebstormProjects/harperdb/server/socketcluster/Server.js',
			path: '/usr/bin',
		},
		{
			pid: 31024,
			parentPid: 31013,
			name: 'node',
			pcpu: 0,
			pcpuu: 0,
			pcpus: 0,
			pmem: 0.2,
			priority: 19,
			mem_vsz: 670884,
			mem_rss: 38628,
			nice: 0,
			started: '2020-04-15 13:41:26',
			state: 'sleeping',
			tty: '',
			user: 'kyle',
			command: 'node',
			params:
				'/home/kyle/WebstormProjects/harperdb/server/socketcluster/broker.js {"id":0,"debug":null,"socketPath":"/tmp/socketcluster/socket_server_61253374f8/b0","expiryAccuracy":5000,"downgradeToUser":false,"brokerControllerPath":"/home/kyle/WebstormProjects/harperdb/server/socketcluster/broker.js","processTermTimeout":10000}',
			path: '/usr/bin',
		},
		{
			pid: 31031,
			parentPid: 31013,
			name: 'node',
			pcpu: 0,
			pcpuu: 0,
			pcpus: 0,
			pmem: 0.1,
			priority: 19,
			mem_vsz: 563692,
			mem_rss: 29692,
			nice: 0,
			started: '2020-04-15 13:41:26',
			state: 'sleeping',
			tty: '',
			user: 'kyle',
			command: 'node',
			params: '/home/kyle/WebstormProjects/harperdb/node_modules/socketcluster/default-workercluster-controller.js',
			path: '/usr/bin',
		},
		{
			pid: 31038,
			parentPid: 31031,
			name: 'node',
			pcpu: 0,
			pcpuu: 0,
			pcpus: 0,
			pmem: 0.4,
			priority: 19,
			mem_vsz: 855840,
			mem_rss: 70820,
			nice: 0,
			started: '2020-04-15 13:41:26',
			state: 'sleeping',
			tty: '',
			user: 'kyle',
			command: 'node',
			params: '/home/kyle/WebstormProjects/harperdb/server/socketcluster/worker/ClusterWorker.js',
			path: '/usr/bin',
		},
	],
};

const EXPECTED_PROPERTIES = {
	system: [
		'platform',
		'distro',
		'release',
		'codename',
		'kernel',
		'arch',
		'hostname',
		'fqdn',
		'node_version',
		'npm_version',
	],
	time: ['current', 'uptime', 'timezone', 'timezoneName'],
	cpu: [
		'manufacturer',
		'brand',
		'vendor',
		'speed',
		'cores',
		'physicalCores',
		'efficiencyCores',
		'performanceCores',
		'processors',
		'cpu_speed',
		'current_load',
		'flags',
		'virtualization',
	],
	cpu_cpu_speed: ['min', 'max', 'avg', 'cores'],
	cpu_current_load: [
		'avgLoad',
		'currentLoad',
		'currentLoadUser',
		'currentLoadSystem',
		'currentLoadNice',
		'currentLoadIdle',
		'currentLoadIrq',
		'cpus',
	],
	cpu_current_load_cpus: ['load', 'loadUser', 'loadSystem', 'loadNice', 'loadIdle', 'loadIrq'],
	memory: [
		'total',
		'free',
		'used',
		'active',
		'available',
		'swaptotal',
		'swapused',
		'swapfree',
		'rss',
		'heapUsed',
		'heapTotal',
		'arrayBuffers',
		'dirty',
		'external',
		'reclaimable',
		'writeback',
	],
	disk: ['io', 'read_write', 'size'],
	disk_io: ['rIO', 'wIO', 'tIO'],
	disk_read_write: ['rx', 'wx', 'tx'],
	disk_size: ['fs', 'rw', 'type', 'size', 'used', 'use', 'mount', 'available'],
	network: ['default_interface', 'latency', 'interfaces', 'stats', 'connections'],
	network_latency: [], // these should NOT return anything unless enabled
	network_interfaces: [],
	network_stats: [],
	harperdb_processes: ['core'],
	harperdb_processes_core: [
		'pid',
		'parentPid',
		'name',
		'pcpu',
		'pcpuu',
		'pcpus',
		'pmem',
		'priority',
		'mem_vsz',
		'mem_rss',
		'nice',
		'started',
		'state',
		'tty',
		'user',
		'command',
		'params',
		'path',
	],
	all: ['system', 'time', 'cpu', 'memory', 'disk', 'network', 'harperdb_processes', 'table_size'],
};

describe('test systemInformation module', () => {
	let rw_getTableSize;
	before(() => {
		rw_getHDBProcessInfo = rw_system_information.__set__('getHDBProcessInfo', async () => {
			return PROCESS_INFO;
		});
		rw_getTableSize = rw_system_information.__set__('getTableSize', async () => {
			return [];
		});

		env_mgr.setProperty('clustering_enabled', false);
	});

	after(() => {
		rw_getHDBProcessInfo();
		rw_getTableSize();
	});

	it('test getSystemInformation function', async () => {
		const results = await system_information.getSystemInformation();
		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.system.sort());
	}).timeout(5000);

	it('call getSystemInformation 2nd time to test cache', async () => {
		const results = await system_information.getSystemInformation();
		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.system.sort());
	});

	it('test getTimeInfo function', () => {
		const results = system_information.getTimeInfo();
		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.time.sort());
	});

	it('test getCPUInfo function', async () => {
		const results = await system_information.getCPUInfo();
		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.cpu.sort());
		assert.deepEqual(Object.keys(results.cpu_speed).sort(), EXPECTED_PROPERTIES.cpu_cpu_speed.sort());
		assert.deepEqual(Object.keys(results.current_load).sort(), EXPECTED_PROPERTIES.cpu_current_load.sort());
		assert(Array.isArray(results.current_load.cpus));
		assert.deepEqual(
			Object.keys(results.current_load.cpus[0]).sort(),
			EXPECTED_PROPERTIES.cpu_current_load_cpus.sort()
		);
	});

	it('test getMemoryInfo function', async () => {
		const results = await system_information.getMemoryInfo();
		assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.memory.sort());
	});

	it('test getDiskInfo function', async () => {
		const orig = process.env.OPERATIONSAPI_SYSINFO_DISK;
		try {
			process.env.OPERATIONSAPI_SYSINFO_DISK = '1';
			const results = await system_information.getDiskInfo();
			assert.deepEqual(Object.keys(results).sort(), EXPECTED_PROPERTIES.disk.sort());
			assert.deepEqual(Object.keys(results.io).sort(), EXPECTED_PROPERTIES.disk_io.sort());
			assert.deepEqual(Object.keys(results.read_write).sort(), EXPECTED_PROPERTIES.disk_read_write.sort());
			assert(Array.isArray(results.size));
			if (results.size.length > 0) {
				assert.deepEqual(Object.keys(results.size[0]).sort(), EXPECTED_PROPERTIES.disk_size.sort());
			}
		} finally {
			if (orig === undefined) {
				delete process.env.OPERATIONSAPI_SYSINFO_DISK;
			} else {
				process.env.OPERATIONSAPI_SYSINFO_DISK = orig;
			}
		}
	});

	// it('test getNetworkInfo function', async () => {
	// 	let results = await system_information.getNetworkInfo();

	// 	Object.keys(results).forEach((key) => {
	// 		assert(EXPECTED_PROPERTIES.network.indexOf(key) >= 0);
	// 	});

	// 	EXPECTED_PROPERTIES.network.forEach((property) => {
	// 		assert(results.hasOwnProperty(property));
	// 	});

	// 	Object.keys(results.latency).forEach((key) => {
	// 		assert(EXPECTED_PROPERTIES.network_latency.indexOf(key) >= 0);
	// 	});

	// 	EXPECTED_PROPERTIES.network_latency.forEach((property) => {
	// 		assert(results.latency.hasOwnProperty(property));
	// 	});

	// 	assert(Array.isArray(results.interfaces));

	// 	EXPECTED_PROPERTIES.network_interfaces.forEach((property) => {
	// 		assert(results.interfaces[0].hasOwnProperty(property));
	// 	});

	// 	assert(Array.isArray(results.stats));

	// 	EXPECTED_PROPERTIES.network_stats.forEach((property) => {
	// 		assert(results.stats[0].hasOwnProperty(property));
	// 	});
	// });

	// it('test getHDBProcessInfo function', async () => {
	// 	let results = await rw_system_information.getHDBProcessInfo();

	// 	Object.keys(results).forEach((key) => {
	// 		assert(EXPECTED_PROPERTIES.harperdb_processes.indexOf(key) >= 0);
	// 	});

	// 	EXPECTED_PROPERTIES.harperdb_processes.forEach((property) => {
	// 		assert(
	// 			results.hasOwnProperty(property),
	// 			`expected property "${property}" not found in ${JSON.stringify(results)}`
	// 		);
	// 	});
	// });

	// it('test systemInformation function fetch all attributes', async () => {
	// 	let op = new SystemInformationRequest();
	// 	let results = await rw_system_information.systemInformation(op);

	// 	EXPECTED_PROPERTIES.all.forEach((property) => {
	// 		assert(results.hasOwnProperty(property) && results[property] !== undefined);
	// 	});
	// }).timeout(10000);

	// it('test systemInformation function fetch some attributes', async () => {
	// 	let expected_attributes = ['time', 'memory'];

	// 	let op = new SystemInformationRequest(expected_attributes);
	// 	let results = await rw_system_information.systemInformation(op);

	// 	assert(results.time !== undefined, `results.time should be defined but it is ${JSON.stringify(results.time)}`);
	// 	assert(
	// 		results.memory !== undefined,
	// 		`results.memory should be defined but it is ${JSON.stringify(results.memory)}`
	// 	);
	// 	assert(
	// 		results.system === undefined,
	// 		`results.system should be undefined but it is ${JSON.stringify(results.system)}`
	// 	);
	// 	assert(results.cpu === undefined, `results.cpu should be undefined but it is ${JSON.stringify(results.cpu)}`);
	// 	assert(results.disk === undefined, `results.disk should be undefined but it is ${JSON.stringify(results.disk)}`);
	// 	assert(
	// 		results.network === undefined,
	// 		`results.network should be undefined but it is ${JSON.stringify(results.network)}`
	// 	);
	// 	assert(
	// 		results.harperdb_processes === undefined,
	// 		`results.harperdb_processes should be undefined but it is ${JSON.stringify(results.harperdb_processes)}`
	// 	);
	// });

	// it('test systemInformation function fetch all of the attributes', async () => {
	// 	let expected_attributes = EXPECTED_PROPERTIES.all;

	// 	let op = new SystemInformationRequest(expected_attributes);
	// 	let results = await rw_system_information.systemInformation(op);

	// 	EXPECTED_PROPERTIES.all.forEach((property) => {
	// 		assert(results.hasOwnProperty(property) && results[property] !== undefined);
	// 	});
	// }).timeout(10000);
});

describe('getHDBProcessInfo()', () => {
	it('test getHDBProcessInfo function', async () => {
		// FYI: calling `getHDBProcessInfo()` will output a warning to stderr if Harper is not
		// running and the results will essentially be empty, but that's ok
		const results = await system_information.getHDBProcessInfo();
		assert(results.hasOwnProperty('core'));
		assert(Array.isArray(results.core));
	});
});

// describe('test getTableSize function', () => {
// 	const RETURN_SCHEMA = {
// 		dev: {
// 			dog: {
// 				schema: 'dev',
// 				name: 'dog',
// 				hash_attribute: 'id',
// 			},
// 			breed: {
// 				schema: 'dev',
// 				name: 'breed',
// 				hash_attribute: 'breed_id',
// 			},
// 		},
// 		prod: {
// 			customers: {
// 				schema: 'prod',
// 				name: 'customers',
// 				hash_attribute: 'customer_id',
// 			},
// 		},
// 		test: {},
// 	};
// 	let rw_schema_describe;
// 	let rw_lmdb_get_table_size;
// 	before(() => {
// 		rw_schema_describe = rw_system_information.__set__('schemaDescribe', {
// 			describeAll: async () => RETURN_SCHEMA,
// 		});

// 		rw_lmdb_get_table_size = rw_system_information.__set__('lmdbGetTableSize', async (table_object) => {
// 			return new TableSizeObject(table_object.schema, table_object.name, 4096, 0, 0, 4096);
// 		});
// 	});

// 	after(() => {
// 		rw_schema_describe();
// 		rw_lmdb_get_table_size();
// 	});

// 	it('test function', async () => {
// 		let expected = [
// 			new TableSizeObject('dev', 'dog', 4096, 0, 0, 4096),
// 			new TableSizeObject('dev', 'breed', 4096, 0, 0, 4096),
// 			new TableSizeObject('prod', 'customers', 4096, 0, 0, 4096),
// 		];

// 		let results = await rw_system_information.getTableSize();
// 		assert.deepStrictEqual(results, expected);
// 	});
// });
