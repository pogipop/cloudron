dbm = dbm || require('db-migrate');

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps ADD COLUMN developmentMode BOOLEAN DEFAULT 0', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps DROP COLUMN developmentMode', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
