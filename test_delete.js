const { getFilePathForBlob, createBlob, setDeletionDelay, cleanupUnusedBlobs } = require('./dist/resources/blob.js');
const { existsSync } = require('fs');

async function test() {
	setDeletionDelay(0);
	const goodBlob = await createBlob(Buffer.alloc(20000, 'a'), { saveBeforeCommit: true });
	const goodPath = getFilePathForBlob(goodBlob);
	console.log('goodPath:', goodPath);
	console.log('exists before:', existsSync(goodPath));
	cleanupUnusedBlobs([goodBlob]);
	await new Promise((r) => setTimeout(r, 100));
	console.log('exists after:', existsSync(goodPath));
}
test();
