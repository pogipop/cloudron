'use strict';

exports.up = function(db, callback) {
    db.all('SELECT * FROM domains', function (error, domains) {
        if (error) return callback(error);
        if (domains.length === 0) return callback();

        db.all('SELECT * FROM settings', function (error, allSettings) {
            if (error) return callback(error);

            // defaults
            var mailFromValidation = true;
            var catchAll = [ ];
            var relay = { provider: 'cloudron-smtp' };
            var mailEnabled = false;

            allSettings.forEach(function (setting) {
                switch (setting.name) {
                case 'mail_from_validation': mailFromValidation = !!setting.value; break;
                case 'catch_all_address': catchAll = setting.value; break;
                case 'mail_relay': relay = setting.value; break;
                case 'mail_config': mailEnabled = JSON.parse(setting.value).enabled; break;
                }
            });

            db.runSql('INSERT INTO maildb (domain, enabled, mailFromValidation, catchAllJson, relayJson) VALUES (?, ?, ?, ?, ?)',
                [ domains[0].domain, mailEnabled, mailFromValidation, JSON.stringify(catchAll), JSON.stringify(relay) ], callback);
        });
    });
};

exports.down = function(db, callback) {
    callback();
};
