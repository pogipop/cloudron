'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps ADD CONSTRAINT apps_domain_constraint FOREIGN KEY(domain) REFERENCES domains(domain)', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps DROP FOREIGN KEY apps_domain_constraint', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
