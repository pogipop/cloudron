/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    accesscontrol = require('../accesscontrol.js'),
    config = require('../config.js'),
    constants = require('../constants.js'),
    database = require('../database.js'),
    DatabaseError = require('../databaseerror.js'),
    expect = require('expect.js'),
    groups = require('../groups.js'),
    GroupsError = groups.GroupsError,
    hat = require('../hat.js'),
    mailboxdb = require('../mailboxdb.js'),
    userdb = require('../userdb.js');

var GROUP0_NAME = 'administrators',
    group0Object;

var GROUP1_NAME = 'externs',
    group1Object;

const DOMAIN_0 = {
    domain: 'example.com',
    zoneName: 'example.com',
    config: { provider: 'manual' }
};

var USER_0 = {
    id: 'uuid213',
    username: 'uuid213',
    password: 'secret',
    email: 'safe@me.com',
    fallbackEmail: 'safefallback@me.com',
    admin: false,
    salt: 'morton',
    createdAt: 'sometime back',
    modifiedAt: 'now',
    resetToken: hat(256),
    displayName: ''
};

var USER_1 = { // this user has not signed up yet
    id: 'uuid222',
    username: null,
    password: '',
    email: 'safe2@me.com',
    fallbackEmail: 'safe2fallback@me.com',
    admin: false,
    salt: 'morton',
    createdAt: 'sometime back',
    modifiedAt: 'now',
    resetToken: hat(256),
    displayName: ''
};

function setup(done) {
    config.setFqdn(DOMAIN_0.domain);

    // ensure data/config/mount paths
    async.series([
        database.initialize,
        database._clear
    ], done);
}

function cleanup(done) {
    async.series([
        database._clear,
        database.uninitialize
    ], done);
}

describe('Groups', function () {
    before(setup);
    after(cleanup);

    it('cannot create group - too small', function (done) {
        groups.create('', [ ], function (error) {
            expect(error.reason).to.be(GroupsError.BAD_FIELD);
            done();
        });
    });

    it('cannot create group - too big', function (done) {
        groups.create(new Array(256).join('a'), [ ], function (error) {
            expect(error.reason).to.be(GroupsError.BAD_FIELD);
            done();
        });
    });

    it('cannot create group - bad name', function (done) {
        groups.create('bad:name', [ ], function (error) {
            expect(error.reason).to.be(GroupsError.BAD_FIELD);
            done();
        });
    });

    it('cannot create group - reserved', function (done) {
        groups.create('users', [ ], function (error) {
            expect(error.reason).to.be(GroupsError.BAD_FIELD);
            done();
        });
    });

    it('cannot create group - invalid', function (done) {
        groups.create('cloudron+admin', [ ], function (error) {
            expect(error.reason).to.be(GroupsError.BAD_FIELD);
            done();
        });
    });

    it('can create valid group', function (done) {
        groups.create(GROUP0_NAME, [ ], function (error, result) {
            expect(error).to.be(null);
            group0Object = result;
            done();
        });
    });

    it('cannot create existing group with mixed case', function (done) {
        var name = GROUP0_NAME[0].toUpperCase() + GROUP0_NAME.substr(1);
        groups.create(name, [ ], function (error) {
            expect(error.reason).to.be(GroupsError.ALREADY_EXISTS);
            done();
        });
    });

    it('cannot add existing group', function (done) {
        groups.create(GROUP0_NAME, [ ], function (error) {
            expect(error.reason).to.be(GroupsError.ALREADY_EXISTS);
            done();
        });
    });

    it('cannot get invalid group', function (done) {
        groups.get('sometrandom', function (error) {
            expect(error.reason).to.be(GroupsError.NOT_FOUND);
            done();
        });
    });

    it('can get valid group', function (done) {
        groups.get(group0Object.id, function (error, group) {
            expect(error).to.be(null);
            expect(group.name).to.equal(GROUP0_NAME);
            done();
        });
    });

    it('cannot delete invalid group', function (done) {
        groups.remove('random', function (error) {
            expect(error.reason).to.be(GroupsError.NOT_FOUND);
            done();
        });
    });

    it('can delete valid group', function (done) {
        groups.remove(group0Object.id, function (error) {
            expect(error).to.be(null);
            done();
        });
    });

    it('did delete mailbox', function (done) {
        mailboxdb.getGroup(GROUP0_NAME.toLowerCase(), DOMAIN_0.domain, function (error) {
            expect(error.reason).to.be(DatabaseError.NOT_FOUND);
            done();
        });
    });
});

