'use strict';

exports = module.exports = {
    initialize: initialize,
    uninitialize: uninitialize,
    query: query,
    transaction: transaction,

    importFromFile: importFromFile,
    exportToFile: exportToFile,

    _clear: clear
};

var assert = require('assert'),
    async = require('async'),
    child_process = require('child_process'),
    config = require('./config.js'),
    constants = require('./constants.js'),
    mysql = require('mysql'),
    once = require('once'),
    util = require('util');

var gConnectionPool = null,
    gDefaultConnection = null;

const gDatabase = {
    hostname: '127.0.0.1',
    username: 'root',
    password: 'password',
    port: 3306,
    name: 'box'
};

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (gConnectionPool !== null) return callback(null);

    if (constants.TEST) {
        // see setupTest script how the mysql-server is run
        gDatabase.hostname = require('child_process').execSync('docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" mysql-server').toString().trim();
    }

    gConnectionPool  = mysql.createPool({
        connectionLimit: 5, // this has to be > 1 since we store one connection as 'default'. the rest for transactions
        host: gDatabase.hostname,
        user: gDatabase.username,
        password: gDatabase.password,
        port: gDatabase.port,
        database: gDatabase.name,
        multipleStatements: false,
        ssl: false,
        timezone: 'Z' // mysql follows the SYSTEM timezone. on Cloudron, this is UTC
    });

    gConnectionPool.on('connection', function (connection) {
        connection.query('USE ' + gDatabase.name);
        connection.query('SET SESSION sql_mode = \'strict_all_tables\'');
    });

    reconnect(callback);
}

function uninitialize(callback) {
    if (gConnectionPool) {
        gConnectionPool.end(callback);
        gConnectionPool = null;
    } else {
        callback(null);
    }
}

function reconnect(callback) {
    callback = callback ? once(callback) : function () {};

    gConnectionPool.getConnection(function (error, connection) {
        if (error) {
            console.error('Unable to reestablish connection to database. Try again in a bit.', error.message);
            return setTimeout(reconnect.bind(null, callback), 1000);
        }

        connection.on('error', function (error) {
            // by design, we catch all normal errors by providing callbacks.
            // this function should be invoked only when we have no callbacks pending and we have a fatal error
            assert(error.fatal, 'Non-fatal error on connection object');

            console.error('Unhandled mysql connection error.', error);

            // This is most likely an issue an can cause double callbacks from reconnect()
            setTimeout(reconnect.bind(null, callback), 1000);
        });

        gDefaultConnection = connection;

        callback(null);
    });
}

function clear(callback) {
    assert.strictEqual(typeof callback, 'function');

    var cmd = util.format('mysql --host="%s" --user="%s" --password="%s" -Nse "SHOW TABLES" %s | grep -v "^migrations$" | while read table; do mysql --host="%s" --user="%s" --password="%s" -e "SET FOREIGN_KEY_CHECKS = 0; TRUNCATE TABLE $table" %s; done',
        gDatabase.hostname, gDatabase.username, gDatabase.password, gDatabase.name,
        gDatabase.hostname, gDatabase.username, gDatabase.password, gDatabase.name);

    async.series([
        child_process.exec.bind(null, cmd),
        require('./clientdb.js')._addDefaultClients
    ], callback);
}

function beginTransaction(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (gConnectionPool === null) return callback(new Error('No database connection pool.'));

    gConnectionPool.getConnection(function (error, connection) {
        if (error) {
            console.error('Unable to get connection to database. Try again in a bit.', error.message);
            return setTimeout(beginTransaction.bind(null, callback), 1000);
        }

        connection.beginTransaction(function (error) {
            if (error) return callback(error);

            return callback(null, connection);
        });
    });
}

function rollback(connection, callback) {
    assert.strictEqual(typeof callback, 'function');

    connection.rollback(function (error) {
        if (error) console.error(error); // can this happen?

        connection.release();
        callback(null);
    });
}

// FIXME: if commit fails, is it supposed to return an error ?
function commit(connection, callback) {
    assert.strictEqual(typeof callback, 'function');

    connection.commit(function (error) {
        if (error) return rollback(connection, callback);

        connection.release();
        return callback(null);
    });
}

function query() {
    var args = Array.prototype.slice.call(arguments);
    var callback = args[args.length - 1];
    assert.strictEqual(typeof callback, 'function');

    if (gDefaultConnection === null) return callback(new Error('No connection to database'));

    args[args.length -1 ] = function (error, result) {
        if (error && error.fatal) {
            gDefaultConnection = null;
            setTimeout(reconnect, 1000);
        }

        callback(error, result);
    };

    gDefaultConnection.query.apply(gDefaultConnection, args);
}

function transaction(queries, callback) {
    assert(util.isArray(queries));
    assert.strictEqual(typeof callback, 'function');

    beginTransaction(function (error, conn) {
        if (error) return callback(error);

        async.mapSeries(queries, function iterator(query, done) {
            conn.query(query.query, query.args, done);
        }, function seriesDone(error, results) {
            if (error) return rollback(conn, callback.bind(null, error));

            commit(conn, callback.bind(null, null, results));
        });
    });
}

function importFromFile(file, callback) {
    assert.strictEqual(typeof file, 'string');
    assert.strictEqual(typeof callback, 'function');

    var cmd = `/usr/bin/mysql -h "${gDatabase.hostname}" -u ${gDatabase.username} -p${gDatabase.password} ${gDatabase.name} < ${file}`;

    async.series([
        query.bind(null, 'CREATE DATABASE IF NOT EXISTS box'),
        child_process.exec.bind(null, cmd)
    ], callback);
}

function exportToFile(file, callback) {
    assert.strictEqual(typeof file, 'string');
    assert.strictEqual(typeof callback, 'function');

    var cmd = `/usr/bin/mysqldump -h "${gDatabase.hostname}" -u root -p${gDatabase.password} --single-transaction --routines --triggers ${gDatabase.name} > "${file}"`;

    child_process.exec(cmd, callback);
}
