const express    = require('express');
const compression = require('compression');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 8080;

// Gzip/Brotli all responses
app.use(compression());

// Serve static files with sensible cache headers
app.use(express.static(path.join(__dirname), {
    maxAge: 0,           // index.html — always revalidate
    etag:   true,
    lastModified: true,
}));

app.listen(PORT, () => console.log('Parking wizard listening on port', PORT));
