'use strict';

/* global angular:false */
/* global showdown:false */

// deal with accessToken in the query, this is passed for example on password reset and account setup upon invite
var search = decodeURIComponent(window.location.search).slice(1).split('&').map(function (item) { return item.split('='); }).reduce(function (o, k) { o[k[0]] = k[1]; return o; }, {});
if (search.accessToken) {
    localStorage.token = search.accessToken;

    // strip the accessToken and expiresAt, then preserve the rest
    delete search.accessToken;
    delete search.expiresAt;

    // this will reload the page as this is not a hash change
    window.location.search = encodeURIComponent(Object.keys(search).map(function (key) { return key + '=' + search[key]; }).join('&'));
}


// create main application module
var app = angular.module('Application', ['ngFitText', 'ngRoute', 'ngAnimate', 'ngSanitize', 'angular-md5', 'base64', 'slick', 'ui-notification', 'ui.bootstrap', 'ui.bootstrap-slider', 'ngTld', 'ui.multiselect']);

app.config(['NotificationProvider', function (NotificationProvider) {
    NotificationProvider.setOptions({
        delay: 5000,
        startTop: 60,
        positionX: 'left',
        maxCount: 3,
        templateUrl: 'notification.html'
    });
}]);

// setup all major application routes
app.config(['$routeProvider', function ($routeProvider) {
    $routeProvider.when('/', {
        redirectTo: '/apps'
    }).when('/users', {
        controller: 'UsersController',
        templateUrl: 'views/users.html'
    }).when('/appstore', {
        controller: 'AppStoreController',
        templateUrl: 'views/appstore.html'
    }).when('/appstore/:appId', {
        controller: 'AppStoreController',
        templateUrl: 'views/appstore.html'
    }).when('/apps', {
        controller: 'AppsController',
        templateUrl: 'views/apps.html'
    }).when('/account', {
        controller: 'AccountController',
        templateUrl: 'views/account.html'
    }).when('/graphs', {
        controller: 'GraphsController',
        templateUrl: 'views/graphs.html'
    }).when('/debug', {
        controller: 'DebugController',
        templateUrl: 'views/debug.html'
    }).when('/certs', {
        controller: 'CertsController',
        templateUrl: 'views/certs.html'
    }).when('/email', {
        controller: 'EmailController',
        templateUrl: 'views/email.html'
    }).when('/settings', {
        controller: 'SettingsController',
        templateUrl: 'views/settings.html'
    }).when('/activity', {
        controller: 'ActivityController',
        templateUrl: 'views/activity.html'
    }).when('/support', {
        controller: 'SupportController',
        templateUrl: 'views/support.html'
    }).when('/tokens', {
        controller: 'TokensController',
        templateUrl: 'views/tokens.html'
    }).otherwise({ redirectTo: '/'});
}]);

// keep in sync with appdb.js
var ISTATES = {
    PENDING_INSTALL: 'pending_install',
    PENDING_CLONE: 'pending_clone',
    PENDING_CONFIGURE: 'pending_configure',
    PENDING_UNINSTALL: 'pending_uninstall',
    PENDING_RESTORE: 'pending_restore',
    PENDING_UPDATE: 'pending_update',
    PENDING_FORCE_UPDATE: 'pending_force_update',
    PENDING_BACKUP: 'pending_backup',
    ERROR: 'error',
    INSTALLED: 'installed'
};
var HSTATES = {
    HEALTHY: 'healthy',
    UNHEALTHY: 'unhealthy',
    ERROR: 'error',
    DEAD: 'dead'
};

app.filter('installError', function () {
    return function (app) {
        if (app.installationState === ISTATES.ERROR) return true;
        if (app.installationState === ISTATES.INSTALLED) {
            // app.health can also be null to indicate insufficient data
            if (app.health === HSTATES.UNHEALTHY || app.health === HSTATES.ERROR || app.health === HSTATES.DEAD) return true;
        }

        return false;
    };
});

app.filter('installSuccess', function () {
    return function (app) {
        return app.installationState === ISTATES.INSTALLED;
    };
});

app.filter('activeOAuthClients', function () {
    return function (clients, user) {
        return clients.filter(function (c) { return user.admin || (c.activeTokens && c.activeTokens.length > 0); });
    };
});

app.filter('prettyAppMessage', function () {
    return function (message) {
        if (message === 'ETRYAGAIN') return 'The DNS record for this location is not setup correctly. Please verify your DNS settings and repair this app.';
        if (message === 'DNS Record already exists') return 'The DNS record for this location already exists. Manually remove the DNS record and then click on repair.';
        return message;
    };
});

