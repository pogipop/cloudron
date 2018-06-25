'use strict';

exports = module.exports = {
    get: get,
    list: list,
    create: create,
    update: update,
    remove: remove,
    updateMembers: updateMembers
};

var assert = require('assert'),
    groups = require('../groups.js'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    GroupsError = groups.GroupsError;

function create(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.name !== 'string') return next(new HttpError(400, 'name must be string'));
    if ('roles' in req.body) {
        if (!Array.isArray(req.body.roles)) return next(new HttpError(400, 'roles must be an array'));
        for (let role of req.body.roles) {
            if (typeof role !== 'string') return next(new HttpError(400, 'roles must be an array of strings'));
        }
    }

    groups.create(req.body.name, req.body.roles || [ ], function (error, group) {
        if (error && error.reason === GroupsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === GroupsError.ALREADY_EXISTS) return next(new HttpError(409, 'Already exists'));
        if (error) return next(new HttpError(500, error));

        var groupInfo = {
            id: group.id,
            name: group.name
        };

        next(new HttpSuccess(201, groupInfo));
    });
}

function get(req, res, next) {
    assert.strictEqual(typeof req.params.groupId, 'string');

    groups.getWithMembers(req.params.groupId, function (error, result) {
        if (error && error.reason === GroupsError.NOT_FOUND) return next(new HttpError(404, 'No such group'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, result));
    });
}

function update(req, res, next) {
    assert.strictEqual(typeof req.params.groupId, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if ('name' in req.body && typeof req.body.name !== 'string') return next(new HttpError(400, 'name must be a string'));

    if ('roles' in req.body) {
        if (!Array.isArray(req.body.roles)) return next(new HttpError(400, 'roles must be an array'));
        for (let role of req.body.roles) {
            if (typeof role !== 'string') return next(new HttpError(400, 'roles must be an array of strings'));
        }
    }

    groups.update(req.params.groupId, req.body, function (error) {
        if (error && error.reason === GroupsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { }));
    });
}

function updateMembers(req, res, next) {
    assert.strictEqual(typeof req.params.groupId, 'string');

    if (!req.body.userIds) return next(new HttpError(404, 'missing or invalid userIds fields'));
    if (!Array.isArray(req.body.userIds)) return next(new HttpError(404, 'userIds must be an array'));

    groups.setMembers(req.params.groupId, req.body.userIds, function (error) {
        if (error && error.reason === GroupsError.NOT_FOUND) return next(new HttpError(404, 'Invalid group or user id'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200));
    });
}

function list(req, res, next) {
    groups.getAll(function (error, result) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { groups: result }));
    });
}

function remove(req, res, next) {
    assert.strictEqual(typeof req.params.groupId, 'string');

    groups.remove(req.params.groupId, function (error) {
        if (error && error.reason === GroupsError.NOT_FOUND) return next(new HttpError(404, 'Group not found'));
        if (error && error.reason === GroupsError.NOT_ALLOWED) return next(new HttpError(409, 'Group deletion not allowed'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204));
    });
}
