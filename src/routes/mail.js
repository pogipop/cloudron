'use strict';

exports = module.exports = {
    get: get,

    add: add,
    getStats: getStats,
    update: update,
    del: del,

    getStatus: getStatus,

    setMailFromValidation: setMailFromValidation,
    setCatchAllAddress: setCatchAllAddress,
    setMailRelay: setMailRelay,
    setMailEnabled: setMailEnabled,

    sendTestMail: sendTestMail,

    getMailboxes: getMailboxes,
    getUserMailbox: getUserMailbox,
    enableUserMailbox: enableUserMailbox,
    disableUserMailbox: disableUserMailbox,

    getAliases: getAliases,
    getUserAliases: getUserAliases,
    setUserAliases: setUserAliases,

    getLists: getLists,
    getList: getList,
    addList: addList,
    removeList: removeList
};

var assert = require('assert'),
    mail = require('../mail.js'),
    MailError = mail.MailError,
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    middleware = require('../middleware/index.js'),
    url = require('url');

var mailProxy = middleware.proxy(url.parse('http://127.0.0.1:2020'));

function get(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    mail.get(req.params.domain, function (error, result) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, result));
    });
}

function add(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.domain !== 'string') return next(new HttpError(400, 'domain must be a string'));

    mail.add(req.body.domain, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.ALREADY_EXISTS) return next(new HttpError(409, 'domain already exists'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, { domain: req.body.domain }));
    });
}

function getStats(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    var parsedUrl = url.parse(req.url, true /* parseQueryString */);
    delete parsedUrl.query['access_token'];
    delete req.headers['authorization'];
    delete req.headers['cookies'];

    req.url = url.format({ pathname: req.params.domain, query: parsedUrl.query });

    mailProxy(req, res, next);
}

function update(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');
    assert.strictEqual(typeof req.params.domain, 'string');

    mail.update(req.params.domain, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function del(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    mail.del(req.params.domain, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.IN_USE) return next(new HttpError(409, 'Mail domain is still in use. Remove existing mailboxes'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204));
    });
}

function getStatus(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    // can take a while to query all the DNS entries
    req.clearTimeout();

    mail.getStatus(req.params.domain, function (error, records) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, records));
    });
}

function setMailFromValidation(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.enabled !== 'boolean') return next(new HttpError(400, 'enabled is required'));

    mail.setMailFromValidation(req.params.domain, req.body.enabled, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function setCatchAllAddress(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.address || !Array.isArray(req.body.address)) return next(new HttpError(400, 'address array is required'));

    for (var i = 0; i < req.body.address.length; i++) {
        if (typeof req.body.address[i] !== 'string') return next(new HttpError(400, 'address must be an array of string'));
    }

    mail.setCatchAllAddress(req.params.domain, req.body.address, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function setMailRelay(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.provider !== 'string') return next(new HttpError(400, 'provider is required'));
    if ('host' in req.body && typeof req.body.host !== 'string') return next(new HttpError(400, 'host must be a string'));
    if ('port' in req.body && typeof req.body.port !== 'number') return next(new HttpError(400, 'port must be a string'));
    if ('username' in req.body && typeof req.body.username !== 'string') return next(new HttpError(400, 'username must be a string'));
    if ('password' in req.body && typeof req.body.password !== 'string') return next(new HttpError(400, 'password must be a string'));

    mail.setMailRelay(req.params.domain, req.body, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function setMailEnabled(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.enabled !== 'boolean') return next(new HttpError(400, 'enabled is required'));

    mail.setMailEnabled(req.params.domain, !!req.body.enabled, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function sendTestMail(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.to || typeof req.body.to !== 'string') return next(new HttpError(400, 'to must be a non-empty string'));

    mail.sendTestMail(req.params.domain, req.body.to, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function getMailboxes(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    mail.getMailboxes(req.params.domain, function (error, result) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { mailboxes: result }));
    });
}

function getUserMailbox(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.userId, 'string');

    mail.getUserMailbox(req.params.domain, req.params.userId, function (error, result) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { mailbox: result }));
    });
}

function enableUserMailbox(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.userId, 'string');

    mail.enableUserMailbox(req.params.domain, req.params.userId, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.ALREADY_EXISTS) return next(new HttpSuccess(201, {}));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, {}));
    });
}

function disableUserMailbox(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.userId, 'string');

    mail.disableUserMailbox(req.params.domain, req.params.userId, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpSuccess(201, {}));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, {}));
    });
}

function getAliases(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    mail.getAliases(req.params.domain, function (error, result) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { aliases: result }));
    });
}

function getUserAliases(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.userId, 'string');

    mail.getUserAliases(req.params.domain, req.params.userId, function (error, result) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { aliases: result }));
    });
}

function setUserAliases(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.userId, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (!Array.isArray(req.body.aliases)) return next(new HttpError(400, 'aliases must be an array'));

    for (var i = 0; i < req.body.aliases.length; i++) {
        if (typeof req.body.aliases[i] !== 'string') return next(new HttpError(400, 'alias must be a string'));
    }

    mail.setUserAliases(req.params.domain, req.params.userId, req.body.aliases, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.ALREADY_EXISTS) return next(new HttpError(409, error.message));
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function getLists(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    mail.getLists(req.params.domain, function (error, result) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { lists: result }));
    });
}

function getList(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.groupId, 'string');

    mail.getList(req.params.domain, req.params.groupId, function (error, result) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { list: result }));
    });
}

function addList(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.groupId !== 'string') return next(new HttpError(400, 'groupId must be a string'));

    mail.addList(req.params.domain, req.body.groupId, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.ALREADY_EXISTS) return next(new HttpError(409, 'list already exists'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, {}));
    });
}

function removeList(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.groupId, 'string');

    mail.removeList(req.params.domain, req.params.groupId, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204));
    });
}
