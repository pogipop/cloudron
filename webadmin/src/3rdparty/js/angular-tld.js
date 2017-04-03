// !!!
// This module is manually patched by us to not only report valid domains, but verify that subdomains are not accepted
// !!!
'use strict';

angular.module('ngTld', [])
    .factory('ngTld', ngTld)
    .directive('checkTld', checkTld);

function ngTld() {
    function tldExists(path) {
        // https://github.com/oncletom/tld.js/issues/58
        return (path.slice(-1) !== '.') && path === tld.getDomain(path);
    }

    function isSubdomain(path) {
        return (path.slice(-1) !== '.') && !!tld.getDomain(path) && path !== tld.getDomain(path);
    }

    function isNakedDomain(path) {
        return (path.slice(-1) !== '.') && !!tld.getDomain(path) && path === tld.getDomain(path);
    }

    return {
        tldExists: tldExists,
        isSubdomain: isSubdomain,
        isNakedDomain: isNakedDomain
    };
}

function checkTld(ngTld) {
    return {
        restrict: 'A',
        require: 'ngModel',
        link: function(scope, element, attr, ngModel) {
            ngModel.$validators.invalidTld = function(modelValue, viewValue) {
                return ngTld.tldExists(ngModel.$viewValue);
            };

            ngModel.$validators.invalidSubdomain = function(modelValue, viewValue) {
                return !ngTld.isSubdomain(ngModel.$viewValue);
            };
        }
    };
}
