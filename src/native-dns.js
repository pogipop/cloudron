'use strict';

exports = module.exports = {
    resolveNs: resolveNs,
    resolve4: resolve4,
    resolve: resolve
};

var assert = require('assert'),
    dns = require('dns');

// a note on TXT records. It doesn't have quotes ("") at the DNS level. Those quotes
// are added for DNS server software to enclose spaces. Such quotes may also be returned
// by the DNS REST API of some providers
function resolve(hostname, rrtype, options, callback) {
    assert.strictEqual(typeof hostname, 'string');
    assert.strictEqual(typeof rrtype, 'string');
    assert(options && typeof options === 'object');
    assert.strictEqual(typeof callback, 'function');

    const resolver = new dns.Resolver();
    if (options.server) resolver.setServers([ options.server ]);

    // should callback with ECANCELLED but looks like we might hit https://github.com/nodejs/node/issues/14814
    const timerId = setTimeout(resolver.cancel.bind(resolver), options.timeout || 5000);

    resolver.resolve(hostname, rrtype, function (error, result) {
        clearTimeout(timerId);

        callback(error, result);
    });
}

function resolveNs(hostname, callback) {
    resolve(hostname, 'NS', { timeout: 5000 }, callback);
}

function resolve4(hostname, callback) {
    resolve(hostname, 'A', { timeout: 5000 }, callback);
}
