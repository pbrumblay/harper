import * as installer from '../utility/install/installer.js';
import hdbLogger from '../utility/logging/harper_logger.js';

export default install;

async function install() {
	try {
		await installer.install();
	} catch (err) {
		console.error('There was an error during the install.');
		console.error(err);
		hdbLogger.error(err);
		process.exit(1);
	}
}
