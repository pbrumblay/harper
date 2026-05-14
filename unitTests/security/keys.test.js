'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const fs = require('fs-extra');
const rewire = require('rewire');
const path = require('path');
const env_mgr = require('#js/utility/environment/environmentManager');
const keys = rewire('#js/security/keys');
const { generateSerialNumber } = require('#js/security/keys');
const config_utils = require('#js/config/configUtils');
const mkcert = require('mkcert');
const forge = require('node-forge');
const pki = forge.pki;

describe('Test keys module', () => {
	const sandbox = sinon.createSandbox();
	const test_dir = path.resolve(__dirname, '../envDir/keys-test-' + process.pid + '-' + Date.now());
	const test_cert_path = path.join(test_dir, 'test-certificate.pem');
	const test_ca_path = path.join(test_dir, 'test-ca.pem');
	const test_private_key_path = path.join(test_dir, 'test-private-key.pem');

	let update_config_value_stub;
	let test_private_key;
	let test_cert;
	let test_ca;
	let test_public_key;
	let actual_cert;
	let actual_ca;
	let root_path;

	before(async function () {
		this.timeout(10000);
		const uniqueOrg = 'Harper-Test-' + Date.now();
		const ca = await mkcert.createCA({
			organization: uniqueOrg,
			countryCode: 'USA',
			state: 'Colorado',
			locality: 'Denver',
			validity: 1,
		});

		let cert = await mkcert.createCert({
			domains: [uniqueOrg, '127.0.0.1', 'localhost', '::1'],
			validityDays: 1,
			ca,
		});

		test_private_key = cert.key;
		test_cert = cert.cert;
		test_ca = ca.cert;
		test_public_key = pki.certificateFromPem(ca.cert).publicKey;
		await fs.ensureDir(test_dir);
		await fs.writeFile(test_cert_path, test_cert);
		await fs.writeFile(test_private_key_path, test_private_key);
		await fs.writeFile(test_ca_path, test_ca);

		root_path = test_dir;
		sandbox.stub(config_utils, 'getConfigFromFile').callsFake((key) => {
			if (key === 'tls') return {
				certificate: test_cert_path,
				privateKey: test_private_key_path,
				certificateAuthority: test_ca_path
			};
			if (key === 'rootPath') return root_path;
			return undefined;
		});
		env_mgr.setHdbBasePath(root_path);
		env_mgr.setProperty('storage_path', path.join(test_dir, 'database'));
		
		const testUtils = require('../testUtils.js');
		testUtils.preTestPrep();
		testUtils.setupTestDBPath();
		
		const { resetDatabases, databases } = require('#src/resources/databases');
		resetDatabases();
		
		const mountHdb = require('#js/utility/mount_hdb').default;
		await mountHdb(test_dir);
		
		if (databases.system?.hdb_certificate) {
			await databases.system.hdb_certificate.clear();
		}

		keys.__set__('configuredCertsLoaded', false);
		keys.__set__('certificateTable', undefined);
		keys.__set__('privateKeys', new Map());
		
		await keys.loadCertificates();

		const all_certs = await keys.listCertificates();
		all_certs.forEach((cert) => {
			if (!cert.is_authority && cert?.details?.issuer?.includes(uniqueOrg)) {
				actual_cert = cert;
			} else if (cert.name.includes(uniqueOrg)) {
				actual_ca = cert;
			}
		});
	});

	afterEach(() => {
		sandbox.restore();
		sandbox.stub(config_utils, 'getConfigFromFile').callsFake((key) => {
			if (key === 'tls') return {
				certificate: test_cert_path,
				privateKey: test_private_key_path,
				certificateAuthority: test_ca_path
			};
			if (key === 'rootPath') return root_path;
			return undefined;
		});
	});

	after(async () => {
		sandbox.restore();
		await fs.remove(test_dir);
	});

	it('Test loadCertificates loads certs from config file', async () => {
		const all_certs = await keys.listCertificates();
		let private_key_pass = true;
		let cert_pass = false;
		let ca_pass = false;
		
		expect(actual_cert, 'actual_cert should be defined').to.exist;
		expect(actual_ca, 'actual_ca should be defined').to.exist;
		
		for (const cert of all_certs) {
			if (cert.certificate === test_private_key) {
				private_key_pass = false;
				break;
			}

			if (
				cert.name === actual_cert.name &&
				cert.certificate === actual_cert.certificate
			)
				cert_pass = true;

			if (
				cert.name === actual_ca.name &&
				cert.certificate === actual_ca.certificate
			)
				ca_pass = true;
		}

		expect(private_key_pass).to.be.true;
		expect(cert_pass).to.be.true;
		expect(ca_pass).to.be.true;
	});

	it('Test getReplicationCert returns the correct cert', async () => {
		const rep_cert = await keys.getReplicationCert();
		expect(rep_cert).to.exist;
		expect(rep_cert.name).to.equal(actual_cert.name);
	});

	it('Test getReplicationCertAuth returns the correct CA', async () => {
		const ca = await keys.getReplicationCertAuth();
		expect(ca).to.exist;
		expect(ca.certificate).to.equal(actual_ca.certificate);
	});

	it('Test generateCertificates happy path', async () => {
		const generateCertificates = keys.__get__('generateCertificates');
		const cert = await generateCertificates(
			pki.privateKeyFromPem(test_private_key),
			test_public_key,
			pki.certificateFromPem(test_ca)
		);
		expect(cert).to.include('BEGIN CERTIFICATE');
	});

	it('Test getCertAuthority happy path', async () => {
		const getCertAuthority = keys.__get__('getCertAuthority');
		const key_and_cert = await getCertAuthority();
		expect(key_and_cert).to.exist;
		expect(key_and_cert.ca).to.exist;
	});

	it('Test reviewSelfSignedCert create a new cert', async () => {
		const set_cert_stub = sandbox.stub(keys, 'setCertTable');
		const get_rep_rw = keys.__set__('getReplicationCert', sandbox.stub().resolves(undefined));
		const set_cert_rw = keys.__set__('setCertTable', set_cert_stub);
		await keys.reviewSelfSignedCert();
		expect(set_cert_stub.called).to.be.true;
		get_rep_rw();
		set_cert_rw();
	});

	it('Test updateConfigCert builds new cert config correctly', () => {
		update_config_value_stub = sandbox.stub(config_utils, 'updateConfigValue');
		keys.updateConfigCert('public/cert.pem', 'private/cert.pem', 'certificate/authority.pem');
		const call = update_config_value_stub.getCalls().find(c => c.args[0] === 'tls' || c.args[2]?.tls_privateKey);
		expect(call).to.exist;
	});

	it('hostnamesFromCert returns the correct hostnames', async () => {
		const test_cert = {
			subject: '',
			subjectAltName: 'DirName:\"CN=test-1.name\\u002cO=1999710\",' + ' DirName:CN=test-2.org,IP-Address:1.2.3.4',
		};
		const hostnames = keys.hostnamesFromCert(test_cert);
		expect(hostnames).to.include('test-1.name');
		expect(hostnames).to.include('test-2.org');
	});

	it('getPrimaryHostName with subject', async () => {
		const test_cert = {
			subject: 'CN=test-1.name',
			subjectAltName: 'DirName:\"CN=test-different',
		};
		expect(keys.getPrimaryHostName(test_cert)).to.eql('test-1.name');
	});

	it('can extract the hostnames from a certificate', async () => {
		const cert = {
			subjectaltname: 'IP Address:127.0.0.1, DNS:localhost, IP Address:0:0:0:0:0:0:0:1',
			subject: { CN: '127.0.0.1', C: 'USA', ST: 'Colorado', L: 'Denver', O: 'Harper, Inc.' },
		};

		const hostnames = await keys.getHostnamesFromCertificate(cert);
		expect(hostnames).to.have.members(['127.0.0.1', 'localhost']);
	});

	it('Test setCertTable with malformed certificate - illegal ASN.1 padding', async () => {
		const { databases } = require('#src/resources/databases');
		keys.__set__('certificateTable', databases.system.hdb_certificate);
		
		const malformedCerts = [
			{
				name: 'corrupted-base64-padding',
				certificate: '-----BEGIN CERTIFICATE-----\nMIIEFzCCAv+gAwIBAgIUBg==\n-----END CERTIFICATE-----',
			},
		];

		for (const malformedCert of malformedCerts) {
			let error;
			try {
				await keys.setCertTable(malformedCert);
			} catch (err) {
				error = err;
			}
			expect(error).to.exist;
			expect(error.code).to.equal('INVALID_CERTIFICATE_FORMAT');
		}
	});

	describe('generateSerialNumber', () => {
		it('should generate valid hex serial numbers', () => {
			const serial = generateSerialNumber();
			expect(serial).to.be.a('string');
			expect(serial).to.match(/^[0-9a-f]{16}$/);
		});
	});

	it('Test setCertTable with valid certificate should work', async () => {
		const { databases } = require('#src/resources/databases');
		keys.__set__('certificateTable', databases.system.hdb_certificate);
		
		const validCert = {
			name: 'valid-test-cert',
			certificate: test_cert,
			uses: ['https'],
			is_authority: false,
			private_key_name: 'test.pem',
		};

		await keys.setCertTable(validCert);
		const certs = await keys.listCertificates();
		const found = certs.find((c) => c.name === 'valid-test-cert');
		expect(found).to.exist;
	});

	it('Test generateCertAuthority includes subjectKeyIdentifier extension for OCSP support', async () => {
		const generateCertAuthority = keys.__get__('generateCertAuthority');
		const { privateKey, publicKey } = await keys.generateKeys();
		const caCert = await generateCertAuthority(privateKey, publicKey, false);
		const extensions = caCert.extensions;
		const hasSubjectKeyIdentifier = extensions.some((ext) => ext.name === 'subjectKeyIdentifier');
		expect(hasSubjectKeyIdentifier).to.be.true;
	});
});