app.filter('shortAppMessage', function () {
    return function (message) {
        if (message === 'ETRYAGAIN') return 'DNS record not setup correctly';
        return message;
    };
});

app.filter('prettyMemory', function () {
    return function (memory) {
        // Adjust the default memory limit if it changes
        return memory ? Math.floor(memory / 1024 / 1024) : 256;
    };
});

app.filter('installationActive', function () {
    return function(app) {
        if (app.installationState === ISTATES.ERROR) return false;
        if (app.installationState === ISTATES.INSTALLED) return false;
        return true;
    };
});

app.filter('installationStateLabel', function() {
    // for better DNS errors
    function detailedError(app) {
        if (app.installationProgress === 'ETRYAGAIN') return 'DNS Error';
        return 'Error';
    }

    return function(app) {
        var waiting = app.progress === 0 ? ' (Waiting)' : '';

        switch (app.installationState) {
        case ISTATES.PENDING_INSTALL:
        case ISTATES.PENDING_CLONE:
            return 'Installing' + waiting;
        case ISTATES.PENDING_CONFIGURE: return 'Configuring' + waiting;
        case ISTATES.PENDING_UNINSTALL: return 'Uninstalling' + waiting;
        case ISTATES.PENDING_RESTORE: return 'Restoring' + waiting;
        case ISTATES.PENDING_UPDATE: return 'Updating' + waiting;
        case ISTATES.PENDING_FORCE_UPDATE: return 'Updating' + waiting;
        case ISTATES.PENDING_BACKUP: return 'Backing up' + waiting;
        case ISTATES.ERROR: return detailedError(app);
        case ISTATES.INSTALLED: {
            if (app.runState === 'running') {
                if (!app.health) return 'Starting...'; // no data yet
                if (app.health === HSTATES.HEALTHY) return 'Running';
                return 'Not responding'; // dead/exit/unhealthy
            } else if (app.runState === 'pending_start') return 'Starting...';
            else if (app.runState === 'pending_stop') return 'Stopping...';
            else if (app.runState === 'stopped') return 'Stopped';
            else return app.runState;
            break;
        }
        default: return app.installationState;
        }
    };
});

app.filter('readyToUpdate', function () {
    return function (apps) {
        return apps.every(function (app) {
            return (app.installationState === ISTATES.ERROR) || (app.installationState === ISTATES.INSTALLED);
        });
    };
});

app.filter('inProgressApps', function () {
    return function (apps) {
        return apps.filter(function (app) {
            return app.installationState !== ISTATES.ERROR && app.installationState !== ISTATES.INSTALLED;
        });
    };
});

app.filter('ignoreAdminGroup', function () {
    return function (groups) {
        return groups.filter(function (group) {
            if (group.id) return group.id !== 'admin';
            return group !== 'admin';
        });
    };
});

app.filter('applicationLink', function() {
    return function(app) {
        if (app.installationState === ISTATES.INSTALLED && app.health === HSTATES.HEALTHY) {
            return 'https://' + app.fqdn;
        } else {
            return '';
        }
    };
});

app.filter('prettyHref', function () {
    return function (input) {
        if (!input) return input;
        if (input.indexOf('http://') === 0) return input.slice('http://'.length);
        if (input.indexOf('https://') === 0) return input.slice('https://'.length);
        return input;
    };
});

app.filter('prettyDate', function () {
    // http://ejohn.org/files/pretty.js
    return function prettyDate(time) {
        var date = new Date(time),
            diff = (((new Date()).getTime() - date.getTime()) / 1000) + 30, // add 30seconds for clock skew
            day_diff = Math.floor(diff / 86400);

        if (isNaN(day_diff) || day_diff < 0)
            return 'just now';

        return day_diff === 0 && (
                diff < 60 && 'just now' ||
                diff < 120 && '1 minute ago' ||
                diff < 3600 && Math.floor( diff / 60 ) + ' minutes ago' ||
                diff < 7200 && '1 hour ago' ||
                diff < 86400 && Math.floor( diff / 3600 ) + ' hours ago') ||
            day_diff === 1 && 'Yesterday' ||
            day_diff < 7 && day_diff + ' days ago' ||
            day_diff < 31 && Math.ceil( day_diff / 7 ) + ' weeks ago' ||
            day_diff < 365 && Math.round( day_diff / 30 ) +  ' months ago' ||
                              Math.round( day_diff / 365 ) + ' years ago';
    };
});

