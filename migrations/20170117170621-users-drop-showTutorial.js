var dbm = global.dbm || require('db-migrate');
var type = dbm.dataType;

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE users DROP COLUMN showTutorial', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE users ADD COLUMN showTutorial BOOLEAN DEFAULT 0', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
