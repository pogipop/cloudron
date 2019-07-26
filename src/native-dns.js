'use strict';

exports = module.exports = {
    resolve: resolve
};

var assert = require('assert'),
    constants = require('./constants.js'),
    dns = require('dns'),
    _ = require('underscore');

const DEFAULT_OPTIONS = { server: '127.0.0.1', timeout: 5000 }; // unbound runs on 127.0.0.1

// a note on TXT records. It doesn't have quotes ("") at the DNS level. Those quotes
// are added for DNS server software to enclose spaces. Such quotes may also be returned
// by the DNS REST API of some providers
function resolve(hostname, rrtype, options, callback) {
    assert.strictEqual(typeof hostname, 'string');
    assert.strictEqual(typeof rrtype, 'string');
    assert(options && typeof options === 'object');
    assert.strictEqual(typeof callback, 'function');

    const resolver = new dns.Resolver();
    options = _.extend({ }, DEFAULT_OPTIONS, options);

    // Only use unbound on a Cloudron
    if (constants.CLOUDRON) resolver.setServers([ options.server ]);

    // should callback with ECANCELLED but looks like we might hit https://github.com/nodejs/node/issues/14814
    const timerId = setTimeout(resolver.cancel.bind(resolver), options.timeout || 5000);

    resolver.resolve(hostname, rrtype, function (error, result) {
        clearTimeout(timerId);

        if (error && error.code === 'ECANCELLED') error.code = 'TIMEOUT';

        // result is an empty array if there was no error but there is no record. when you query a random
        // domain, it errors with ENOTFOUND. But if you query an existing domain (A record) but with different
        // type (CNAME) it is not an error and empty array
        // for TXT records, result is 2d array of strings
        callback(error, result);
    });
}