describe('Group membership', function () {
    before(function (done) {
        async.series([
            setup,
            function (next) {
                groups.create(GROUP0_NAME, [ /* roles */ ], function (error, result) {
                    if (error) return next(error);
                    group0Object = result;
                    next();
                });
            },
            userdb.add.bind(null, USER_0.id, USER_0),
            userdb.add.bind(null, USER_1.id, USER_1)
        ], done);
    });
    after(cleanup);

    it('cannot add non-existent user', function (done) {
        groups.addMember(group0Object.id, 'randomuser', function (error) {
            expect(error.reason).to.be(GroupsError.NOT_FOUND);
            done();
        });
    });

    it('cannot add non-existent group', function (done) {
        groups.addMember('randomgroup', USER_0.id, function (error) {
            expect(error.reason).to.be(GroupsError.NOT_FOUND);
            done();
        });
    });

    it('isMember returns false', function (done) {
        groups.isMember(group0Object.id, USER_0.id, function (error, member) {
            expect(error).to.be(null);
            expect(member).to.be(false);
            done();
        });
    });

    it('can add member', function (done) {
        groups.addMember(group0Object.id, USER_0.id, function (error) {
            expect(error).to.be(null);
            done();
        });
    });

    it('can add member without username', function (done) {
        groups.addMember(group0Object.id, USER_1.id, function (error) {
            expect(error).to.be(null);
            done();
        });
    });

    it('isMember returns true', function (done) {
        groups.isMember(group0Object.id, USER_0.id, function (error, member) {
            expect(error).to.be(null);
            expect(member).to.be(true);
            done();
        });
    });

    it('can get members', function (done) {
        groups.getMembers(group0Object.id, function (error, result) {
            expect(error).to.be(null);
            expect(result.length).to.be(2);
            expect(result[0]).to.be(USER_0.id);
            expect(result[1]).to.be(USER_1.id);
            done();
        });
    });

    it('cannot get members of non-existent group', function (done) {
        groups.getMembers('randomgroup', function (error, result) {
            expect(result.length).to.be(0); // currently, we cannot differentiate invalid groups and empty groups
            done();
        });
    });

    it('cannot remove non-existent user', function (done) {
        groups.removeMember(group0Object.id, 'randomuser', function (error) {
            expect(error.reason).to.be(GroupsError.NOT_FOUND);
            done();
        });
    });

    it('cannot remove non-existent group', function (done) {
        groups.removeMember('randomgroup', USER_0.id, function (error) {
            expect(error.reason).to.be(GroupsError.NOT_FOUND);
            done();
        });
    });

    it('can set groups', function (done) {
        groups.setMembers(group0Object.id, [ USER_0.id ], function (error) {
            expect(error).to.be(null);
            done();
        });
    });

    it('can remove member', function (done) {
        groups.removeMember(group0Object.id, USER_0.id, function (error) {
            expect(error).to.be(null);
            done();
        });
    });

    it('has no members', function (done) {
        groups.getMembers(group0Object.id, function (error, result) {
            expect(error).to.be(null);
            expect(result.length).to.be(0);
            done();
        });
    });

    it('can remove group with no members', function (done) {
        groups.remove(group0Object.id, function (error) {
            expect(error).to.be(null);
            done();
        });
    });

    it('can remove group with member', function (done) {
        groups.create(GROUP0_NAME, [ /* roles */ ], function (error, result) {
            expect(error).to.eql(null);
            group0Object = result;

            groups.addMember(group0Object.id, USER_0.id, function (error) {
                expect(error).to.be(null);

                groups.remove(group0Object.id, function (error) {
                    expect(error).to.eql(null);
                    done();
                });
            });
        });
    });
});

describe('Set user groups', function () {
    before(function (done) {
        async.series([
            setup,
            function (next) {
                groups.create(GROUP0_NAME, [ ], function (error, result) {
                    if (error) return next(error);
                    group0Object = result;
                    next();
                });
            },
            function (next) {
                groups.create(GROUP1_NAME, [ ], function (error, result) {
                    if (error) return next(error);
                    group1Object = result;
                    next();
                });
            },
            userdb.add.bind(null, USER_0.id, USER_0)
        ], done);
    });
    after(cleanup);

    it('can set user to single group', function (done) {
        groups.setGroups(USER_0.id, [ group0Object.id ], function (error) {
            expect(error).to.be(null);

            groups.getGroups(USER_0.id, function (error, groupIds) {
                expect(error).to.be(null);
                expect(groupIds.length).to.be(1);
                expect(groupIds[0]).to.be(group0Object.id);
                done();
            });
        });
    });

    it('can set user to multiple groups', function (done) {
        groups.setGroups(USER_0.id, [ group0Object.id, group1Object.id ], function (error) {
            expect(error).to.be(null);

            groups.getGroups(USER_0.id, function (error, groupIds) {
                expect(error).to.be(null);
                expect(groupIds.length).to.be(2);
                expect(groupIds.sort()).to.eql([ group0Object.id, group1Object.id ].sort());
                done();
            });
        });
    });
});

describe('Admin group', function () {
    before(function (done) {
        async.series([
            setup,
            userdb.add.bind(null, USER_0.id, USER_0)
        ], done);
    });
    after(cleanup);

    it('cannot delete admin group ever', function (done) {
        groups.remove(constants.ADMIN_GROUP_ID, function (error) {
            expect(error.reason).to.equal(GroupsError.NOT_ALLOWED);

            done();
        });
    });
});

describe('Roles', function () {
    before(function (done) {
        async.series([
            setup,
            userdb.add.bind(null, USER_0.id, USER_0),
            function (next) {
                groups.create(GROUP0_NAME, [ /* roles */ ], function (error, result) {
                    if (error) return next(error);
                    group0Object = result;

                    groups.setGroups(USER_0.id, [ group0Object.id ], next);
                });
            },
        ], done);
    });
    after(cleanup);

    it('can set roles', function (done) {
        groups.setRoles(group0Object.id, [ accesscontrol.ROLE_OWNER ], function (error) {
            expect(error).to.be(null);
            done();
        });
    });

    it('can get roles of a group', function (done) {
        groups.get(group0Object.id, function (error, result) {
            expect(error).to.be(null);
            expect(result.roles).to.eql([ accesscontrol.ROLE_OWNER ]);
            done();
        });
    });

    it('can get roles of a user', function (done) {
        groups.getRoles(USER_0.id, function (error, roles) {
            expect(roles.length).to.be(1);
            expect(roles[0]).to.be('owner');
            done();
        });
    });

    it('cannot set invalid role', function (done) {
        groups.setRoles(group0Object.id, [ accesscontrol.ROLE_OWNER, 'janitor' ], function (error) {
            expect(error).to.be.ok();
            done();
        });
    });
});
