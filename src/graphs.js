'use strict';

exports = module.exports = {
    startGraphite: startGraphite
};

var assert = require('assert'),
    infra = require('./infra_version.js'),
    paths = require('./paths.js'),
    shell = require('./shell.js');

function startGraphite(existingInfra, callback) {
    assert.strictEqual(typeof existingInfra, 'object');
    assert.strictEqual(typeof callback, 'function');

    const tag = infra.images.graphite.tag;
    const dataDir = paths.PLATFORM_DATA_DIR;

    if (existingInfra.version === infra.version && infra.images.graphite.tag === existingInfra.images.graphite.tag) return callback();

    const cmd = `docker run --restart=always -d --name="graphite" \
                --net cloudron \
                --net-alias graphite \
                --log-driver syslog \
                --log-opt syslog-address=udp://127.0.0.1:2514 \
                --log-opt syslog-format=rfc5424 \
                --log-opt tag=graphite \
                -m 75m \
                --memory-swap 150m \
                --dns 172.18.0.1 \
                --dns-search=. \
                -p 127.0.0.1:2003:2003 \
                -p 127.0.0.1:2004:2004 \
                -p 127.0.0.1:8000:8000 \
                -v "${dataDir}/graphite:/var/lib/graphite" \
                --label isCloudronManaged=true \
                --read-only -v /tmp -v /run "${tag}"`;

    shell.execSync('startGraphite', cmd);

    callback();
}
