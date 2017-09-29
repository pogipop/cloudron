'use strict';

var fs = require('fs'),
    mkdirp = require('mkdirp'),
    path = require('path'),
    rimraf = require('rimraf');

exports = module.exports = {
    createTree: createTree
};

function createTree(root, obj) {
    rimraf.sync(root);
    mkdirp.sync(root);

    function createSubTree(tree, curpath) {
        for (var key in tree) {
            if (typeof tree[key] === 'string') {
                if (key.startsWith('link:')) {
                    fs.symlinkSync(tree[key], path.join(curpath, key.slice(5)));
                } else {
                    fs.writeFileSync(path.join(curpath, key), tree[key], 'utf8');
                }
            } else {
                fs.mkdirSync(path.join(curpath, key));
                createSubTree(tree[key], path.join(curpath, key));
            }
        }
    }

    createSubTree(obj, root);
}

