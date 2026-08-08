let handler = null;

try {
	const serverless = require('serverless-http');
	const app = require('../server/server');
	handler = serverless(app);
} catch (err) {
	// Initialization failed (missing deps, syntax error, etc.). Export a
	// fallback handler that logs the error and returns 500 so Vercel logs
	// surface the root cause instead of an opaque invocation failure.
	console.error('Function initialization error in api/index.js:', err);
	handler = async (req, res) => {
		console.error('Invocation after failed init — returning 500.');
		res.statusCode = 500;
		res.end('Function initialization error. Check logs.');
	};
}

module.exports = handler;
