'use strict';

angular.module('Application').controller('AppStoreController', ['$scope', '$location', '$timeout', '$routeParams', 'Client', 'AppStore', function ($scope, $location, $timeout, $routeParams, Client, AppStore) {
    Client.onReady(function () { if (!Client.getUserInfo().admin) $location.path('/'); });

    $scope.HOST_PORT_MIN = 1024;
    $scope.HOST_PORT_MAX = 65535;

    $scope.ready = false;
    $scope.apps = [];
    $scope.config = Client.getConfig();
    $scope.user = Client.getUserInfo();
    $scope.users = [];
    $scope.groups = [];
    $scope.dnsConfig = {};
    $scope.category = '';
    $scope.cachedCategory = ''; // used to cache the selected category while searching
    $scope.searchString = '';
    $scope.validAppstoreAccount = false;
    $scope.appstoreConfig = null;
    $scope.mailConfig = {};

    $scope.showView = function (view) {
        // wait for dialog to be fully closed to avoid modal behavior breakage when moving to a different view already
        $('.modal').on('hidden.bs.modal', function () {
            $scope.appInstall.reset();
            $('.modal').off('hidden.bs.modal');
            $location.path(view);
        });

        $('.modal').modal('hide');
    };

    $scope.appInstall = {
        busy: false,
        state: 'appInfo',
        error: {},
        app: {},
        location: '',
        portBindings: {},
        mediaLinks: [],
        certificateFile: null,
        certificateFileName: '',
        keyFile: null,
        keyFileName: '',
        accessRestrictionOption: 'any',
        accessRestriction: { users: [], groups: [] },
        customAuth: false,
        optionalSso: false,

        isAccessRestrictionValid: function () {
            var tmp = $scope.appInstall.accessRestriction;
            return !!(tmp.users.length || tmp.groups.length);
        },

        reset: function () {
            $scope.appInstall.app = {};
            $scope.appInstall.error = {};
            $scope.appInstall.location = '';
            $scope.appInstall.portBindings = {};
            $scope.appInstall.state = 'appInfo';
            $scope.appInstall.mediaLinks = [];
            $scope.appInstall.certificateFile = null;
            $scope.appInstall.certificateFileName = '';
            $scope.appInstall.keyFile = null;
            $scope.appInstall.keyFileName = '';
            $scope.appInstall.accessRestrictionOption = 'any';
            $scope.appInstall.accessRestriction = { users: [], groups: [] };
            $scope.appInstall.optionalSso = false;
            $scope.appInstall.customAuth = false;

            $('#collapseInstallForm').collapse('hide');
            $('#collapseResourceConstraint').collapse('hide');
            $('#collapseMediaLinksCarousel').collapse('show');
            $('#postInstallMessage').collapse('hide');

            if ($scope.appInstallForm) {
                $scope.appInstallForm.$setPristine();
                $scope.appInstallForm.$setUntouched();
            }
        },

        showForm: function (force) {
            if (Client.enoughResourcesAvailable($scope.appInstall.app) || force) {
                $scope.appInstall.state = 'installForm';
                $('#collapseMediaLinksCarousel').collapse('hide');
                $('#collapseResourceConstraint').collapse('hide');
                $('#collapseInstallForm').collapse('show');
                $('#appInstallLocationInput').focus();
            } else {
                $scope.appInstall.state = 'resourceConstraint';
                $('#collapseMediaLinksCarousel').collapse('hide');
                $('#collapseResourceConstraint').collapse('show');
            }
        },

        show: function (app) {
            $scope.appInstall.reset();

            // make a copy to work with in case the app object gets updated while polling
            angular.copy(app, $scope.appInstall.app);

            $scope.appInstall.mediaLinks = $scope.appInstall.app.manifest.mediaLinks || [];
            $scope.appInstall.location = app.location;
            $scope.appInstall.portBindingsInfo = $scope.appInstall.app.manifest.tcpPorts || {};   // Portbinding map only for information
            $scope.appInstall.portBindings = {};                            // This is the actual model holding the env:port pair
            $scope.appInstall.portBindingsEnabled = {};                     // This is the actual model holding the enabled/disabled flag
            $scope.appInstall.accessRestrictionOption = app.accessRestriction ? 'groups' : 'any';
            $scope.appInstall.accessRestriction = app.accessRestriction || { users: [], groups: [] };

            var manifest = app.manifest;
            $scope.appInstall.optionalSso = !!manifest.optionalSso;
            $scope.appInstall.customAuth = !(manifest.addons['ldap'] || manifest.addons['oauth']);
            $scope.appInstall.accessRestrictionOption = 'any';

            // set default ports
            for (var env in $scope.appInstall.app.manifest.tcpPorts) {
                $scope.appInstall.portBindings[env] = $scope.appInstall.app.manifest.tcpPorts[env].defaultValue || 0;
                $scope.appInstall.portBindingsEnabled[env] = true;
            }

            $('#appInstallModal').modal('show');
        },

        submit: function () {
            $scope.appInstall.busy = true;
            $scope.appInstall.error.other = null;
            $scope.appInstall.error.location = null;
            $scope.appInstall.error.port = null;

            // only use enabled ports from portBindings
            var finalPortBindings = {};
            for (var env in $scope.appInstall.portBindings) {
                if ($scope.appInstall.portBindingsEnabled[env]) {
                    finalPortBindings[env] = $scope.appInstall.portBindings[env];
                }
            }

            var finalAccessRestriction = null;
            if ($scope.appInstall.accessRestrictionOption === 'groups') {
                finalAccessRestriction = { users: [], groups: [] };
                finalAccessRestriction.users = $scope.appInstall.accessRestriction.users.map(function (u) { return u.id; });
                finalAccessRestriction.groups = $scope.appInstall.accessRestriction.groups.map(function (g) { return g.id; });
            }

            var data = {
                location: $scope.appInstall.location || '',
                portBindings: finalPortBindings,
                accessRestriction: finalAccessRestriction,
                cert: $scope.appInstall.certificateFile,
                key: $scope.appInstall.keyFile,
                sso: !$scope.appInstall.optionalSso ? undefined : ($scope.appInstall.accessRestrictionOption !== 'nosso')
            };

            // add sso property for the postInstall message to be shown correctly
            $scope.appInstall.app.sso = data.sso;

            Client.installApp($scope.appInstall.app.id, $scope.appInstall.app.manifest, $scope.appInstall.app.title, data, function (error) {
                if (error) {
                    if (error.statusCode === 409 && (error.message.indexOf('is reserved') !== -1 || error.message.indexOf('is already in use') !== -1)) {
                        $scope.appInstall.error.port = error.message;
                    } else if (error.statusCode === 409) {
                        $scope.appInstall.error.location = 'This name is already taken.';
                        $scope.appInstallForm.location.$setPristine();
                        $('#appInstallLocationInput').focus();
                    } else if (error.statusCode === 400 && error.message.indexOf('cert') !== -1 ) {
                        $scope.appInstall.error.cert = error.message;
                        $scope.appInstall.certificateFileName = '';
                        $scope.appInstall.certificateFile = null;
                        $scope.appInstall.keyFileName = '';
                        $scope.appInstall.keyFile = null;
                    } else {
                        $scope.appInstall.error.other = error.message;
                    }

                    $scope.appInstall.busy = false;
                    return;
                }

                $scope.appInstall.busy = false;

                $scope.appInstall.postInstall();
            });
        },

        postInstall: function () {
            if ($scope.appInstall.app.manifest.postInstallMessage) {
                $scope.appInstall.state = 'postInstall';
                $('#collapseInstallForm').collapse('hide');
                $('#postInstallMessage').collapse('show');
                return;
            }

            $scope.appInstall.switchToAppsView();
        },

        switchToAppsView: function () {
            // wait for dialog to be fully closed to avoid modal behavior breakage when moving to a different view already
            $('#appInstallModal').on('hidden.bs.modal', function () {
                $scope.appInstall.reset();
                $('#appInstallModal').off('hidden.bs.modal');
                $location.path('/apps');
            });

            $('#appInstallModal').modal('hide');
        }
    };

    $scope.appNotFound = {
        appId: '',
        version: ''
    };

    $scope.feedback = {
        error: null,
        subject: 'App feedback',
        description: '',
        type: 'app_missing',

        reset: function () {
            $scope.feedback.busy = false;
            $scope.feedback.error = null;
            $scope.feedback.description = '';

            $scope.feedbackForm.$setUntouched();
            $scope.feedbackForm.$setPristine();
        },

        show: function () {
            $scope.feedback.reset();
            $('#feedbackModal').modal('show');
        },

        submit: function () {
            $scope.feedback.busy = true;
            $scope.feedback.error = null;

            Client.feedback($scope.feedback.type, $scope.feedback.subject, $scope.feedback.description, function (error) {
                $scope.feedback.busy = false;

                if (error) {
                    $scope.feedback.error = error;
                    console.error(error);
                    return;
                }

                $('#feedbackModal').modal('hide');
            });
        }
    };

    $scope.appstoreLogin = {
        busy: false,
        error: {},
        email: '',
        password: '',
        register: true,
        termsAccepted: false,

        submit: function () {
            $scope.appstoreLogin.error = {};
            $scope.appstoreLogin.busy = true;

            function login() {
                AppStore.login($scope.appstoreLogin.email, $scope.appstoreLogin.password, function (error, result) {
                    if (error) {
                        $scope.appstoreLogin.busy = false;

                        if (error.statusCode === 403) {
                            $scope.appstoreLogin.error.password = 'Wrong email or password';
                            $scope.appstoreLogin.password = '';
                            $('#inputAppstoreLoginPassword').focus();
                            $scope.appstoreLoginForm.password.$setPristine();
                        } else {
                            console.error(error);
                        }

                        return;
                    }

                    var config = {
                        userId: result.userId,
                        token: result.accessToken
                    };

                    Client.setAppstoreConfig(config, function (error) {
                        if (error) {
                            $scope.appstoreLogin.busy = false;

                            if (error.statusCode === 406) {
                                if (error.message === 'wrong user') {
                                    $scope.appstoreLogin.error.generic = 'Wrong cloudron.io account';
                                    $scope.appstoreLogin.email = '';
                                    $scope.appstoreLogin.password = '';
                                    $scope.appstoreLoginForm.email.$setPristine();
                                    $scope.appstoreLoginForm.password.$setPristine();
                                    $('#inputAppstoreLoginEmail').focus();
                                } else {
                                    console.error(error);
                                    $scope.appstoreLogin.error.generic = 'Please retry later';
                                }
                            } else {
                                console.error(error);
                            }

                            return;
                        }

                        // check subscription right away after login
                        $scope.$parent.getSubscription();

                        fetchAppstoreConfig();
                    });
                });
            }

            if (!$scope.appstoreLogin.register) return login();

            AppStore.register($scope.appstoreLogin.email, $scope.appstoreLogin.password, function (error) {
                if (error) {
                    $scope.appstoreLogin.busy = false;

                    if (error.statusCode === 409) {
                        $scope.appstoreLogin.error.email = 'An account with this email already exists';
                        $scope.appstoreLogin.password = '';
                        $scope.appstoreLoginForm.email.$setPristine();
                        $scope.appstoreLoginForm.password.$setPristine();
                        $('#inputAppstoreLoginEmail').focus();
                    } else {
                        console.error(error);
                        $scope.appstoreLogin.error.generic = 'Please retry later';
                    }

                    return;
                }

                login();
            });
        }
    };

    function getAppList(callback) {
        AppStore.getApps(function (error, apps) {
            if (error) return callback(error);

            // ensure we have a tags property for further use
            apps.forEach(function (app) {
                if (!app.manifest.tags) app.manifest.tags = [];
            });

            return callback(null, apps);
        });
    }

    // TODO does not support testing apps in search
    $scope.search = function () {
        if (!$scope.searchString) return $scope.showCategory(null, $scope.cachedCategory);

        $scope.category = '';

        AppStore.getAppsFast(function (error, apps) {
            if (error) return $timeout($scope.search, 1000);

            var token = $scope.searchString.toUpperCase();

            $scope.apps = apps.filter(function (app) {
                if (app.manifest.id.toUpperCase().indexOf(token) !== -1) return true;
                if (app.manifest.title.toUpperCase().indexOf(token) !== -1) return true;
                if (app.manifest.tagline.toUpperCase().indexOf(token) !== -1) return true;
                if (app.manifest.tags.join().toUpperCase().indexOf(token) !== -1) return true;
                if (app.manifest.description.toUpperCase().indexOf(token) !== -1) return true;
                return false;
            });
        });
    };

    $scope.showCategory = function (event, category) {
        if (!event) $scope.category = category;
        else $scope.category = event.target.getAttribute('category');

        $scope.cachedCategory = $scope.category;

        $scope.ready = false;

        AppStore.getAppsFast(function (error, apps) {
            if (error) return $timeout($scope.showCategory.bind(null, event), 1000);

            if (!$scope.category) {
                $scope.apps = apps;
            } else {
                $scope.apps = apps.filter(function (app) {
                    return app.manifest.tags.some(function (tag) { return $scope.category === tag; });
                });
            }

            $scope.ready = true;
        });
    };

    document.getElementById('appInstallCertificateFileInput').onchange = function (event) {
        $scope.$apply(function () {
            $scope.appInstall.certificateFile = null;
            $scope.appInstall.certificateFileName = event.target.files[0].name;

            var reader = new FileReader();
            reader.onload = function (result) {
                if (!result.target || !result.target.result) return console.error('Unable to read local file');
                $scope.appInstall.certificateFile = result.target.result;
            };
            reader.readAsText(event.target.files[0]);
        });
    };

    document.getElementById('appInstallKeyFileInput').onchange = function (event) {
        $scope.$apply(function () {
            $scope.appInstall.keyFile = null;
            $scope.appInstall.keyFileName = event.target.files[0].name;

            var reader = new FileReader();
            reader.onload = function (result) {
                if (!result.target || !result.target.result) return console.error('Unable to read local file');
                $scope.appInstall.keyFile = result.target.result;
            };
            reader.readAsText(event.target.files[0]);
        });
    };

    $scope.showAppNotFound = function (appId, version) {
        $scope.appNotFound.appId = appId;
        $scope.appNotFound.version = version;

        $('#appNotFoundModal').modal('show');
    };

    $scope.gotoApp = function (app) {
        $location.path('/appstore/' + app.manifest.id, false).search({ version : app.manifest.version });
    };

    function hashChangeListener() {
        // event listener is called from DOM not angular, need to use $apply
        $scope.$apply(function () {
            var appId = $location.path().slice('/appstore/'.length);
            var version = $location.search().version;

            if (appId) {
                if (version) {
                    AppStore.getAppByIdAndVersion(appId, version, function (error, result) {
                        if (error) {
                            $scope.showAppNotFound(appId, version);
                            console.error(error);
                            return;
                        }

                        $scope.appInstall.show(result);
                    });
                } else {
                    var found = $scope.apps.filter(function (app) {
                        return (app.id === appId) && (version ? version === app.manifest.version : true);
                    });

                    if (found.length) {
                        $scope.appInstall.show(found[0]);
                    } else {
                        $scope.showAppNotFound(appId, null);
                    }
                }
            } else {
                $scope.appInstall.reset();
            }
        });
    }

    function fetchUsers() {
        Client.getUsers(function (error, users) {
            if (error) {
                console.error(error);
                return $timeout(fetchUsers, 5000);
            }

            $scope.users = users;
        });
    }

    function fetchGroups() {
        Client.getGroups(function (error, groups) {
            if (error) {
                console.error(error);
                return $timeout(fetchUsers, 5000);
            }

            $scope.groups = groups;
        });
    }

    function fetchDnsConfig() {
        Client.getDnsConfig(function (error, result) {
            if (error) {
                console.error(error);
                return $timeout(fetchDnsConfig, 5000);
            }

            $scope.dnsConfig = result;
        });
    }

    function fetchAppstoreConfig(callback) {
        callback = callback || function (error) { if (error) console.error(error); };

        // caas always has a valid appstore account
        if ($scope.config.provider === 'caas') {
            $scope.validAppstoreAccount = true;
            return callback();
        }

        Client.getAppstoreConfig(function (error, result) {
            if (error) return callback(error);

            if (!result.token || !result.cloudronId) return callback();

            $scope.appstoreConfig = result;

            AppStore.getCloudronDetails(result, function (error) {
                if (error) return callback(error);

                $scope.validAppstoreAccount = true;

                // clear busy state when a login/signup was performed
                $scope.appstoreLogin.busy = false;

                callback();
            });
        });
    }

    function getMailConfig() {
        Client.getMailConfig(function (error, mailConfig) {
            if (error) return console.error(error);

            $scope.mailConfig = mailConfig;
        });
    }

    function init() {
        $scope.ready = false;

        getAppList(function (error, apps) {
            if (error) {
                console.error(error);
                return $timeout(init, 1000);
            }

            $scope.apps = apps;

            // show install app dialog immediately if an app id was passed in the query
            // hashChangeListener calls $apply, so make sure we don't double digest here
            setTimeout(hashChangeListener, 1);

            fetchUsers();
            fetchGroups();
            fetchDnsConfig();
            getMailConfig();

            fetchAppstoreConfig(function (error) {
                if (error) console.error(error);
                $scope.ready = true;

                setTimeout(function () { $('#appstoreSearch').focus(); }, 1000);
            });
        });
    }

    Client.onReady(init);

    $('#appInstallModal').on('hide.bs.modal', function () {
        $location.path('/appstore', false).search({ version: undefined });
    });

    window.addEventListener('hashchange', hashChangeListener);

    $scope.$on('$destroy', function handler() {
        window.removeEventListener('hashchange', hashChangeListener);
    });

    // setup all the dialog focus handling
    ['appInstallModal', 'feedbackModal'].forEach(function (id) {
        $('#' + id).on('shown.bs.modal', function () {
            $(this).find("[autofocus]:first").focus();
        });
    });

    // autofocus if appstore login is shown
    $scope.$watch('validAppstoreAccount', function (newValue, oldValue) {
        if (!newValue) setTimeout(function () { $('[name=appstoreLoginForm]').find('[autofocus]:first').focus(); }, 1000);
    });

    $('.modal-backdrop').remove();
}]);
