'use strict';

exports = module.exports = {
    getGraphs: getGraphs
};

var middleware = require('../middleware/index.js'),
    url = require('url');

var graphiteProxy = middleware.proxy(url.parse('http://127.0.0.1:8417'));

function getGraphs(req, res, next) {
    var parsedUrl = url.parse(req.url, true /* parseQueryString */);
    delete parsedUrl.query['access_token'];
    delete req.headers['authorization'];
    delete req.headers['cookies'];
    req.url = url.format({ pathname: 'render', query: parsedUrl.query });

    // graphs may take very long to respond so we run into headers already sent issues quite often
    // nginx still has a request timeout which can deal with this then.
    req.clearTimeout();

    graphiteProxy(req, res, next);
}

