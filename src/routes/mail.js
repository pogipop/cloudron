'use strict';

exports = module.exports = {
    getDomain: getDomain,
    addDomain: addDomain,
    getDomainStats: getDomainStats,
    removeDomain: removeDomain,

    setDnsRecords: setDnsRecords,

    getStatus: getStatus,

    setMailFromValidation: setMailFromValidation,
    setCatchAllAddress: setCatchAllAddress,
    setMailRelay: setMailRelay,
    setMailEnabled: setMailEnabled,

    sendTestMail: sendTestMail,

    getMailboxes: getMailboxes,
    getMailbox: getMailbox,
    addMailbox: addMailbox,
    updateMailbox: updateMailbox,
    removeMailbox: removeMailbox,

    listAliases: listAliases,
    getAliases: getAliases,
    setAliases: setAliases,

    getLists: getLists,
    getList: getList,
    addList: addList,
    updateList: updateList,
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

function auditSource(req) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
    return { ip: ip, username: req.user ? req.user.username : null, userId: req.user ? req.user.id : null };
}

function getDomain(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    mail.getDomain(req.params.domain, function (error, result) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, result));
    });
}

function addDomain(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.domain !== 'string') return next(new HttpError(400, 'domain must be a string'));

    mail.addDomain(req.body.domain, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.ALREADY_EXISTS) return next(new HttpError(409, 'domain already exists'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, { domain: req.body.domain }));
    });
}

function getDomainStats(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    var parsedUrl = url.parse(req.url, true /* parseQueryString */);
    delete parsedUrl.query['access_token'];
    delete req.headers['authorization'];
    delete req.headers['cookies'];

    req.url = url.format({ pathname: req.params.domain, query: parsedUrl.query });

    mailProxy(req, res, next);
}

function setDnsRecords(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');
    assert.strictEqual(typeof req.params.domain, 'string');

    mail.setDnsRecords(req.params.domain, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.EXTERNAL_ERROR) return next(new HttpError(424, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201));
    });
}

function removeDomain(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    mail.removeDomain(req.params.domain, function (error) {
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

    if (!req.body.addresses) return next(new HttpError(400, 'addresses is required'));
    if (!Array.isArray(req.body.addresses)) return next(new HttpError(400, 'addresses must be an array of strings'));

    for (var i = 0; i < req.body.addresses.length; i++) {
        if (typeof req.body.addresses[i] !== 'string') return next(new HttpError(400, 'addresses must be an array of strings'));
    }

    mail.setCatchAllAddress(req.params.domain, req.body.addresses, function (error) {
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
        if (error && error.reason === MailError.BILLING_REQUIRED) return next(new HttpError(402, error.message));
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

function getMailbox(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.name, 'string');

    mail.getMailbox(req.params.name, req.params.domain, function (error, result) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { mailbox: result }));
    });
}

function addMailbox(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    if (typeof req.body.name !== 'string') return next(new HttpError(400, 'name must be a string'));
    if (typeof req.body.userId !== 'string') return next(new HttpError(400, 'userId must be a string'));

    mail.addMailbox(req.body.name, req.params.domain, req.body.userId, auditSource(req), function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.ALREADY_EXISTS) return next(new HttpError(409, error.message));
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, {}));
    });
}

function updateMailbox(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.name, 'string');

    if (typeof req.body.userId !== 'string') return next(new HttpError(400, 'userId must be a string'));

    mail.updateMailbox(req.params.name, req.params.domain, req.body.userId, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204));
    });
}

function removeMailbox(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.name, 'string');

    mail.removeMailbox(req.params.name, req.params.domain, auditSource(req), function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, {}));
    });
}

function listAliases(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    mail.listAliases(req.params.domain, function (error, result) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { aliases: result }));
    });
}

function getAliases(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.name, 'string');

    mail.getAliases(req.params.name, req.params.domain, function (error, result) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { aliases: result }));
    });
}

function setAliases(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.name, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (!Array.isArray(req.body.aliases)) return next(new HttpError(400, 'aliases must be an array'));

    for (var i = 0; i < req.body.aliases.length; i++) {
        if (typeof req.body.aliases[i] !== 'string') return next(new HttpError(400, 'alias must be a string'));
    }

    mail.setAliases(req.params.name, req.params.domain, req.body.aliases, function (error) {
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
    assert.strictEqual(typeof req.params.name, 'string');

    mail.getList(req.params.domain, req.params.name, function (error, result) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { list: result }));
    });
}

function addList(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.name !== 'string') return next(new HttpError(400, 'name must be a string'));
    if (!Array.isArray(req.body.members)) return next(new HttpError(400, 'members must be a string'));

    for (var i = 0; i < req.body.members.length; i++) {
        if (typeof req.body.members[i] !== 'string') return next(new HttpError(400, 'member must be a string'));
    }

    mail.addList(req.body.name, req.params.domain, req.body.members, auditSource(req), function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.ALREADY_EXISTS) return next(new HttpError(409, 'list already exists'));
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, {}));
    });
}

function updateList(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.name, 'string');

    if (!Array.isArray(req.body.members)) return next(new HttpError(400, 'members must be a string'));

    for (var i = 0; i < req.body.members.length; i++) {
        if (typeof req.body.members[i] !== 'string') return next(new HttpError(400, 'member must be a string'));
    }

    mail.updateList(req.params.name, req.params.domain, req.body.members, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204));
    });
}

function removeList(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.name, 'string');

    mail.removeList(req.params.name, req.params.domain, auditSource(req), function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204));
    });
}
