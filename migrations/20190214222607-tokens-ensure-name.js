'use strict';

let async = require('async');

exports.up = function(db, callback) {
    db.runSql('SELECT * FROM tokens WHERE clientId=?', ['cid-sdk'], function (error, tokens) {
        if (error) console.error(error);

        async.eachSeries(tokens, function (token, iteratorDone) {
            if (token.name) return iteratorDone();
            db.runSql('UPDATE tokens SET name=? WHERE accessToken=?', [ 'Unnamed-' + token.accessToken.slice(0,8), token.accessToken ], iteratorDone);
        }, callback);
    });
};

exports.down = function(db, callback) {
    callback();
};
