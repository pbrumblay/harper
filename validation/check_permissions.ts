import * as validator from './validationWrapper.js';

const constraints = {
	user: {
		presence: true,
	},
	schema: {
		presence: true,
	},
	table: {
		presence: true,
	},
	operation: {
		presence: true,
	},
};
export default function (deleteObject) {
	return validator.validateObject(deleteObject, constraints);
}