app.filter('markdown2html', function () {
    var converter = new showdown.Converter({
        extensions: ['targetblank'],
        simplifiedAutoLink: true,
        strikethrough: true,
        tables: true
    });

    return function (text) {
        return converter.makeHtml(text);
    };
});

app.filter('postInstallMessage', function () {
    var SSO_MARKER = '=== sso ===';

    return function (text, app) {
        if (!text) return '';
        if (!app) return text;

        var parts = text.split(SSO_MARKER);
        if (parts.length === 1) {
            // [^] matches even newlines. '?' makes it non-greedy
            if (app.sso) return text.replace(/\<nosso\>[^]*?\<\/nosso\>/g, '');
            else return text.replace(/\<sso\>[^]*?\<\/sso\>/g, '');
        }

        if (app.sso) return parts[1];
        else return parts[0];
    };
});


// keep this in sync with eventlog.js and CLI tool
var ACTION_ACTIVATE = 'cloudron.activate';
var ACTION_APP_CONFIGURE = 'app.configure';
var ACTION_APP_INSTALL = 'app.install';
var ACTION_APP_RESTORE = 'app.restore';
var ACTION_APP_UNINSTALL = 'app.uninstall';
var ACTION_APP_UPDATE = 'app.update';
var ACTION_APP_UPDATE = 'app.update';
var ACTION_APP_LOGIN = 'app.login';
var ACTION_BACKUP_FINISH = 'backup.finish';
var ACTION_BACKUP_START = 'backup.start';
var ACTION_CERTIFICATE_RENEWAL = 'certificate.renew';
var ACTION_CLI_MODE = 'settings.climode';
var ACTION_START = 'cloudron.start';
var ACTION_UPDATE = 'cloudron.update';
var ACTION_USER_ADD = 'user.add';
var ACTION_USER_LOGIN = 'user.login';
var ACTION_USER_REMOVE = 'user.remove';
var ACTION_USER_UPDATE = 'user.update';

app.filter('eventLogDetails', function() {
    // NOTE: if you change this, the CLI tool (cloudron machine eventlog) probably needs fixing as well
    return function(eventLog) {
        var source = eventLog.source;
        var data = eventLog.data;
        var errorMessage = data.errorMessage;

        switch (eventLog.action) {
        case ACTION_ACTIVATE: return 'Cloudron activated';
        case ACTION_APP_CONFIGURE: return 'App ' + data.appId + ' was configured';
        case ACTION_APP_INSTALL: return 'App ' + data.manifest.id + '@' + data.manifest.version + ' installed at ' + data.location + ' with id ' + data.appId;
        case ACTION_APP_RESTORE: return 'App ' + data.appId + ' restored';
        case ACTION_APP_UNINSTALL: return 'App ' + data.appId + ' uninstalled';
        case ACTION_APP_UPDATE: return 'App ' + data.appId + ' updated to version ' + data.toManifest.id + '@' + data.toManifest.version;
        case ACTION_APP_LOGIN: return 'App ' + data.appId + ' logged in';
        case ACTION_BACKUP_START: return 'Backup started';
        case ACTION_BACKUP_FINISH: return 'Backup finished. ' + (errorMessage ? ('error: ' + errorMessage) : ('id: ' + data.filename));
        case ACTION_CERTIFICATE_RENEWAL: return 'Certificate renewal for ' + data.domain + (errorMessage ? ' failed' : 'succeeded');
        case ACTION_CLI_MODE: return 'CLI mode was ' + (data.enabled ? 'enabled' : 'disabled');
        case ACTION_START: return 'Cloudron started with version ' + data.version;
        case ACTION_UPDATE: return 'Updating to version ' + data.boxUpdateInfo.version;
        case ACTION_USER_ADD: return 'User ' + data.email + ' added with id ' + data.userId;
        case ACTION_USER_LOGIN: return 'User ' + data.userId + ' logged in';
        case ACTION_USER_REMOVE: return 'User ' + data.userId + ' removed';
        case ACTION_USER_UPDATE: return 'User ' + data.userId + ' updated';
        default: return eventLog.action;
        }
    };
});

