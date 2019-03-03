/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    database = require('../database.js'),
    users = require('../users.js'),
    userdb = require('../userdb.js'),
    eventlogdb = require('../eventlogdb.js'),
    notifications = require('../notifications.js'),
    NotificationsError = notifications.NotificationsError,
    expect = require('expect.js');

// owner
var USER_0 = {
    username: 'username0',
    password: 'Username0pass?1234',
    email: 'user0@email.com',
    fallbackEmail: 'user0fallback@email.com',
    displayName: 'User 0'
};

var EVENT_0 = {
    id: 'event_0',
    action: '',
    source: {},
    data: {}
};

var AUDIT_SOURCE = {
    ip: '1.2.3.4'
};

function setup(done) {
    async.series([
        database.initialize,
        database._clear,
        users.createOwner.bind(null, USER_0.username, USER_0.password, USER_0.email, USER_0.displayName, AUDIT_SOURCE),
        function (callback) {
            userdb.getByUsername(USER_0.username, function (error, result) {
                if (error) return callback(error);

                USER_0.id = result.id;

                callback();
            });
        },
        eventlogdb.add.bind(null, EVENT_0.id, EVENT_0.action, EVENT_0.source, EVENT_0.data),
    ], done);
}

function cleanup(done) {
    async.series([
        database._clear,
        database.uninitialize
    ], done);
}

describe('Notifications', function () {
    before(setup);
    after(cleanup);

    var notificationId;

    it('add succeeds', function (done) {
        notifications._add(USER_0.id, EVENT_0.id, 'title', 'message text', function (error, result) {
            expect(error).to.eql(null);
            expect(result.id).to.be.ok();

            notificationId = result.id;

            done();
        });
    });

    it('get succeeds', function (done) {
        notifications.get(notificationId, function (error, result) {
            expect(error).to.eql(null);
            expect(result.id).to.equal(notificationId);
            expect(result.title).to.equal('title');
            expect(result.message).to.equal('message text');
            expect(result.acknowledged).to.equal(false);
            expect(result.creationTime).to.be.a(Date);

            done();
        });
    });

    it('get of unknown id fails', function (done) {
        notifications.get('notfoundid', function (error, result) {
            expect(error).to.be.a(NotificationsError);
            expect(error.reason).to.be(NotificationsError.NOT_FOUND);
            expect(result).to.not.be.ok();

            done();
        });
    });

    it('ack succeeds', function (done) {
        notifications.ack(notificationId, function (error) {
            expect(error).to.eql(null);

            notifications.get(notificationId, function (error, result) {
                expect(error).to.eql(null);
                expect(result.acknowledged).to.equal(true);

                done();
            });
        });
    });

    it('ack succeeds twice', function (done) {
        notifications.ack(notificationId, function (error) {
            expect(error).to.eql(null);

            notifications.get(notificationId, function (error, result) {
                expect(error).to.eql(null);
                expect(result.acknowledged).to.equal(true);

                done();
            });
        });
    });

    it('ack fails for nonexisting id', function (done) {
        notifications.ack('id does not exist', function (error) {
            expect(error).to.be.a(NotificationsError);
            expect(error.reason).to.be(NotificationsError.NOT_FOUND);

            done();
        });
    });

    it('getAllPaged succeeds', function (done) {
        notifications.getAllPaged(USER_0.id, null, 1, 1, function (error, results) {
            expect(error).to.eql(null);
            expect(results).to.be.an(Array);
            expect(results.length).to.be(1);

            expect(results[0].id).to.be(notificationId);
            expect(results[0].title).to.equal('title');
            expect(results[0].message).to.equal('message text');
            expect(results[0].acknowledged).to.equal(true);
            expect(results[0].creationTime).to.be.a(Date);

            done();
        });
    });

    it('getAllPaged succeeds for second page', function (done) {
        async.timesSeries(20, function (n, callback) {
            notifications._add(USER_0.id, EVENT_0.id, 'title' + n, 'some message', callback);
        }, function (error) {
            expect(error).to.eql(null);

            notifications.getAllPaged(USER_0.id, null, 2, 10, function (error, results) {
                expect(error).to.eql(null);
                expect(results).to.be.an(Array);
                expect(results.length).to.be(10);

                expect(results[0].title).to.equal('title9');

                done();
            });
        });
    });
});
