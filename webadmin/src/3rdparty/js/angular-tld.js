// !!!
// This module is manually patched by us to not only report valid domains, but verify that subdomains are not accepted
// !!!

angular.module('ngTld', [])
    .factory('ngTld', ngTld)
    .directive('checkTld', checkTld);

function ngTld() {
    function tldExists($path) {
        // https://github.com/oncletom/tld.js/issues/58
        return ($path.$viewValue.slice(-1) !== '.') && $path.$viewValue === tld.getDomain($path.$viewValue);
    }

    function isSubdomain($path) {
        return ($path.$viewValue.slice(-1) !== '.') && !!tld.getDomain($path.$viewValue) && $path.$viewValue !== tld.getDomain($path.$viewValue);
    }

    return {
        tldExists: tldExists,
        isSubdomain: isSubdomain
    };
}

function checkTld(ngTld) {
    return {
        restrict: 'A',
        require: 'ngModel',
        link: function(scope, element, attr, ngModel) {
            ngModel.$validators.invalidTld = function(modelValue, viewValue) {
                return ngTld.tldExists(ngModel);
            };

            ngModel.$validators.invalidSubdomain = function(modelValue, viewValue) {
                return !ngTld.isSubdomain(ngModel);
            };
        }
    };
}