// custom directive for dynamic names in forms
// See http://stackoverflow.com/questions/23616578/issue-registering-form-control-with-interpolated-name#answer-23617401
app.directive('laterName', function () {                   // (2)
    return {
        restrict: 'A',
        require: ['?ngModel', '^?form'],                   // (3)
        link: function postLink(scope, elem, attrs, ctrls) {
            attrs.$set('name', attrs.laterName);

            var modelCtrl = ctrls[0];                      // (3)
            var formCtrl  = ctrls[1];                      // (3)
            if (modelCtrl && formCtrl) {
                modelCtrl.$name = attrs.name;              // (4)
                formCtrl.$addControl(modelCtrl);           // (2)
                scope.$on('$destroy', function () {
                    formCtrl.$removeControl(modelCtrl);    // (5)
                });
            }
        }
    };
});

app.run(['$route', '$rootScope', '$location', function ($route, $rootScope, $location) {
    var original = $location.path;
    $location.path = function (path, reload) {
        if (reload === false) {
            var lastRoute = $route.current;
            var un = $rootScope.$on('$locationChangeSuccess', function () {
                $route.current = lastRoute;
                un();
            });
        }
        return original.apply($location, [path]);
    };
}]);

app.directive('ngClickSelect', function () {
    return {
        restrict: 'AC',
        link: function (scope, element, attrs) {
            element.bind('click', function () {
                var selection = window.getSelection();
                var range = document.createRange();
                range.selectNodeContents(this);
                selection.removeAllRanges();
                selection.addRange(range);
            });
        }
    };
});

app.directive('ngClickReveal', function () {
    return {
        restrict: 'A',
        link: function (scope, element, attrs) {
            element.addClass('hand');

            var value = '';

            scope.$watch(attrs.ngClickReveal, function (newValue, oldValue) {
                if (newValue !== oldValue) {
                    element.html('<i>hidden</i>');
                    value = newValue;
                }
            });

            element.bind('click', function () {
                element.text(value);
            });
        }
    };
});

// https://codepen.io/webmatze/pen/isuHh
app.directive('tagInput', function () {
    return {
        restrict: 'E',
        scope: {
            inputTags: '=taglist'
        },
        link: function ($scope, element, attrs) {
            $scope.defaultWidth = 200;
            $scope.tagText = ''; // current tag being edited
            $scope.placeholder = attrs.placeholder;
            $scope.tagArray = function () {
                if ($scope.inputTags === undefined) {
                    return [];
                }
                return $scope.inputTags.split(',').filter(function (tag) {
                    return tag !== '';
                });
            };
            $scope.addTag = function () {
                var tagArray;
                if ($scope.tagText.length === 0) {
                    return;
                }
                tagArray = $scope.tagArray();
                tagArray.push($scope.tagText);
                $scope.inputTags = tagArray.join(',');
                return $scope.tagText = '';
            };
            $scope.deleteTag = function (key) {
                var tagArray;
                tagArray = $scope.tagArray();
                if (tagArray.length > 0 && $scope.tagText.length === 0 && key === undefined) {
                    tagArray.pop();
                } else {
                    if (key !== undefined) {
                        tagArray.splice(key, 1);
                    }
                }
                return $scope.inputTags = tagArray.join(',');
            };
            $scope.$watch('tagText', function (newVal, oldVal) {
                var tempEl;
                if (!(newVal === oldVal && newVal === undefined)) {
                    tempEl = $('<span>' + newVal + '</span>').appendTo('body');
                    $scope.inputWidth = tempEl.width() + 5;
                    if ($scope.inputWidth < $scope.defaultWidth) {
                        $scope.inputWidth = $scope.defaultWidth;
                    }
                    return tempEl.remove();
                }
            });
            element.bind('keydown', function (e) {
                var key = e.which;
                if (key === 9 || key === 13) {
                    e.preventDefault();
                }
                if (key === 8) {
                    return $scope.$apply('deleteTag()');
                }
            });
            element.bind('keyup', function (e) {
                var key = e.which;
                if (key === 9 || key === 13 || key === 32 || key === 188) {
                    e.preventDefault();
                    return $scope.$apply('addTag()');
                }
            });
        },
        template:
            '<div class="tag-input-container">' +
                '<div class="input-tag" data-ng-repeat="tag in tagArray()">' +
                    '{{tag}}' +
                    '<div class="delete-tag" data-ng-click="deleteTag($index)">&times;</div>' +
                '</div>' +
                '<input type="text" data-ng-model="tagText" ng-blur="addTag()" placeholder="{{placeholder}}"/>' +
            '</div>'
    };
});

app.config(['fitTextConfigProvider', function (fitTextConfigProvider) {
  fitTextConfigProvider.config = {
    loadDelay: 250,
    compressor: 0.9,
    min: 8,
    max: 24
  };
}]);
