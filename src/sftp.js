'use strict';

exports = module.exports = {
    startSftp: startSftp
};

var assert = require('assert'),
    infra = require('./infra_version.js'),
    paths = require('./paths.js'),
    shell = require('./shell.js');

function startSftp(existingInfra, callback) {
    assert.strictEqual(typeof existingInfra, 'object');
    assert.strictEqual(typeof callback, 'function');

    const tag = infra.images.sftp.tag;
    const memoryLimit = 256;

    if (existingInfra.version === infra.version && infra.images.graphite.tag === existingInfra.images.graphite.tag) return callback();

    const cmd = `docker run --restart=always -d --name="sftp" \
                --net cloudron \
                --net-alias sftp \
                --log-driver syslog \
                --log-opt syslog-address=udp://127.0.0.1:2514 \
                --log-opt syslog-format=rfc5424 \
                --log-opt tag=sftp \
                -m ${memoryLimit}m \
                --memory-swap ${memoryLimit * 2}m \
                --dns 172.18.0.1 \
                --dns-search=. \
                -p 222:22 \
                -v "${paths.APPS_DATA_DIR}:/app/data" \
                -v "/etc/ssh:/etc/ssh:ro" \
                --label isCloudronManaged=true \
                --read-only -v /tmp -v /run "${tag}"`;

    shell.exec('startSftp', cmd, callback);
}
