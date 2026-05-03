import * as validator from './validationWrapper.js';
import Joi from 'joi';
const { hdbTable, hdbDatabase } = require('./common_validators.js');

const deleteSchema = Joi.object({
	schema: hdbDatabase,
	database: hdbDatabase,
	table: hdbTable,
	hash_values: Joi.array().required(),
	ids: Joi.array(),
});

export default function (deleteObject: any) {
	return validator.validateBySchema(deleteObject, deleteSchema);
};
