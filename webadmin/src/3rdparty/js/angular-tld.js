// !!!
// This module is manually patched by us to not only report valid domains, but verify that subdomains are not accepted
// !!!

angular.module('ngTld', [])
    .factory('ngTld', ngTld)
    .directive('checkTld', checkTld);

function ngTld() {
    var tldExists = function($path) {
        return $path.$viewValue === tld.getDomain($path.$viewValue);
    }

    return {
        tldExists: tldExists,
    }
}

function checkTld(ngTld) {
    return {
        restrict: 'A',
        require: 'ngModel',
        link: function(scope, element, attr, ngModel) {
            ngModel.$validators.invalidTld = function(modelValue, viewValue) {
                var status = true;
                status = ngTld.tldExists(ngModel);
                return status;
            }
        }
    }
}

