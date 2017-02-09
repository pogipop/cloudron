angular.module('ngTld', [])
    .factory('ngTld', ngTld)
    .directive('checkTld', checkTld);

function ngTld() {
    var tldExists = function($path) {
        return tld.tldExists($path.$viewValue);
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

