import { packageJson } from '../utility/packageUtils.ts';

export function getRegistrationInfo() {
	return {
		version: packageJson.version,
		deprecated: true,
	};
}
