'use strict';


angular.module('Application').controller('AppsController', ['$scope', '$location', '$timeout', 'Client', 'ngTld', 'AppStore', function ($scope, $location, $timeout, Client, ngTld, AppStore) {
    $scope.HOST_PORT_MIN = 1024;
    $scope.HOST_PORT_MAX = 65535;
    $scope.installedApps = Client.getInstalledApps();
    $scope.config = Client.getConfig();
    $scope.user = Client.getUserInfo();
    $scope.dnsConfig = {};
    $scope.groups = [];
    $scope.users = [];
    $scope.mailConfig = {};
    $scope.backupConfig = {};

    $scope.appConfigure = {
        busy: false,
        error: {},
        app: {},
        location: '',
        usingAltDomain: false,
        advancedVisible: false,
        portBindings: {},
        portBindingsEnabled: {},
        portBindingsInfo: {},
        robotsTxt: '',
        certificateFile: null,
        certificateFileName: '',
        keyFile: null,
        keyFileName: '',
        memoryLimit: 0,
        memoryTicks: [],

        accessRestrictionOption: 'any',
        accessRestriction: { users: [], groups: [] },
        xFrameOptions: '',
        customAuth: false,

        isAccessRestrictionValid: function () {
            var tmp = $scope.appConfigure.accessRestriction;
            return !!(tmp.users.length || tmp.groups.length);
        },

        isAltDomainValid: function () {
            return ngTld.isValid($scope.appConfigure.location);
        },

        isAltDomainSubdomain: function () {
            return ngTld.isSubdomain($scope.appConfigure.location);
        },

        isAltDomainNaked: function () {
            return ngTld.isNakedDomain($scope.appConfigure.location);
        }
    };

    $scope.appUninstall = {
        busy: false,
        error: {},
        app: {},
        password: ''
    };

    $scope.appRestore = {
        busy: false,
        busyFetching: false,
        error: {},
        app: {},
        password: '',
        backups: [ ],
        selectedBackup: null,

        selectBackup: function (backup) {
            $scope.appRestore.selectedBackup = backup;
        },

        show: function (app) {
            $scope.reset();

            $scope.appRestore.app = app;
            $scope.appRestore.busyFetching = true;

            $('#appRestoreModal').modal('show');

            Client.getAppBackups(app.id, function (error, backups) {
                if (error) {
                    Client.error(error);
                } else {
                    $scope.appRestore.backups = backups;
                    if (backups.length) $scope.appRestore.selectedBackup = backups[0]; // pre-select first backup
                    $scope.appRestore.busyFetching = false;
                }
            });

            return false; // prevent propagation and default
        },

        submit: function () {
            $scope.appRestore.busy = true;
            $scope.appRestore.error.password = null;

            Client.restoreApp($scope.appRestore.app.id, $scope.appRestore.selectedBackup.id, $scope.appRestore.password, function (error) {
                if (error && error.statusCode === 403) {
                    $scope.appRestore.password = '';
                    $scope.appRestore.error.password = true;
                    $scope.appRestoreForm.password.$setPristine();
                    $('#appRestorePasswordInput').focus();
                } else if (error) {
                    Client.error(error);
                } else {
                    $('#appRestoreModal').modal('hide');
                }

                $scope.appRestore.busy = false;
            });
        }
    };

    $scope.appInfo = {
        app: {},
        message: ''
    };

    $scope.appError = {
        app: {}
    };

    $scope.appUpdate = {
        busy: false,
        error: {},
        app: {},
        manifest: {},
        portBindings: {}
    };

    $scope.reset = function () {
        // close all dialogs
        $('#appErrorModal').modal('hide');
        $('#appConfigureModal').modal('hide');
        $('#appRestoreModal').modal('hide');
        $('#appUpdateModal').modal('hide');
        $('#appInfoModal').modal('hide');
        $('#appUninstallModal').modal('hide');

        // reset configure dialog
        $scope.appConfigure.error = {};
        $scope.appConfigure.app = {};
        $scope.appConfigure.location = '';
        $scope.appConfigure.advancedVisible = false;
        $scope.appConfigure.usingAltDomain = false;
        $scope.appConfigure.portBindings = {};          // This is the actual model holding the env:port pair
        $scope.appConfigure.portBindingsEnabled = {};   // This is the actual model holding the enabled/disabled flag
        $scope.appConfigure.certificateFile = null;
        $scope.appConfigure.certificateFileName = '';
        $scope.appConfigure.keyFile = null;
        $scope.appConfigure.keyFileName = '';
        $scope.appConfigure.memoryLimit = 0;
        $scope.appConfigure.memoryTicks = [];
        $scope.appConfigure.accessRestrictionOption = 'any';
        $scope.appConfigure.accessRestriction = { users: [], groups: [] };
        $scope.appConfigure.xFrameOptions = '';
        $scope.appConfigure.customAuth = false;
        $scope.appConfigure.robotsTxt = '';
        $scope.appConfigure.enableBackup = true;

        $scope.appConfigureForm.$setPristine();
        $scope.appConfigureForm.$setUntouched();

        // reset uninstall dialog
        $scope.appUninstall.app = {};
        $scope.appUninstall.error = {};
        $scope.appUninstall.password = '';

        $scope.appUninstallForm.$setPristine();
        $scope.appUninstallForm.$setUntouched();

        // reset update dialog
        $scope.appUpdate.error = {};
        $scope.appUpdate.app = {};
        $scope.appUpdate.manifest = {};

        // reset restore dialog
        $scope.appRestore.error = {};
        $scope.appRestore.app = {};
        $scope.appRestore.password = '';
        $scope.appRestore.selectedBackup = null;
        $scope.appRestore.backups = [];

        $scope.appRestoreForm.$setPristine();
        $scope.appRestoreForm.$setUntouched();
    };

    document.getElementById('appConfigureCertificateFileInput').onchange = function (event) {
        $scope.$apply(function () {
            $scope.appConfigure.certificateFile = null;
            $scope.appConfigure.certificateFileName = event.target.files[0].name;

            var reader = new FileReader();
            reader.onload = function (result) {
                if (!result.target || !result.target.result) return console.error('Unable to read local file');
                $scope.appConfigure.certificateFile = result.target.result;
            };
            reader.readAsText(event.target.files[0]);
        });
    };

    document.getElementById('appConfigureKeyFileInput').onchange = function (event) {
        $scope.$apply(function () {
            $scope.appConfigure.keyFile = null;
            $scope.appConfigure.keyFileName = event.target.files[0].name;

            var reader = new FileReader();
            reader.onload = function (result) {
                if (!result.target || !result.target.result) return console.error('Unable to read local file');
                $scope.appConfigure.keyFile = result.target.result;
            };
            reader.readAsText(event.target.files[0]);
        });
    };

    $scope.useAltDomain = function (use) {
        $scope.appConfigure.usingAltDomain = use;

        if (use) {
            $scope.appConfigure.location = '';
        } else {
            $scope.appConfigure.location = $scope.appConfigure.app.location;
        }
    };

    $scope.showConfigure = function (app) {
        $scope.reset();

        // fill relevant info from the app
        $scope.appConfigure.app = app;
        $scope.appConfigure.location = app.altDomain || app.location;
        $scope.appConfigure.usingAltDomain = !!app.altDomain;
        $scope.appConfigure.portBindingsInfo = app.manifest.tcpPorts || {}; // Portbinding map only for information
        $scope. Option = app.accessRestriction ? 'groups' : 'any';
        $scope.appConfigure.memoryLimit = app.memoryLimit || app.manifest.memoryLimit || (256 * 1024 * 1024);
        $scope.appConfigure.xFrameOptions = app.xFrameOptions.indexOf('ALLOW-FROM') === 0 ? app.xFrameOptions.split(' ')[1] : '';
        $scope.appConfigure.customAuth = !(app.manifest.addons['ldap'] || app.manifest.addons['oauth']);
        $scope.appConfigure.robotsTxt = app.robotsTxt;
        $scope.appConfigure.enableBackup = app.enableBackup;

        // create ticks starting from manifest memory limit. the memory limit here is currently split into ram+swap (and thus *2 below)
        // TODO: the *2 will overallocate since 4GB is max swap that cloudron itself allocates
        $scope.appConfigure.memoryTicks = [ ];
        var npow2 = Math.pow(2, Math.ceil(Math.log($scope.config.memory)/Math.log(2)));
        for (var i = 256; i <= (npow2*2/1024/1024); i *= 2) {
            if (i >= (app.manifest.memoryLimit/1024/1024 || 0)) $scope.appConfigure.memoryTicks.push(i * 1024 * 1024);
        }
        if (app.manifest.memoryLimit && $scope.appConfigure.memoryTicks[0] !== app.manifest.memoryLimit) {
            $scope.appConfigure.memoryTicks.unshift(app.manifest.memoryLimit);
        }

        $scope.appConfigure.accessRestrictionOption = app.accessRestriction ? 'groups' : 'any';
        $scope.appConfigure.accessRestriction = { users: [], groups: [] };

        if (app.accessRestriction) {
            var userSet = { };
            app.accessRestriction.users.forEach(function (uid) { userSet[uid] = true; });
            $scope.users.forEach(function (u) { if (userSet[u.id] === true) $scope.appConfigure.accessRestriction.users.push(u); });

            var groupSet = { };
            app.accessRestriction.groups.forEach(function (gid) { groupSet[gid] = true; });
            $scope.groups.forEach(function (g) { if (groupSet[g.id] === true) $scope.appConfigure.accessRestriction.groups.push(g); });
        }

        // fill the portBinding structures. There might be holes in the app.portBindings, which signalizes a disabled port
        for (var env in $scope.appConfigure.portBindingsInfo) {
            if (app.portBindings && app.portBindings[env]) {
                $scope.appConfigure.portBindings[env] = app.portBindings[env];
                $scope.appConfigure.portBindingsEnabled[env] = true;
            } else {
                $scope.appConfigure.portBindings[env] = $scope.appConfigure.portBindingsInfo[env].defaultValue || 0;
                $scope.appConfigure.portBindingsEnabled[env] = false;
            }
        }

        $('#appConfigureModal').modal('show');
    };

    $scope.doConfigure = function () {
        $scope.appConfigure.busy = true;
        $scope.appConfigure.error.other = null;
        $scope.appConfigure.error.location = null;
        $scope.appConfigure.error.xFrameOptions = null;

        // only use enabled ports from portBindings
        var finalPortBindings = {};
        for (var env in $scope.appConfigure.portBindings) {
            if ($scope.appConfigure.portBindingsEnabled[env]) {
                finalPortBindings[env] = $scope.appConfigure.portBindings[env];
            }
        }

        var finalAccessRestriction = null;
        if ($scope.appConfigure.accessRestrictionOption === 'groups') {
            finalAccessRestriction = { users: [], groups: [] };
            finalAccessRestriction.users = $scope.appConfigure.accessRestriction.users.map(function (u) { return u.id; });
            finalAccessRestriction.groups = $scope.appConfigure.accessRestriction.groups.map(function (g) { return g.id; });
        }

        var data = {
            location:  $scope.appConfigure.usingAltDomain ? $scope.appConfigure.app.location : $scope.appConfigure.location,
            altDomain: $scope.appConfigure.usingAltDomain ? $scope.appConfigure.location : null,
            portBindings: finalPortBindings,
            accessRestriction: finalAccessRestriction,
            cert: $scope.appConfigure.certificateFile,
            key: $scope.appConfigure.keyFile,
            xFrameOptions: $scope.appConfigure.xFrameOptions ? ('ALLOW-FROM ' + $scope.appConfigure.xFrameOptions) : 'SAMEORIGIN',
            memoryLimit: $scope.appConfigure.memoryLimit === $scope.appConfigure.memoryTicks[0] ? 0 : $scope.appConfigure.memoryLimit,
            robotsTxt: $scope.appConfigure.robotsTxt,
            enableBackup: $scope.appConfigure.enableBackup
        };

        Client.configureApp($scope.appConfigure.app.id, data, function (error) {
            if (error) {
                if (error.statusCode === 409 && (error.message.indexOf('is reserved') !== -1 || error.message.indexOf('is already in use') !== -1)) {
                    $scope.appConfigure.error.port = error.message;
                } else if (error.statusCode === 409) {
                    $scope.appConfigure.error.location = 'This name is already taken.';
                    $scope.appConfigureForm.location.$setPristine();
                    $('#appConfigureLocationInput').focus();
                } else if (error.statusCode === 400 && error.message.indexOf('cert') !== -1 ) {
                    $scope.appConfigure.error.cert = error.message;
                    $scope.appConfigure.certificateFileName = '';
                    $scope.appConfigure.certificateFile = null;
                    $scope.appConfigure.keyFileName = '';
                    $scope.appConfigure.keyFile = null;
                } else if (error.statusCode === 400 && error.message.indexOf('xFrameOptions') !== -1 ) {
                    $scope.appConfigure.error.xFrameOptions = error.message;
                    $scope.appConfigureForm.xFrameOptions.$setPristine();
                    $('#appConfigureXFrameOptionsInput').focus();
                } else {
                    $scope.appConfigure.error.other = error.message;
                }

                $scope.appConfigure.busy = false;
                return;
            }

            $scope.appConfigure.busy = false;

            $('#appConfigureModal').modal('hide');

            $scope.reset();
        });
    };

    $scope.showInformation = function (app) {
        $scope.reset();

        $scope.appInfo.app = app;
        $scope.appInfo.message = app.manifest.postInstallMessage;

        $('#appInfoModal').modal('show');

        return false; // prevent propagation and default
    };

    $scope.showError = function (app) {
        $scope.reset();

        $scope.appError.app = app;

        $('#appErrorModal').modal('show');

        return false; // prevent propagation and default
    };

    $scope.showUninstall = function (app) {
        $scope.reset();

        $scope.appUninstall.app = app;

        $('#appUninstallModal').modal('show');
    };

    $scope.doUninstall = function () {
        $scope.appUninstall.busy = true;
        $scope.appUninstall.error.password = null;

        Client.uninstallApp($scope.appUninstall.app.id, $scope.appUninstall.password, function (error) {
            if (error && error.statusCode === 403) {
                $scope.appUninstall.password = '';
                $scope.appUninstall.error.password = true;
                $scope.appUninstallForm.password.$setPristine();
                $('#appUninstallPasswordInput').focus();
            } else if (error && error.statusCode === 402) { // unpurchase failed
                Client.error('Relogin to Cloudron App Store');
            } else if (error) {
                Client.error(error);
            } else {
                $('#appUninstallModal').modal('hide');
                $scope.reset();
            }

            $scope.appUninstall.busy = false;
        });
    };

    $scope.showUpdate = function (app, updateManifest) {
        if (!updateManifest.dockerImage) {
            $('#setupSubscriptionModal').modal('show');
            return;
        }

        $scope.reset();

        $scope.appUpdate.app = app;
        $scope.appUpdate.manifest = angular.copy(updateManifest);

        $('#appUpdateModal').modal('show');
    };

    $scope.doUpdate = function () {
        $scope.appUpdate.busy = true;

        Client.updateApp($scope.appUpdate.app.id, $scope.appUpdate.manifest, function (error) {
            if (error) {
                Client.error(error);
            } else {
                $scope.appUpdate.app = {};
                $('#appUpdateModal').modal('hide');
            }

            $scope.appUpdate.busy = false;
        });
    };

    $scope.renderAccessRestrictionUser = function (userId) {
        var user = $scope.users.filter(function (u) { return u.id === userId; })[0];

        // user not found
        if (!user) return userId;

        return user.username ? user.username : user.email;
    };

    $scope.cancel = function () {
        window.history.back();
    };

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

    function getMailConfig() {
        Client.getMailConfig(function (error, mailConfig) {
            if (error) return console.error(error);

            $scope.mailConfig = mailConfig;
        });
    }

    function getBackupConfig() {
        Client.getBackupConfig(function (error, backupConfig) {
            if (error) return console.error(error);

            $scope.backupConfig = backupConfig;
        });
    }

    Client.onReady(function () {
        Client.refreshUserInfo(function (error) {
            if (error) return console.error(error);

            if ($scope.user.admin) {
                fetchUsers();
                fetchGroups();
                fetchDnsConfig();
                getMailConfig();
                getBackupConfig();
            }
        });
    });

    // setup all the dialog focus handling
    ['appConfigureModal', 'appUninstallModal', 'appUpdateModal', 'appRestoreModal'].forEach(function (id) {
        $('#' + id).on('shown.bs.modal', function () {
            $(this).find("[autofocus]:first").focus();
        });
    });

    $('.modal-backdrop').remove();
}]);
