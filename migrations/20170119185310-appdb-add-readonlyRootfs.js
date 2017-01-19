dbm = dbm || require('db-migrate');

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps ADD COLUMN readonlyRootfs BOOLEAN DEFAULT 1', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps DROP COLUMN readonlyRootfs', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
