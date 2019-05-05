'use strict';

exports.up = function(db, callback) {
    db.runSql('UPDATE tokens SET expires=? WHERE clientId=?', [ 1557089270832, 'cid-webadmin' ], function (error) { // force webadmin to get a new token
        if (error) console.error(error);

        callback(error);
    });
};

exports.down = function(db, callback) {
    callback();
};
