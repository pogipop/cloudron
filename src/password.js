/* jslint node:true */

'use strict';

// From https://www.npmjs.com/package/password-generator

exports = module.exports = {
    generate: generate
};

var assert = require('assert'),
    generatePassword = require('password-generator');

// http://www.w3resource.com/javascript/form/example4-javascript-form-validation-password.html
// WARNING!!! if this is changed, the UI parts in the setup and account view have to be adjusted!
var gPasswordTestRegExp = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[^a-zA-Z0-9])(?!.*\s).{8,30}$/;

var UPPERCASE_RE = /([A-Z])/g;
var LOWERCASE_RE = /([a-z])/g;
var NUMBER_RE = /([\d])/g;
var SPECIAL_CHAR_RE = /([\?\-])/g;

function isStrongEnough(password) {
    var uc = password.match(UPPERCASE_RE);
    var lc = password.match(LOWERCASE_RE);
    var n = password.match(NUMBER_RE);
    var sc = password.match(SPECIAL_CHAR_RE);

    return uc && lc && n && sc;
}

function generate() {
    var password = '';

    while (!isStrongEnough(password)) password = generatePassword(8, false, /[\w\d\?\-]/);

    return password;
}
