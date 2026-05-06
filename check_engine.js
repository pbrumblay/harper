const { database } = require('./dist/resources/databases.js');
const db = database({ database: 'test', table: 'BlobTest' });
console.log(db.constructor.name);
