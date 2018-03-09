'use strict';

var async = require('async'),
    crypto = require('crypto'),
    fs = require('fs'),
    os = require('os'),
    path = require('path'),
    safe = require('safetydance'),
    tldjs = require('tldjs');

exports.up = function(db, callback) {
    db.all('SELECT * FROM apps', function (error, apps) {
        if (error) return callback(error);

        async.eachSeries(apps, function (app, callback) {
            if (!app.altDomain) {
                console.log('App %s does not use altDomain, skip', app.id);
                return callback();
            }

            const domain = tldjs.getDomain(app.altDomain);
            const subdomain = tldjs.getSubdomain(app.altDomain);
            const mailboxName = (subdomain ? subdomain : JSON.parse(app.manifestJson).title.toLowerCase().replace(/[^a-zA-Z0-9]/g, '')) + '.app';

            console.log('App %s is on domain %s and subdomain %s with mailbox', app.id, domain, subdomain, mailboxName);

            async.series([
                // Add domain if not exists
                function (callback) {
                    const query = 'INSERT domains (domain, zoneName, provider, configJson, tlsConfigJson) VALUES (?, ?, ?, ?, ?)';
                    const args = [ domain, domain, 'manual', JSON.stringify({}), JSON.stringify({ provider: 'letsencrypt-prod' }) ];

                    db.runSql(query, args, function (error) {
                        if (error && error.code !== 'ER_DUP_ENTRY') return callback(error);

                        console.log('Added domain %s', domain);

                        // ensure we have a fallback cert for the newly added domain. This is the same as in reverseproxy.js
                        // WARNING this will only work on the cloudron itself not during local testing!
                        const certFilePath = `/home/yellowtent/boxdata/certs/${domain}.host.cert`;
                        const keyFilePath = `/home/yellowtent/boxdata/certs/${domain}.host.key`;

                        if (!fs.existsSync(certFilePath) || !fs.existsSync(keyFilePath)) { // generate it
                            let opensslConf = safe.fs.readFileSync('/etc/ssl/openssl.cnf', 'utf8');
                            let opensslConfWithSan = `${opensslConf}\n[SAN]\nsubjectAltName=DNS:${domain}\n`;
                            let configFile = path.join(os.tmpdir(), 'openssl-' + crypto.randomBytes(4).readUInt32LE(0) + '.conf');
                            let certCommand = `openssl req -x509 -newkey rsa:2048 -keyout ${keyFilePath} -out ${certFilePath} -days 3650 -subj /CN=*.${domain} -extensions SAN -config ${configFile} -nodes`;

                            safe.fs.writeFileSync(configFile, opensslConfWithSan, 'utf8');
                            if (!safe.child_process.execSync(certCommand)) return callback(safe.error.message);
                            safe.fs.unlinkSync(configFile);
                        }

                        callback();
                    });
                },
                // Remove old mailbox record if any
                function (callback) {
                    const query = 'DELETE FROM mailboxes WHERE ownerId=?';
                    const args = [ app.id ];

                    db.runSql(query, args, function (error) {
                        if (error) return callback(error);

                        console.log('Cleaned up mailbox record for app %s', app.id);

                        callback();
                    });
                },
                // Add new mailbox record
                function (callback) {
                    const query = 'INSERT INTO mailboxes (name, domain, ownerId, ownerType) VALUES (?, ?, ?, ?)';
                    const args = [ mailboxName, domain, app.id, 'app' /* mailboxdb.TYPE_APP */ ];

                    db.runSql(query, args, function (error) {
                        if (error) return callback(error);

                        console.log('Added mailbox record for app %s', app.id);

                        callback();
                    });
                },
                // Update app record
                function (callback) {
                    const query = 'UPDATE apps SET location=?, domain=?, altDomain=? WHERE id=?';
                    const args = [ subdomain, domain, '', app.id ];

                    db.runSql(query, args, function (error) {
                        if (error) return error;

                        console.log('Updated app %s with new domain', app.id);

                        callback();
                    });
                }
            ], callback);
        }, function (error) {
            if (error) return callback(error);

            // finally drop the altDomain db field
            db.runSql('ALTER TABLE apps DROP COLUMN altDomain', [], callback);
        });
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps ADD COLUMN altDomain VARCHAR(256)', [], callback);
};
